/**
 * Persistent Memory Extension
 *
 * Gives pi a personal memory bank that persists across sessions.
 *
 * On session start: loads activeProjects.md, dailyContext.md, and
 * all knowledge files. Archives dailyContext.md when the date rolls over.
 *
 * Injection is configurable via /memory config or ~/.pi/memory3/config.json.
 * Each content type has an independent frequency:
 *   activeProjects: "every-turn" (default) | "first-turn" | "off"
 *   dailyContext:   "every-turn" (default) | "first-turn" | "off"
 *   knowledge:      "every-turn" (default) | "first-turn" | "off"
 *   history:        "every-turn" (default) | "first-turn" | "off"
 *
 * Provides tools for the agent to read/update/search memory bank files
 * and a /memory command to inspect current state.
 *
 * Memory bank location: ~/.pi/memory3/
 *   core/activeProjects.md  — active work and priorities
 *   core/dailyContext.md    — today's work, decisions, carry-forward
 *   knowledge/              — reference docs
 *   history/daily/          — archived dailyContext by date
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import * as fs from "node:fs";
import * as path from "node:path";
import { acquireBankLock } from "./locks.js";
import { ERR_OUTSIDE_BANK, isMarkdownPath, resolveBankPath } from "./paths.js";
import { ServedVersions } from "./versions.js";
import {
	MAX_ACTIVE_PROJECTS_LINES, MAX_CORE_FILE_BUDGET_CHARS, MAX_DAILY_CONTEXT_LINES, MAX_INJECTED_CORE_CHARS, MAX_INJECTED_CORE_LINES,
	MAX_INJECTED_FILE_CHARS, MAX_INJECTED_FILE_LINES, MAX_INJECTED_FILES, MAX_INJECTED_SECTION_CHARS, MAX_INJECTED_SECTION_LINES,
	MAX_READ_BYTES, MAX_READ_LINES, capFile, capLines, coreLabel, cropped, injectCore, overCap, splitSections,
} from "./caps.js";
import {
	CONFIG_PATH, CORE_DIR, HISTORY_DIR, KNOWLEDGE_DIR, MEMORY_ROOT, patchConfigFile, readConfigFile, readCurrentFile, readIfExists, writeBankFile,
} from "./bank.js";
import { dayString, fileDay, today } from "./calendar.js";
import { archiveDailyContext, scaffold, type LifecycleDeps } from "./lifecycle.js";
import { findSection } from "./sections.js";
import {
	LOG_CAP_BYTES, LOG_PROMPT_CHARS, logEvent, logFilePath, logStatus, loadLogConfig, saveLogConfig, sessionId, shortHash, startSession,
	summarizeLog,
} from "./usage-log.js";
import { TopicContext, selectContext } from "./retrieval.js";
import { archiveReason, auditCarryForward } from "./maintenance.js";
import { describeScope, detectScope, scopeFolders, scopeLabel, scopeReason } from "./scope.js";
import { RevisionStore, internalPath } from "./revisions.js";
import { changeSetting, parseSettings, settingsLines, SETTING_SPECS, type RuntimeSettings } from "./settings.js";

import { MemoryIndex, MAX_WITHHELD_SHARE, admitsToContext, contentTerms, extractTitle, topEligibleScore, withheldShare, walkMarkdownFiles, scanMarkdownFiles, INDEX_MAX_DEPTH, type SearchResult } from "./search.js";
/** Below this, truncating a file costs more in notice than it saves in text. */
/** What `/memory doctor` holds a core file to, in the unit a prompt pays. */

/** Knowledge/history files allowed into one prompt, best-matching first. */

/**
 * Shipped with every injected record, because BM25 has no time term.
 *
 * A bank accumulates statements, and a well-aliased old decision about a topic
 * outscores the hastily written revision of it — tested, not feared: a blue
 * background decided Monday beat Tuesday's green one 115 to 52. Nothing here can
 * tell which statement still stands, but the model can, given the one signal the
 * scorer lacks.
 */
const RECENCY_NOTE =
	"Each file below is a point-in-time record; `updated` is when it last changed. If two disagree, follow the most recent and say which one you followed.\n";

/** When a bank file last changed, as a date. The only ordering signal a record has. */
function fileDate(relPath: string): string {
	try {
		return dayString(new Date(fs.statSync(path.resolve(MEMORY_ROOT, relPath)).mtimeMs));
	} catch {
		return "date unknown";
	}
}

/** Section budgets the agent is told to keep, stated here so doctor can check them. */

/** Lines returned by one memory_read call, a guard rail rather than a budget. */

// ── Search Index ─────────────────────────────────────────────────

const memoryIndex = new MemoryIndex(MEMORY_ROOT);

// ── Injection Config + State ─────────────────────────────────────────

type Frequency = "every-turn" | "first-turn" | "off";
const VALID_FREQUENCIES: Frequency[] = ["every-turn", "first-turn", "off"];

export interface InjectionConfig {
	activeProjects: Frequency;
	dailyContext: Frequency;
	knowledge: Frequency;
	history: Frequency;
}

const CONFIG_KEYS: (keyof InjectionConfig)[] = ["activeProjects", "dailyContext", "knowledge", "history"];

export const DEFAULT_CONFIG: InjectionConfig = {
	activeProjects: "every-turn",
	dailyContext: "every-turn",
	knowledge: "every-turn",
	history: "every-turn",
};

export function loadConfig(): InjectionConfig {
	try {
		const raw = readConfigFile();
		const inj = (raw.injection ?? {}) as Record<string, unknown>;
		const result = { ...DEFAULT_CONFIG };
		for (const key of CONFIG_KEYS) {
			if (VALID_FREQUENCIES.includes(inj[key] as Frequency)) {
				result[key] = inj[key] as Frequency;
			}
		}
		return result;
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/**
 * Should each turn report what it injected?
 *
 * Off unless `~/.pi/memory3/config.json` carries `"debug": true`. Injection runs
 * on every prompt and is otherwise invisible, so this is opt-in: a notification
 * per turn is noise until you specifically want it.
 */
export function loadDebug(): boolean {
	return readConfigFile().debug === true;
}

export function saveDebug(on: boolean): void {
	patchConfigFile({ debug: on });
}

export function saveConfig(config: InjectionConfig): void {
	patchConfigFile({ injection: { ...config } });
}

// ── Usage log ────────────────────────────────────────────────────
// The monthly JSONL log, its config switches and `summarizeLog` live in usage-log.ts.


/** Determine if a content type should be injected this turn */
export function shouldInject(setting: Frequency, alreadyInjected: boolean): boolean {
	if (setting === "off") return false;
	if (setting === "first-turn" && alreadyInjected) return false;
	return true;
}

function loadSettings(): RuntimeSettings { return parseSettings(readConfigFile()); }
function saveSettings(next: RuntimeSettings): void { patchConfigFile({ ...next }); }
let settings = loadSettings();
let activeScope = detectScope(settings.scope, process.cwd());
const revisions = new RevisionStore(MEMORY_ROOT, writeBankFile, acquireWriteLock);
// Rollover writes through the same recovery-aware writer and lock as the tools.
const lifecycleDeps: LifecycleDeps = {
	managedWrite: (file, content) => revisions.write(file, content, settings.revisions),
	acquireLock: acquireWriteLock,
};
const topic = new TopicContext();
let config: InjectionConfig = loadConfig();
let debugMode = loadDebug();
let logCfg = loadLogConfig();
const injectedTypes: Record<keyof InjectionConfig, boolean> = {
	activeProjects: false,
	dailyContext: false,
	knowledge: false,
	history: false,
};

/**
 * What this session has already been shown, in the form it was shown.
 *
 * 39 % of injected bytes were something the previous prompt had already paid for
 * (docs/injection-cost-design.md §2.1), and the model does not need the same core text
 * or the same file twice — it needs to know where the copy it already has is. So an
 * unchanged section comes back as a pointer instead of a body.
 *
 * Cleared whenever the earlier copy might no longer be in the model's context: a new
 * session, a compaction, and navigation in the session tree. A pointer to text that
 * was dropped is worse than the bytes it saved, which is the whole risk of this map.
 */
const shownText = new Map<string, string>();

/** Below this, replacing a section with a pointer to it costs more than it saves. */
const MIN_DELTA_SAVING_CHARS = 200;

/**
 * The body, or a pointer to it when this session was already shown exactly this text.
 * Compared as a whole, not by digest: a file that changed anywhere is shown again,
 * because a pointer to a stale copy is a wrong fact with a citation.
 *
 * `pending` is the state of the block being built and is merged into `shownText` only
 * when the block is finished, so a throw that injects nothing also remembers nothing.
 */
function deltaSection(
	text: string,
	source: string,
	pending: Map<string, string>,
): { body: string; skipped: boolean } {
	const pointer = `\`${source}\` unchanged since earlier in this session — it is above in this conversation; memory_read "${source}" for it`;
	const previous = pending.has(source) ? pending.get(source) : shownText.get(source);
	pending.set(source, text);
	// A pointer longer than the thing it replaces is not a saving, and the small print
	// would be paid on every prompt forever. 200 characters is the round point below
	// which no section is worth an indirection: at that size the body is a few tokens.
	if (previous === text && text.length - pointer.length >= MIN_DELTA_SAVING_CHARS) {
		return { body: pointer, skipped: true };
	}
	return { body: text, skipped: false };
}

/** Extract the date from dailyContext.md's "## Date" or first line */

/** Archive yesterday's dailyContext and start fresh */

/**
 * Health of the bank itself, for `/memory doctor`.
 *
 * `/memory` answers "is the extension loaded?" in six glances at counts. This
 * answers "is it actually working?", which needs judgement calls that would
 * bloat that output: is the daily file still rollover-readable, is anything so
 * large it gets truncated, has the index drifted from disk, has knowledge been
 * written at all recently. Read-only — a doctor that writes is a hazard.
 */
function doctorReport(): { header: string; lines: string[]; warnings: number } {
	const lines: string[] = [];
	let warnings = 0;
	const ok = (msg: string) => lines.push(`  ok    ${msg}`);
	const warn = (msg: string) => { warnings++; lines.push(`  warn  ${msg}`); };
	const note = (msg: string) => lines.push(`  note  ${msg}`);
	const daysAgo = (ms: number) => Math.floor((Date.now() - ms) / 86_400_000);
	memoryIndex.reconcile();
	note(describeScope(activeScope));
	if (activeScope.mode !== "off" && !activeScope.name) warn("scope is unresolved — project folders are not injected; set scope.name or choose scope.mode off");
	for (const line of scopeFolders(scanMarkdownFiles(KNOWLEDGE_DIR, MEMORY_ROOT).map((f) => f.id), activeScope).slice(0, 10)) note(line);
	try {
		const history = revisions.list(null, settings.revisions);
		note(`revision history: ${settings.revisions.enabled ? "on" : "off"}, ${history.revisions.length} snapshot(s), ${history.bytes.toLocaleString()} bytes; /memory revisions`);
		if (history.errors.length) warn(`revision store needs inspection: ${history.errors[0]}`);
		if (history.bytes > settings.revisions.maxTotalBytes) warn("revision store exceeds the configured byte budget; the next managed write prunes old recovery copies, not notes");
	} catch (error) { warn(`revision store: ${String(error)}`); }

	// 1. config.json — loadConfig() swallows a broken file, so say so here
	if (fs.existsSync(CONFIG_PATH)) {
		try {
			JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
			ok(`config.json parses`);
		} catch {
			warn("config.json is not valid JSON — defaults are in use, your settings are ignored");
		}
	} else {
		note("no config.json — all content types inject every turn");
	}

	// 2. dailyContext.md — the file rollover depends on being able to date
	const dailyPath = path.join(CORE_DIR, "dailyContext.md");
	const daily = readIfExists(dailyPath);
	if (daily === null) {
		warn("core/dailyContext.md is missing — run a session to scaffold it");
	} else {
		const { date, source } = fileDay(daily, dailyPath);
		const dailyLines = daily.split("\n").length;
		const dailyChars = daily.length;
		if (source === "mtime") {
			warn(`dailyContext.md has no \`## YYYY-MM-DD\` heading (dated ${date} by mtime) — rollover is guessing`);
		} else if (date > today()) {
			warn(`dailyContext.md is dated ${date}, a future day (today is ${today()}) — a UTC-dated heading? rollover leaves it alone`);
		} else if (date !== today()) {
			warn(`dailyContext.md is dated ${date}, not ${today()} — rollover will archive it next session`);
		} else {
			ok(`dailyContext.md is dated today`);
		}
		if (dailyLines > MAX_DAILY_CONTEXT_LINES || dailyChars > MAX_CORE_FILE_BUDGET_CHARS) {
			const over =
				dailyChars > MAX_CORE_FILE_BUDGET_CHARS
					? `dailyContext.md costs ${dailyChars.toLocaleString()} characters per prompt, over the ${MAX_CORE_FILE_BUDGET_CHARS.toLocaleString()}-character budget`
					: `dailyContext.md is ${dailyLines} lines, over the ${MAX_DAILY_CONTEXT_LINES}-line budget`;
			warn(`${over}${overCap(dailyLines, dailyChars)}`);
		}
	}

	// 3. activeProjects.md budget
	const projects = readIfExists(path.join(CORE_DIR, "activeProjects.md"));
	if (projects === null) {
		warn("core/activeProjects.md is missing");
	} else if (projects.split("\n").length > MAX_ACTIVE_PROJECTS_LINES || projects.length > MAX_CORE_FILE_BUDGET_CHARS) {
		const over =
			projects.length > MAX_CORE_FILE_BUDGET_CHARS
				? `activeProjects.md costs ${projects.length.toLocaleString()} characters per prompt, over the ${MAX_CORE_FILE_BUDGET_CHARS.toLocaleString()}-character budget`
				: `activeProjects.md is ${projects.split("\n").length} lines, over the ${MAX_ACTIVE_PROJECTS_LINES}-line budget`;
		warn(`${over}${overCap(projects.split("\n").length, projects.length)}`);
	} else {
		ok(`activeProjects.md within budget`);
	}

	// 4. knowledge/ — age, size, and whether anything is there at all
	const knowledge = bankMarkdownFiles(KNOWLEDGE_DIR);
	if (knowledge.length === 0) {
		warn("no knowledge files — nothing is being captured yet");
	} else {
		const newest = knowledge.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
		const age = daysAgo(newest.mtimeMs);
		const ageLine = `knowledge: ${knowledge.length} files, last written ${age} day${age === 1 ? "" : "s"} ago (${newest.rel})`;
		if (age > 30) warn(`${ageLine} — the capture loop has been quiet for a month`);
		else ok(ageLine);

		// Both caps bite, and they bite *different* files. 100 lines is 14,000 characters when the
		// lines are long, so the line-only check reported 2 oversized files against the live bank
		// while 7 were being cut — the "lines are not cost" mistake §3.2 was written to fix,
		// re-appearing in the one report that says whether the bank still fits.
		const oversized = knowledge.filter((f) => f.lines > MAX_INJECTED_FILE_LINES || f.chars > MAX_INJECTED_FILE_CHARS);
		for (const f of oversized.sort((a, b) => b.chars - a.chars)) {
			const byLines = f.lines > MAX_INJECTED_FILE_LINES;
			const byChars = f.chars > MAX_INJECTED_FILE_CHARS;
			// `capFile` decides the cut and `withheldShare` decides whether to make one at all —
			// asked here, not estimated from the file's size, so the report cannot describe a rule
			// the injector did not apply.
			const content = readIfExists(path.resolve(MEMORY_ROOT, f.rel)) ?? "";
			const capped = capFile(content);
			if (withheldShare(f.chars, capped.hiddenChars).skipWhole) {
				warn(
					`${f.rel} is ${f.chars.toLocaleString()} characters — ${Math.round(withheldShare(f.chars, capped.hiddenChars).share * 100)} % of it is past the cap, so injection sends its ` +
					`name instead of the file (§3.5). Split it, or trim it under ${MAX_INJECTED_FILE_CHARS.toLocaleString()}`,
				);
			} else if (!capped.cut) {
				note(`${f.rel} is ${f.chars.toLocaleString()} characters — sent whole because the character cut is too small`);
			} else if (byLines && !byChars) {
				warn(`${f.rel} is ${f.lines} lines — injection truncates it at ${MAX_INJECTED_FILE_LINES}`);
			} else {
				warn(`${f.rel} is ${f.chars.toLocaleString()} characters — injection cuts it at the ${MAX_INJECTED_FILE_CHARS.toLocaleString()}-character cap${byLines ? ` and/or the ${MAX_INJECTED_FILE_LINES}-line cap` : ""}`);
			}
		}
		if (oversized.length === 0)
			ok(`every knowledge file fits the ${MAX_INJECTED_FILE_LINES}-line and ${MAX_INJECTED_FILE_CHARS.toLocaleString()}-character injection caps`);

		// 4b. Two records about one topic both get retrieved, and the older, better
		// written one can rank first. Detection only — which statement still stands
		// is a question about the world, not about text.
		const overlaps = overlappingTopics(knowledge.map((f) => f.rel).filter((rel) => !scopeReason(rel, activeScope)));
		for (const pair of overlaps.slice(0, MAX_OVERLAP_WARNINGS)) {
			warn(
				`${shortName(pair.a)} and ${shortName(pair.b)} look like one topic (${fileDate(pair.a)} vs ${fileDate(pair.b)}) — ` +
				"if one replaces the other, merge them: both are retrieved and the older can rank first",
			);
		}
		if (overlaps.length > MAX_OVERLAP_WARNINGS) {
			note(`and ${overlaps.length - MAX_OVERLAP_WARNINGS} more possible topic overlaps`);
		}
		if (overlaps.length === 0 && knowledge.length > 1) ok("no two knowledge files look like the same topic");
	}

	// 5. history/ archives
	const archives = bankMarkdownFiles(HISTORY_DIR);
	if (archives.length === 0) note("no daily archives yet — rollover has not run");
	else ok(`history: ${archives.length} archived days`);
	const outsideWindow = archives.filter((f) => archiveReason(f.rel, settings.maintenance.historyMaxDays)).length;
	note(`archive injection: ${settings.maintenance.historyMaxDays ? `${settings.maintenance.historyMaxDays}-day window; ${outsideWindow} older archives stay searchable but are not injected` : "all ages (maintenance.historyMaxDays = 0)"}`);
	const carry = auditCarryForward(daily ?? "", walkMarkdownFiles(HISTORY_DIR, MEMORY_ROOT).map((f) => ({ path: f.id, content: f.content })), settings.maintenance.carryForwardWarnDays);
	for (const item of carry.slice(0, 5)) warn(`Carried Forward: ${clip(item.item, 100)} — ${item.duplicate ? "duplicate in today's section; " : ""}${item.firstSeen ? `seen in ${item.snapshots} archive(s), earliest ${item.firstSeen} (${item.ageDays} days ago); ` : ""}review manually, not automatically completed`);
	if (carry.length > 5) note(`${carry.length - 5} more carry-forward hygiene findings`);

	// 6. Disk is reconciled before retrieval, including cross-process edits/deletes.
	// Files past the indexer's reach remain diagnostic rather than silently hidden.
	const allFiles = bankMarkdownFiles(MEMORY_ROOT);
	const indexed = memoryIndex.documentCount;
	const belowReach = countMarkdown(MEMORY_ROOT) - allFiles.length;
	if (allFiles.length !== indexed) {
		warn(`index holds ${indexed} documents but the bank has ${allFiles.length} — a concurrent/unreadable file; /memory refresh retries`);
	} else if (belowReach > 0) {
		warn(`${belowReach} .md files sit below the indexer's reach (${INDEX_MAX_DEPTH} directory levels) — they are never searched`);
	} else {
		ok(`index matches the bank (${indexed} documents)`);
	}

	// 6b. a section past the section cap is trimmed on every prompt, and the only sign
	// of that is a marker in the injected block. Say where it comes from.
	for (const rel of ["core/dailyContext.md", "core/activeProjects.md"]) {
		const text = readIfExists(path.join(MEMORY_ROOT, rel));
		if (text === null) continue;
		const fat = splitSections(text)
			.filter((sec) => sec.body.length > MAX_INJECTED_SECTION_CHARS)
			.sort((a2, b2) => b2.body.length - a2.body.length);
		if (fat.length === 0) continue;
		const worst = fat[0];
		const more = fat.length > 1 ? ` (+${fat.length - 1} more)` : "";
		warn(
			`${rel.replace("core/", "")} has a ${worst.body.length.toLocaleString()}-character section ("${worst.name}"), ` +
			`trimmed to ${MAX_INJECTED_SECTION_CHARS.toLocaleString()} in every prompt${more} — finish it, drop it, or move it to knowledge/`,
		);
	}

	// 7. what every-turn injection costs
	const totalChars = allFiles.reduce((n, f) => n + f.chars, 0);
	note(`bank size: ${totalChars.toLocaleString()} characters across ${allFiles.length} files`);
	// These two are injected on every prompt whether or not the topic touches them, so
	// their size — in characters, the unit a prompt is billed in — is the bank's standing
	// cost, and the line budgets in sections 2 and 3 above do not bound it.
	const coreChars =
		(readIfExists(path.join(CORE_DIR, "activeProjects.md"))?.length ?? 0) +
		(readIfExists(path.join(CORE_DIR, "dailyContext.md"))?.length ?? 0);
	note(
		`core injection: ${coreChars.toLocaleString()} characters of every prompt, whatever the topic ` +
		`(cap ${MAX_INJECTED_CORE_CHARS.toLocaleString()} a file, ${MAX_INJECTED_SECTION_CHARS.toLocaleString()} a section)`,
	);

	// 8. whether there is any record of what injection has been doing
	const log = logStatus(logCfg);
	if (!log.enabled) {
		note("usage log is off — /memory log on records prompts and what injection did with them");
	} else if (log.bytes === 0) {
		note(`usage log is on and empty: ${path.relative(MEMORY_ROOT, log.file)}`);
	} else if (log.atCap) {
		warn(`usage log stopped at ${Math.round(log.bytes / 1024)} KB — delete ${path.relative(MEMORY_ROOT, log.file)} to resume`);
	} else {
		ok(`usage log: ${path.relative(MEMORY_ROOT, log.file)}, ${Math.round(log.bytes / 1024)} KB${log.prompts ? "" : ", prompt text redacted"}`);
	}

	return { header: `memory doctor — ${warnings === 0 ? "nothing to flag" : `${warnings} warning${warnings === 1 ? "" : "s"}`}`, lines, warnings };
}

/**
 * Ratio above which two knowledge files are reported as candidates for one topic.
 *
 * Measured rather than picked: asking the index each file's own title, unrelated
 * files scored 0.00-0.03 of the owner's score, a pair sharing only the ordinary
 * word "policy" scored 0.07, a decision rewritten as a second file scored 0.52,
 * and a near-duplicate 1.00. The threshold sits in the empty band between 0.07
 * and 0.52, so it is not a close call — but it is a warning, not a verdict, and
 * nothing here merges or deletes anything.
 */
const TOPIC_OVERLAP_RATIO = 0.35;

/** Pairs of knowledge files competing for the same query, strongest first. */
function overlappingTopics(files: string[]): Array<{ a: string; b: string; ratio: number }> {
	const pairs = new Map<string, { a: string; b: string; ratio: number }>();

	for (const rel of files) {
		const content = readIfExists(path.resolve(MEMORY_ROOT, rel));
		if (!content) continue;
		// The title is where the topic and its aliases live, which is also what a
		// future prompt matches against.
		const hits = memoryIndex.search(extractTitle(content, path.basename(rel)), TOPIC_PROBE_HITS);
		const own = hits.find((h) => h.path === rel)?.score ?? 0;
		if (own <= 0) continue;

		for (const hit of hits) {
			if (hit.path === rel || !hit.path.startsWith("knowledge/")) continue;
			const ratio = hit.score / own;
			if (ratio < TOPIC_OVERLAP_RATIO) continue;
			const [a, b] = [rel, hit.path].sort();
			const key = `${a}|${b}`;
			const best = pairs.get(key);
			if (!best || ratio > best.ratio) pairs.set(key, { a, b, ratio });
		}
	}

	return [...pairs.values()].sort((x, y) => y.ratio - x.ratio);
}

/** How much of the bank a doctor run reads to judge topic overlap. */
const TOPIC_PROBE_HITS = 5;
const MAX_OVERLAP_WARNINGS = 3;

/** Every .md in the tree, however deep — the indexer's own walk is depth-bounded. */
function countMarkdown(dir: string): number {
	return scanMarkdownFiles(dir, MEMORY_ROOT, Number.POSITIVE_INFINITY).length;
}

/** Every .md under `dir` with the few stats the doctor needs. */
function bankMarkdownFiles(dir: string): Array<{ rel: string; lines: number; chars: number; mtimeMs: number }> {
	return walkMarkdownFiles(dir, MEMORY_ROOT).map((doc) => {
		let mtimeMs = 0;
		try {
			mtimeMs = fs.statSync(path.resolve(MEMORY_ROOT, doc.id)).mtimeMs;
		} catch {}
		return {
			rel: doc.id,
			lines: doc.content.split("\n").length,
			chars: doc.content.length,
			mtimeMs,
		};
	});
}

/** Entries one memory_list call returns before it says it stopped. */
const MAX_LIST_ENTRIES = 500;

/**
 * Every path under `dir`, relative to `root`, directories with a trailing slash,
 * sorted.
 *
 * Depth used to stop at 3. That made the answer depend on where the walk began:
 * the same archived day was listed by memory_list("history/daily") and hidden by
 * memory_list(), and a file four levels down was searchable but not listable —
 * which is worse than a limit, because an omission reads as the file being absent.
 * A queue rather than recursion keeps a deep tree off the call stack, and an
 * uncapped walk cannot loop: readdir reports a symlinked directory as a link, not
 * a directory, so it is listed and never descended.
 *
 * What is bounded is size, not shape — a thousand shallow files are 30 KB of tool
 * result either way, so the cap is on entries, and it names what it hid.
 */
function listBank(dir: string, root: string): { entries: string[]; hidden: number } | null {
	let first: fs.Dirent[];
	try {
		first = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return null; // the directory the caller asked for is not there
	}

	const entries: string[] = [];
	const pending: string[] = [];
	const absorb = (at: string, dirents: fs.Dirent[]) => {
		for (const entry of dirents) {
			const full = path.join(at, entry.name);
			if (entry.isDirectory()) pending.push(full);
			entries.push(path.relative(root, full) + (entry.isDirectory() ? "/" : ""));
		}
	};

	absorb(dir, first);
	for (let i = 0; i < pending.length; i++) {
		try {
			absorb(pending[i], fs.readdirSync(pending[i], { withFileTypes: true }));
		} catch {
			// Unreadable subdirectory: skip it rather than fail the whole listing.
		}
	}

	// Filesystem order is not stable across platforms; the agent should not see the
	// same bank differently twice.
	entries.sort();
	const hidden = Math.max(0, entries.length - MAX_LIST_ENTRIES);
	return { entries: entries.slice(0, MAX_LIST_ENTRIES), hidden };
}

/** Extract a markdown section by heading */

/** Scaffold default memory bank files if they don't exist */

// ── Extension ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	scaffold();

	// Build search index on load
	memoryIndex.build();

	// ── Session Start: archive stale dailyContext + rebuild index ──
	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		settings = loadSettings();
		activeScope = detectScope(settings.scope, ctx.cwd ?? process.cwd());
		topic.clear();
		// Scaffold on every session, not only at load. A deleted or emptied core
		// file used to stay missing until Pi restarted, while doctor advised "run a
		// session to scaffold it". Idempotent: scaffold writes only what is absent.
		scaffold();
		debugMode = loadDebug();
		logCfg = loadLogConfig();
		startSession();
		for (const key of CONFIG_KEYS) injectedTypes[key] = false;
		// A new session is a new agent: what the last one was shown is nobody's copy
		// in hand now, and keeping it would block a write for a reason no one can
		// see. Repopulated by the first injection or memory_read.
		served.clear();
		// A new session has no transcript to point at, so no section is "already shown".
		shownText.clear();

		// Rollover rewrites the same daily file as append/update and must use the
		// same lock. Refuse to roll over if a writer owns it; never steal a lock.
		const releaseDaily = await acquireWriteLock(path.join(CORE_DIR, "dailyContext.md"));
		if (!releaseDaily) throw new Error("Daily rollover refused: write lock busy; inspect .write-locks before retrying");
		let archive: Awaited<ReturnType<typeof archiveDailyContext>>;
		try { archive = await archiveDailyContext(lifecycleDeps); } finally { releaseDaily(); }
		if (archive.archived) {
			ctx.ui.notify(`Archived previous dailyContext → ${archive.archivePath}`, "info");
			if (archive.dateSource === "mtime") {
				ctx.ui.notify(
					"dailyContext.md had no `## YYYY-MM-DD` heading — archived by file modification time. " +
					"Keep the date heading so rollover can tell one day from the next.",
					"warning",
				);
			}
		}
		// Rebuild the search index
		const count = memoryIndex.build();
		ctx.ui.notify(`Memory search index: ${count} documents`, "info");
		// One header line per session: what the caps and settings were, so a later log
		// line can be replayed against a fixture bank without guessing the config.
		logEvent(logCfg, {
			t: "session",
			sid: sessionId(),
			docs: count,
			cfg: config,
			caps: {
				files: MAX_INJECTED_FILES,
				lines: MAX_INJECTED_FILE_LINES,
				fileChars: MAX_INJECTED_FILE_CHARS,
				core: MAX_INJECTED_CORE_LINES,
				coreChars: MAX_INJECTED_CORE_CHARS,
				section: { lines: MAX_INJECTED_SECTION_LINES, chars: MAX_INJECTED_SECTION_CHARS },
				// Beyond this share withheld, a file is named and left out instead of cut
				// (§3.5), so a replay needs to know which rule was in force.
				withheld: MAX_WITHHELD_SHARE,
			},
		});
	});

	// ── Bank writes made outside these tools: keep the index in step ──
	//
	// An agent creating a new knowledge file has no copy it was shown, so it reaches
	// for the harness `write` tool instead of memory_update, which reads as update-only.
	// That file used to stay invisible to search until the next session_start: on
	// 2026-10-28, 7 of 9 knowledge files entered the index a session late and two
	// prompts searched for a file already on disk. Watching results covers what
	// guidance cannot, and costs one string compare per tool call.
	//
	// Bash, patch tools and other processes do not provide a direct path event.
	// Disk reconciliation before search/injection picks them up without parsing shell.
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const target = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof target !== "string" || target === "") return;
		// Tool paths are relative to the session's cwd, which is not the bank.
		const cwd = typeof (ctx as { cwd?: unknown })?.cwd === "string" ? (ctx as { cwd: string }).cwd : process.cwd();
		const full = path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);
		if (!isInsideBank(full)) return;
		const rel = resolveBankPath(MEMORY_ROOT, full)!.rel;
		if (!isMarkdownPath(rel)) return; // updateDocument skips those too; skip the log line
		memoryIndex.updateDocument(rel);
		// A `write` means the agent put the whole file there, so it holds a current copy
		// and a later memory_update is not blind. An `edit` does not claim that — the rest
		// of the file may never have been shown — so `served` is left alone and staleWrite
		// keeps refusing a whole-file replace after one.
		const written = (event.input as { content?: unknown }).content;
		if (event.toolName === "write" && typeof written === "string") noteServed(rel, written);
		logEvent(logCfg, { t: "index", f: rel, via: event.toolName });
	});

	// ── After events that rewrite the transcript: re-inject what is no longer there ──
	// Compaction replaces older turns with a summary and tree navigation moves to a
	// branch where a section may never have been sent. Both can leave the model without
	// the text a pointer referred to, which is the one state this feature can survive
	// by clearing — a stale pointer is worse than the bytes it saved.
	pi.on("session_compact", async (_event, _ctx) => {
		for (const key of CONFIG_KEYS) injectedTypes[key] = false;
		shownText.clear();
		served.clear();
		topic.clear();
		logEvent(logCfg, { t: "reset", sid: sessionId(), reason: "compaction" });
	});

	pi.on("session_tree", async (_event, _ctx) => {
		for (const key of CONFIG_KEYS) injectedTypes[key] = false;
		shownText.clear();
		served.clear();
		topic.clear();
		logEvent(logCfg, { t: "reset", sid: sessionId(), reason: "tree" });
	});

	// ── Before Agent Start: inject memory context ──
	pi.on("before_agent_start", async (event, ctx) => {
		const injectAP = shouldInject(config.activeProjects, injectedTypes.activeProjects);
		const injectDC = shouldInject(config.dailyContext, injectedTypes.dailyContext);
		const injectKnowledge = shouldInject(config.knowledge, injectedTypes.knowledge);
		const injectHistory = shouldInject(config.history, injectedTypes.history);

		// Nothing to inject this turn
		if (!injectAP && !injectDC && !injectKnowledge && !injectHistory) return;

		activeScope = detectScope(settings.scope, ctx.cwd ?? process.cwd());
		const parts: string[] = ["# Memory Bank Context\n"];
		if (activeScope.mode !== "off") parts.push(`${describeScope(activeScope)}; flat/shared knowledge remains global.\n`);
		const coreFiles: string[] = [];
		// Core text as it stood before any knowledge was appended. The log reports how much
		// of a prompt's budget was core and hashes it, because "the same core twice" and
		// "the same file twice" are two different wastes with two different fixes
		// (docs/injection-cost-design.md §2.1).
		let coreText = "";
		// What this prompt shows, staged here and merged into `shownText` once the block is
		// finished: a throw halfway through must leave no memory of a section, or the next
		// prompt would skip text that was never sent (docs/injection-cost-design.md §3.1).
		const pendingShown = new Map<string, string>();
		let pointers = 0;
		let pointerChars = 0;
		// Characters §3.2 kept out of this prompt: the number that says whether the cap is
		// trimming outliers or quietly cutting ordinary files.
		let cutChars = 0;
		// §3.5: files the cap would have left as a fragment. They arrive as a name and a way
		// to read them, and the log says so — `in` is what the model was actually shown.
		let withheldCount = 0;
		let withheldChars = 0;

		if (injectAP) {
			const activeProjects = readIfExists(path.join(CORE_DIR, "activeProjects.md"));
			if (activeProjects) {
				const shown = injectCore("core/activeProjects.md", activeProjects);
				const delta = deltaSection(shown.text, "core/activeProjects.md", pendingShown);
				noteServed("core/activeProjects.md", activeProjects, cropped(shown.hidden));
				parts.push("## Active Projects\n", delta.body, "");
				if (delta.skipped) { pointers++; pointerChars += shown.text.length; }
				coreFiles.push(coreLabel("activeProjects.md", shown.hidden, delta.skipped));
			}
		}
		if (injectDC) {
			const dailyContext = readIfExists(path.join(CORE_DIR, "dailyContext.md"));
			if (dailyContext) {
				const shown = injectCore("core/dailyContext.md", dailyContext);
				const delta = deltaSection(shown.text, "core/dailyContext.md", pendingShown);
				noteServed("core/dailyContext.md", dailyContext, cropped(shown.hidden));
				parts.push("## Daily Context\n", delta.body, "");
				if (delta.skipped) { pointers++; pointerChars += shown.text.length; }
				coreFiles.push(coreLabel("dailyContext.md", shown.hidden, delta.skipped));
			}
		}

		// Search-based injection for knowledge and history.
		// Uses the in-memory MiniSearch index (BM25, ~0ms) so that context
		// injection never adds noticeable latency to a prompt.
		// Only a user prompt carries searchable text. A run started by an idle
		// custom message has no prompt, so there is nothing to match against.
		const prompt = event.messageType === "user" ? event.prompt : "";
		const resolved = topic.resolve(prompt, memoryIndex, settings.retrieval);
		const query = resolved.query;
		const now = new Date();
		const pathReason = (rel: string) => scopeReason(rel, activeScope) ?? archiveReason(rel, settings.maintenance.historyMaxDays, now);
		let policyRejected = new Map<string, string>();
		const eligibility = { includeKnowledge: injectKnowledge, includeHistory: injectHistory };
		let chosen: Array<{ path: string; score: number }> = [];
		let considered: SearchResult[] = [];
		let searchMs = 0;
		// Filled by the loop below and read by the debug line and the log: the same numbers
		// the injector acted on, so neither can explain a rule it did not apply.
		let withheld: Array<{ path: string; score: number; chars: number; share: number }> = [];

		if (injectKnowledge || injectHistory) {
			const t0 = Date.now();
			const selection = selectContext(memoryIndex, query, MAX_INJECTED_FILES, eligibility, settings.retrieval, pathReason);
			const hits = selection.hits;
			policyRejected = selection.rejected;
			searchMs = Date.now() - t0;
			chosen = hits;
			// Debug and the log both want the rejected candidates too, which
			// searchForContext has already thrown away by the time it returns.
			if (debugMode || logCfg.enabled) considered = memoryIndex.search(query, MAX_INJECTED_FILES * 2);

			if (hits.length > 0) {
				// Decide every hit's fate before writing any of it: the heading and the recency
				// note promise records, so neither may open a block that turned them all away.
				const arrived: string[] = [];
				const turnedAway: Array<{ path: string; score: number; chars: number; share: number }> = [];
				for (const hit of hits) {
					const capped = capFile(hit.content);
					const cut = withheldShare(hit.content.length, capped.hiddenChars);
					if (cut.skipWhole) {
						// Named, not halved. Staged as partially shown, because this session has seen
						// the name and none of the text, and `memory_update` over it would drop the
						// rest — which is what the served map exists to catch.
						noteServed(hit.path, hit.content, true);
						withheldCount++;
						withheldChars += hit.content.length;
						turnedAway.push({ path: hit.path, score: Math.round(hit.score), chars: hit.content.length, share: cut.share });
						continue;
					}
					// Whole file compared, cut text shown: a change anywhere below the cut still
					// has to bring the body back, so the pointer is keyed on the content and not
					// on what happened to fit.
					const delta = deltaSection(hit.content, hit.path, pendingShown);
					if (delta.skipped) {
						pointers++;
						pointerChars += hit.content.length;
						arrived.push(`--- ${hit.path} (score: ${Math.round(hit.score)}) ---\n${delta.body}\n`);
						continue;
					}
					cutChars += capped.hiddenChars;
					const note = capped.cut
						? `\n… ${capped.cut} not shown — memory_read "${hit.path}" for the whole file\n`
						: "";
					noteServed(hit.path, hit.content, capped.hiddenLines > 0 || capped.hiddenChars > 0);
					arrived.push(`--- ${hit.path} (score: ${Math.round(hit.score)}, updated ${fileDate(hit.path)}) ---\n${capped.text}\n${note}`);
				}

				withheld = turnedAway;
				if (arrived.length > 0 || turnedAway.length > 0) coreText = parts.join("\n");
				if (arrived.length > 0) {
					// The note travels with the records: it is about disagreement between them, and a
					// prompt whose records were all withheld should not pay for it.
					parts.push("## Relevant Knowledge\n", RECENCY_NOTE, ...arrived);
				} else if (turnedAway.length > 0) {
					parts.push("## Relevant knowledge was not included\n");
				}
				// A withheld file has to be named, or the model reads the silence as "the bank
				// has nothing on this" and writes the note again somewhere else.
				for (const w of turnedAway) {
					parts.push(
						`- ${w.path} (${w.chars.toLocaleString()} characters) is not in this prompt: ` +
							`${Math.round(w.share * 100)} % of it is past the injection cap — memory_read "${w.path}" for the whole file\n`,
					);
				}
			}
		}

		// Mark types as injected AFTER successful construction (avoids
		// permanently skipping injection if an error occurs above)
		// The block was built, so what it showed is what the model now has.
		for (const [source, text] of pendingShown) shownText.set(source, text);
		if (event.messageType === "user" && (injectKnowledge || injectHistory)) topic.remember(query, chosen.length > 0);

		if (injectAP) injectedTypes.activeProjects = true;
		if (injectDC) injectedTypes.dailyContext = true;
		if (injectKnowledge) injectedTypes.knowledge = true;
		if (injectHistory) injectedTypes.history = true;

		const content = parts.join("\n");
		// With no knowledge in this prompt, the whole block was core.
		const coreOnly = coreText || content;

		if (debugMode) {
			ctx.ui.notify(
				describeInjection({ coreFiles, chosen, considered, eligibility, prompt: query, block: content, withheld, policyRejected, pathReason }) +
					(resolved.continuation ? " | continued prior topic" : ""),
				"info",
			);
		}

		// The same facts the debug line shows, in a form a script can read. `out` carries
		// the rejection reason, because "why did it not come" is the question a fixture is
		// written to answer. A file that matched, was chosen, and was then withheld lands in
		// `out` and not `in`: `in` is what the model was shown, and a log that lists a file
		// the prompt never contained is the kind of wrong number that gets trusted.
		if (logCfg.enabled) {
			const withheldPaths = new Set(withheld.map((w) => w.path));
			const picked = new Set(chosen.map((c) => c.path));
			const topScore = topEligibleScore(considered.filter((r) => !pathReason(r.path)), eligibility);
			const withheldOut = withheld.map((w) => ({
				f: w.path,
				s: w.score,
				why: `${Math.round(w.share * 100)} % of it is past the injection cap`,
			}));
			logEvent(logCfg, {
				t: "inject",
				sid: sessionId(),
				p: logCfg.prompts ? clip(prompt, LOG_PROMPT_CHARS) : "[redacted]",
				qt: new Set(contentTerms(query)).size,
				mode: settings.retrieval.mode,
				scope: activeScope.name,
				continuation: resolved.continuation,
				core: coreFiles,
				// Delta injection (§3.1): how many sections were a pointer, and what they cost.
				pt: pointers,
				sv: pointerChars,
				cu: cutChars,
				// §3.5: files named instead of sent, and the characters that saved by not being cut.
				wc: withheldCount,
				wch: withheldChars,
				// Core is the part that costs every prompt whether or not the topic
				// matches, and 39 % of injected bytes were identical to the previous
				// prompt's (docs/injection-cost-design.md §2.1). A hash is what makes
				// that number observable from the log instead of from a session dump.
				cc: coreOnly.length,
				ch: shortHash(coreOnly),
				in: chosen.filter((h) => !withheldPaths.has(h.path)).map((h) => ({ f: h.path, s: Math.round(h.score) })),
				out: [
					...withheldOut,
					...considered
						.filter((r) => !picked.has(r.path))
						.slice(0, Math.max(0, 6 - withheldOut.length))
						.map((r) => {
							const verdict = admitsToContext(r.category, r.score, topScore, eligibility);
							// A knowledge file is always "admitted" by the rule, so its reason is
							// the word "knowledge" — true, and useless in a log. Say what actually
							// stopped it. Found by reading the first real log line, not by a test.
							return {
								f: r.path,
								s: Math.round(r.score),
								why: pathReason(r.path) ?? policyRejected.get(r.path) ?? (verdict.admit ? `past the top ${MAX_INJECTED_FILES}` : verdict.reason),
							};
						}),
				],
				chars: content.length,
				ms: searchMs,
			});
		}

		return {
			message: {
				customType: "memory-context",
				content,
				display: false,
				// Structured evidence for the eval/replay harness: produced by the injector,
				// not reconstructed from raw ranks or a second implementation of the caps.
				details: {
					queryTerms: new Set(contentTerms(query)).size,
					continuation: resolved.continuation,
					mode: settings.retrieval.mode,
					scope: activeScope,
					files: chosen.filter((h) => !withheld.some((w) => w.path === h.path)).map((h) => ({ path: h.path, score: h.score })),
					withheld: withheld.map((h) => h.path),
				},
			},
		};
	});

	// ── Tool: memory_read ──
	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description:
			"Read a file from the persistent memory bank. Use to check activeProjects, dailyContext, knowledge files, or daily history.",
		promptSnippet: "Read persistent memory bank files (activeProjects, dailyContext, knowledge, history)",
		parameters: Type.Object({
			file: Type.String({
				description:
					`Relative path within ${MEMORY_ROOT}/ — e.g. core/activeProjects.md, core/dailyContext.md, knowledge/git-standards.md, history/daily/2025-03/2025-03-03-dailyContext.md`,
			}),
		}),
		async execute(_toolCallId, params) {
			const filePath = path.resolve(MEMORY_ROOT, params.file);
			// Safety: stay inside MEMORY_ROOT
			if (!isInsideBank(filePath)) {
				return toolResult(ERR_OUTSIDE_BANK, { file: params.file }, true);
			}
			const content = readIfExists(filePath);
			if (content === null) {
				return toolResult(notFound(params.file, filePath), { file: params.file }, true);
			}
			const capped = capLines(content, MAX_READ_LINES);
			const bytes = Buffer.from(capped.text, "utf8");
			const byteLimited = bytes.length > MAX_READ_BYTES;
			const partial = capped.hiddenLines > 0 || byteLimited;
			noteServed(params.file, content, partial);
			if (partial) {
				// Trim an incomplete UTF-8 sequence at the boundary rather than introducing
				// a replacement character into what appears to be the original file.
				const shown = byteLimited ? bytes.subarray(0, MAX_READ_BYTES).toString("utf8").replace(/\uFFFD$/, "") : capped.text;
				return toolResult(
					`${shown}\n\n… file not shown in full (read limit: ${MAX_READ_LINES} lines or ${MAX_READ_BYTES.toLocaleString()} UTF-8 bytes). ` +
					`Whole-file memory_update remains refused; use a targeted edit after reading the rest: ${filePath}`,
					{ file: params.file, bytes: Buffer.byteLength(content), lines: content.split("\n").length, hiddenLines: capped.hiddenLines, byteLimited },
				);
			}
			return toolResult(content, { file: params.file, bytes: content.length });
		},
	});

	// ── Tool: memory_update ──
	pi.registerTool({
		name: "memory_update",
		label: "Memory Update",
		description:
			"Update a file in the persistent memory bank. Use to maintain activeProjects.md, dailyContext.md, or knowledge files across sessions. This creates the file when the path does not exist yet, so a new knowledge file goes in here. Replaces the whole file; existing files must first be read completely. Refuses if current content differs from what this session saw — memory_read and re-apply. allowUnread explicitly permits a blind replacement, never a stale or partial one.",
		promptSnippet: "Update persistent memory bank files (activeProjects, dailyContext, knowledge)",
		promptGuidelines: [
			// ── Core rules ──
			"Update dailyContext.md throughout the session: log completed work, decisions, and carry-forward items.",
			"Update activeProjects.md when project status changes (new projects, completed work, priority shifts).",
			"When updating dailyContext.md sections, APPEND to existing entries — never overwrite the whole section.",
			"Keep dailyContext.md under 150 lines and 6,000 characters; keep activeProjects.md under 50 lines and 6,000 " +
				"characters. Characters are what a prompt pays for: 30 items of 150 characters cost more than 150 short ones, " +
				"and a long section is truncated in preference to a whole section being dropped.",

			// ── Proactive knowledge capture ──
			"When the user establishes conventions, tone/voice rules, architectural decisions, workflow preferences, " +
				"or any reusable guidance — immediately store it as a knowledge file in knowledge/<name>.md. " +
				"Don't wait to be asked. Knowledge files are for things that should survive beyond today. " +
				"If you'd need to re-derive it in a future session, it belongs in knowledge/.",
			"Write bank files with memory_update, not the harness file tools: it creates a missing file, and its " +
				"write is checked against what this session was shown. A write around it is blind, and reaches the " +
				"search index through write/edit result hooks or disk reconciliation before retrieval. These routes " +
				"do not provide memory_update's stale-base checks or recovery capture.",

			// ── Reversal: supersede, never duplicate ──
			"A decision can be reversed, and two records about one topic are both retrieved — the older, " +
				"better-aliased one can rank first. Before storing a preference or decision, memory_search for the " +
				"record that covers it; if one exists, memory_read it and memory_update the whole file, restating the " +
				"parts that still hold, rather than creating a second file or appending a competing answer. Add a dated " +
				"line under '## Source' so the newest statement is visible.",

			// ── Knowledge file discipline ──
			"Knowledge files should be concise: target 10-50 lines, max 100 lines. If a knowledge file grows past " +
				"100 lines, split it into focused files — injection stops at 100 lines, so a longer file is already being " +
				"read in pieces. Each file should cover one topic or convention.",
			// ── Discoverability ──
			"Name the words a future prompt will use, as parenthetical aliases in the H1 — " +
				"`# Proposal tone (proposals, pitches, outreach, hedging)`. Search is BM25 with no synonym bridge, so a " +
				"file can only ever surface for words it literally contains; write them down. The heading is the best " +
				"place for them: it is indexed as its own field at 3x the weight of the body, so heading words decide " +
				"which matches survive the top-3 cut. No trigger-word index exists. Aliases are words, not phrases: the " +
				"index splits on punctuation, so `(change my mind)` also aliases `change`, which almost any bug report " +
				"says. Prefer words a prompt about something else would not need.",
			"Include source attribution in knowledge files: who said it, when, and where (PR, Slack thread, meeting). " +
				"Add a '## Source' section at the bottom.",
			"If a pattern looks like a multi-step workflow (3+ steps that repeat), it belongs as a Skill, not a knowledge file.",

			// ── Word budgets ──
			"dailyContext entries must be concise: Completed items 15-25 words, Key Decisions 10-20 words, " +
				"activeProjects one line per project. Use progressive refinement: draft full, then shorten.",

			// ── Sections: what each heading means, including the two we write ──
			"The extension writes two of these for you: `### Carried Forward`, unfinished work from yesterday's " +
				"\"Context for Tomorrow\", and the `## YYYY-MM-DD` heading that dates the day. " +
				"Each fact belongs in exactly one dailyContext section. Completed = actions taken (what you did). " +
				"Key Decisions = outcomes decided (what was resolved, with rationale). In Progress = work still open " +
				"right now — it is archived at rollover and does not survive into tomorrow, so anything that must be " +
				"picked up the next day goes under \"Context for Tomorrow\" instead, and a Carried Forward item is " +
				"deleted once it is done or dropped. " +
				"Don't repeat the same information across sections. If a meeting produced a decision, " +
				"Completed says 'Held meeting with X' and Key Decisions captures the outcome.",

			// ── A write that was refused ──
			"A refused memory_update means the file is not what you think it is: another Pi session wrote it, or it was edited by hand, or it was only ever shown to you truncated. memory_read it and re-apply your change to what is there now. Never retry the same content hoping it lands, and never assume yours is the version that should win.",

			// ── Self-verification ──
			"Before modifying code, committing, or taking any irreversible action, consider: is there a knowledge " +
				"file about conventions for this area? If unsure, call memory_search with the relevant topic first. " +
				"This is especially important for: git conventions, component patterns, API design rules, and testing standards.",
		],
		parameters: Type.Object({
			file: Type.String({
				description:
					`Relative path within ${MEMORY_ROOT}/ — e.g. core/dailyContext.md, core/activeProjects.md, knowledge/git-rules.md. A path that does not exist yet creates the file, parent directories included.`,
			}),
			content: Type.String({ description: "Full file content to write, based on the current text of the file" }),
			allowUnread: Type.Optional(Type.Boolean({ description: "Explicitly permit replacing an existing file never read in this session. Does not bypass stale or partial-view protection; prefer reading first." })),
		}),
		async execute(_toolCallId, params) {
			const filePath = path.resolve(MEMORY_ROOT, params.file);
			if (!isInsideBank(filePath)) {
				return toolResult(ERR_OUTSIDE_BANK, { file: params.file }, true);
			}
			const release = await acquireWriteLock(filePath);
			if (!release) return toolResult(`Refused: write lock busy for ${params.file}; check .write-locks for an abandoned lock.`, { file: params.file, refused: "lock-busy" }, true);
			try {
			if (internalPath(bankRel(params.file))) return toolResult("Refused: internal recovery/lock files are not memory write targets.", { file: params.file }, true);
			// Compare against the actual text served, under the same lock as the write.
			let why: string | null;
			try { why = staleWrite(params.file, params.allowUnread); }
			catch (error) {
				return toolResult(`Refused: cannot verify current text for ${params.file} — ${String(error)}`, { file: params.file, refused: "read-failed" }, true);
			}
			if (why) {
				// A refused write is a signal, not an error: it means two writers met. Counting
				// them is how "nobody hits that" gets checked instead of assumed.
				logEvent(logCfg, { t: "write", f: params.file, refused: "stale-base" });
				return toolResult(
					`Refused: ${why}. memory_read "${params.file}" and re-apply your change — this tool replaces the whole file.`,
					{ file: params.file, refused: "stale-base" },
					true,
				);
			}
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			try { await revisions.write(filePath, params.content, settings.revisions); }
			catch (error) { return toolResult(`Refused: recovery/write failed — ${String(error)}`, { file: params.file }, true); }
			noteServed(params.file, params.content);
			logEvent(logCfg, { t: "write", f: params.file, bytes: params.content.length });

			// Keep the search index in sync
			memoryIndex.updateDocument(params.file);

			return toolResult(
				`Updated ${params.file} (${params.content.length} bytes) ${AT} ${filePath}`,
				{ file: params.file, bytes: params.content.length },
			);
			} finally { release(); }
		},
	});

	// ── Tool: memory_append ──
	pi.registerTool({
		name: "memory_append",
		label: "Memory Append",
		description:
			"Append text to a section in a memory bank file. Cooperating memory_append, memory_update and daily rollover serialize per file; external writers do not participate.",
		promptSnippet: "Append entries to a section in a memory bank file",
		parameters: Type.Object({
			file: Type.String({
				description: `Relative path within ${MEMORY_ROOT}/ — e.g. core/dailyContext.md`,
			}),
			section: Type.String({
				description: 'Section heading to append to — e.g. "Completed", "In Progress", "Key Decisions"',
			}),
			text: Type.String({
				description: "Text to append (one entry per line, use - prefix for list items)",
			}),
		}),
		async execute(_toolCallId, params) {
			const filePath = path.resolve(MEMORY_ROOT, params.file);
			if (!isInsideBank(filePath)) {
				return toolResult(ERR_OUTSIDE_BANK, { file: params.file }, true);
			}
			const release = await acquireWriteLock(filePath);
			if (!release) return toolResult(`Refused: write lock busy for ${params.file}; check .write-locks for an abandoned lock.`, { file: params.file, refused: "lock-busy" }, true);
			try {
			if (internalPath(bankRel(params.file))) return toolResult("Refused: internal recovery/lock files are not memory write targets.", { file: params.file }, true);
			let content: string | null;
			try { content = readCurrentFile(filePath); }
			catch (error) {
				return toolResult(`Refused: cannot read current text for ${params.file} — ${String(error)}`, { file: params.file, refused: "read-failed" }, true);
			}
			if (content === null) {
				return toolResult(notFound(params.file, filePath), { file: params.file, section: params.section }, true);
			}

			// Insert at the end of the section's body, before the next heading
			const found = findSection(content, params.section);
			if (!found) {
				return toolResult(
					`Section "${params.section}" not found in ${params.file} ${AT} ${filePath} — ` +
					`the file is there and that heading is not; memory_read "${params.file}" to see what is`,
					{ file: params.file, section: params.section },
					true,
				);
			}

			const head = content.slice(0, found.end);
			const tail = content.slice(found.end);
			const updated = tail.length === 0
				? `${head.trimEnd()}\n${params.text}\n`
				: `${head.trimEnd()}\n${params.text}\n\n${tail}`;

			// Appending does not show the rest of the file. Preserve a complete view only
			// when the agent had seen this exact version before the append.
			const complete = served.complete(bankRel(params.file), content);
			try { await revisions.write(filePath, updated, settings.revisions); }
			catch (error) { return toolResult(`Refused: recovery/write failed — ${String(error)}`, { file: params.file }, true); }
			noteServed(params.file, updated, !complete);

			// Keep the search index in sync
			memoryIndex.updateDocument(params.file);

			return toolResult(
				`Appended to "${params.section}" in ${params.file} ${AT} ${filePath}`,
				{ file: params.file, section: params.section },
			);
			} finally { release(); }
		},
	});

	// ── Tool: memory_search ──
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search across all memory bank files — knowledge, daily history, and core files. " +
			"Ranked with BM25, with fuzzy and prefix matching. " +
			"Use to find past decisions, recall context from previous sessions, or discover relevant knowledge files. " +
			"Archives outside the automatic injection age window remain searchable here.",
		promptSnippet: "Search across all memory bank files (knowledge, history, core) with fuzzy full-text search",
		parameters: Type.Object({
			query: Type.String({
				description: "Search query — natural language or keywords. Fuzzy matching handles typos and partial words.",
			}),
			limit: Type.Optional(
				Type.Number({ description: "Max results to return (default 5)" }),
			),
		}),
		async execute(_toolCallId, params) {
			const limit = params.limit ?? 5;
			const results = memoryIndex.search(params.query, limit).map((r) => ({ ...r, scope: scopeLabel(r.path) }));

			// Asked questions are the other half of the record: they show the vocabulary a
			// real person used, which is what an alias list is supposed to contain.
			logEvent(logCfg, {
				t: "search",
				q: logCfg.prompts ? clip(params.query, LOG_PROMPT_CHARS) : "[redacted]",
				n: results.length,
				top: results.slice(0, 3).map((r) => ({ f: r.path, s: Math.round(r.score) })),
			});

			if (results.length === 0) {
				// A blank answer for "what did we decide about it" reads like "nothing is
				// stored", which is the answer that makes an agent write the note again. The
				// query had no searchable word; say which of the two happened.
				const why = contentTerms(params.query).length === 0
					? `Nothing searched, because every word in "${params.query}" is a common word (the, how, what, about) that search ignores. Ask again with a content word, for example "postgres" or "release".`
					: `No results found for "${params.query}"`;
				return toolResult(why, { query: params.query, results: [] });
			}

			const formatted = results
				.map((r, i) => [
					`${i + 1}. **${r.title}** (${r.category}${activeScope.mode !== "off" ? `; ${r.scope}` : ""})`,
					`   Path: ${r.path} | Score: ${Math.round(r.score)}${archiveReason(r.path, settings.maintenance.historyMaxDays) ? ` | ${archiveReason(r.path, settings.maintenance.historyMaxDays)}` : ""}`,
					`   ${r.snippet}`,
				].join("\n"))
				.join("\n\n");

			return toolResult(
				`Found ${results.length} results for "${params.query}":\n\n${formatted}`,
				{ query: params.query, results },
			);
		},
	});

	// ── Tool: memory_list ──
	pi.registerTool({
		name: "memory_list",
		label: "Memory List",
		description: "List files in the memory bank, including every subdirectory. Use to discover available knowledge files and history archives.",
		promptSnippet: "List files in the persistent memory bank",
		parameters: Type.Object({
			directory: Type.Optional(
				Type.String({
					description:
						`Relative directory within ${MEMORY_ROOT}/ — e.g. "knowledge", "history/daily", "core". Defaults to root.`,
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const dir = path.resolve(MEMORY_ROOT, params.directory ?? ".");
			const directory = params.directory ?? ".";
			if (!isInsideBank(dir)) {
				return toolResult(ERR_OUTSIDE_BANK, { directory }, true);
			}
			const listing = listBank(dir, MEMORY_ROOT);
			if (listing === null) {
				return toolResult(`Directory not found: ${directory}`, { directory }, true);
			}
			if (listing.entries.length === 0) {
				return toolResult("(empty)", { directory, entries: [] });
			}
			const note = listing.hidden > 0
				? `\n… ${listing.hidden} more entries not shown — pass a subdirectory to narrow the walk`
				: "";
			return toolResult(listing.entries.join("\n") + note, {
				directory,
				entries: listing.entries,
				hiddenEntries: listing.hidden,
			});
		},
	});

	// ── Command: /memory ──
	const memoryHelp = [
		"Memory commands:",
		"  /memory [status]                 Show bank status",
		"  /memory help                     Show this command list",
		"  /memory doctor                   Check bank health",
		"  /memory refresh                  Rebuild the search index",
		"  /memory scope                    Show detected scope and eligible folders",
		"  /memory revisions [file]         List local recovery snapshots",
		"  /memory restore <file> <id>      Restore explicitly, backing up current text",
		"  /memory config [key [value]]     View or set injection and policy settings",
		"  /memory debug [on|off]           View or change injection reporting",
		"  /memory log [on|off|stats]       View or change usage logging",
		"  /memory log prompts [on|off]     View or change prompt logging",
		"Config keys: activeProjects, dailyContext, knowledge, history",
		"Config values: every-turn, first-turn, off",
		"Policy keys: " + SETTING_SPECS.map((s) => s.key).join(", "),
	].join("\n");
	pi.registerCommand("memory", {
		description: "Show memory bank status. Subcommands: '/memory config [key] [value]' sets injection frequency, '/memory debug [on|off]' toggles injection reporting, '/memory log [on|off|stats]' records prompts and injection decisions, '/memory doctor' checks bank health, and '/memory refresh' rebuilds the search index.",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "help") {
				ctx.ui.notify(memoryHelp, "info");
				return;
			}

			// Rebuild on demand after external edits, including edits that do not change
			// the document count and therefore cannot be detected by doctor.
			if (trimmed === "refresh") {
				const count = memoryIndex.build();
				ctx.ui.notify(`Memory search index refreshed: ${count} documents`, "info");
				return;
			}

			// Sub-command: doctor
			if (trimmed === "doctor") {
				const report = doctorReport();
				ctx.ui.notify([report.header, ...report.lines].join("\n"), report.warnings > 0 ? "warning" : "info");
				return;
			}

			// Sub-command: debug [on|off]
			if (trimmed === "debug" || trimmed.startsWith("debug ")) {
				const arg = trimmed.slice(5).trim();
				if (arg === "on" || arg === "off") {
					debugMode = arg === "on";
					saveDebug(debugMode);
					ctx.ui.notify(`Injection debug ${debugMode ? "on" : "off"} (saved to config.json)`, "info");
					return;
				}
				if (arg !== "") {
					ctx.ui.notify(`Unknown value "${arg}". Usage: /memory debug [on|off]`, "error");
					return;
				}
				ctx.ui.notify(
					`Injection debug is ${debugMode ? "on" : "off"}.\n\n` +
					`On: each prompt prints one line naming which memory files were injected, their\n` +
					`    scores, what was turned down and why, and the size of the block.\n` +
					`Off: nothing is printed (the default).\n\n` +
					`Toggle with: /memory debug on | /memory debug off`,
					"info",
				);
				return;
			}

			// Sub-command: log [on|off|prompts [on|off]|stats]
			if (trimmed === "log" || trimmed.startsWith("log ")) {
				const parts = trimmed.slice(3).trim().split(/\s+/).filter(Boolean);
				const [word, value] = parts.length > 0 ? [parts[0], parts[1]] : ["", ""];

				if (word === "on" || word === "off") {
					logCfg = saveLogConfig({ enabled: word === "on" });
					ctx.ui.notify(
						`Usage log ${logCfg.enabled ? "on" : "off"} (saved to config.json)\nFile: ${logFilePath()}`,
						"info",
					);
					return;
				}
				if (word === "prompts") {
					if (value === "on" || value === "off") {
						logCfg = saveLogConfig({ prompts: value === "on" });
						ctx.ui.notify(
							`Usage log records prompt and query text: ${logCfg.prompts ? "on" : "off — decisions, scores and reasons only"}`,
							"info",
					);
						return;
					}
					ctx.ui.notify("Usage: /memory log prompts [on|off]", "error");
					return;
				}
				if (word === "stats") {
					const file = logFilePath();
					const s = summarizeLog(file);
					const types = Object.entries(s.byType)
						.map(([t, n]) => `${t} ${n}`)
						.join(", ");
					const prompts = s.prompts
						.slice(-5)
						.map((p) => `  - ${clip(p, 70)}`)
						.join("\n");
					// The two numbers docs/injection-cost-design.md §6 is written against: bytes
					// this session already paid for one prompt ago, and the filler a relevance
					// floor would remove. Both carry their denominator, because a log started this
					// morning would otherwise read as a rate over three prompts.
					const c = s.cost;
					const cost = c.measured === 0
						? `  cost: no inject line here carries a core hash yet, so nothing can be compared\n`
						: `  cost over ${c.measured} prompt(s): re-sent core ${c.coreRepeated}x for ${c.coreRepeatedChars} chars, ` +
							`re-sent knowledge set ${c.knowledgeRepeated}x for ${c.knowledgeRepeatedChars} chars` +
							`${c.legacy > 0 ? ` (${c.legacy} older line(s) had no hash)` : ""}\n` +
							// The other side of the same line: what §3.1 stopped sending. Zero here with a
							// non-zero re-sent count above is the feature not working.
							`  pointers: ${c.pointers} section(s) sent by reference, ${c.pointerChars.toLocaleString()} chars not re-sent; caps cut ${c.cutChars.toLocaleString()} chars\n` +
							`  filler: ${c.normSamples === 0 ? "no tail slot had prompt text to score per term" : `tail score per content term p50 ${c.normTailP50} over ${c.normSamples} slot(s)`}` +
							`${c.normUnavailable > 0 ? ` — ${c.normUnavailable} tail slot(s) unmeasurable with prompt logging off` : ""}\n` +
							// The floor's floor: a file that scored nothing got in on one shared word, and no
							// relative rule can notice, because there is no top to be a fraction of.
							`  admitted: ${c.slots} file slots, ${c.slotsZero} scored nothing, ${c.slotsUnderFive} scored under 5\n` +
							// What a total knowledge budget would be sized from — the deferred half of
							// §3.5 — measured over these prompts rather than reconstructed: sizing that cap
							// at `npm run measure`'s 9,442 would have cut in on 82 % of them.
							`  knowledge per prompt: p50 ${c.knowledgeCharsP50?.toLocaleString() ?? "n/a"}, ` +
							`p75 ${c.knowledgeCharsP75?.toLocaleString() ?? "n/a"} chars` +
							(c.withheld > 0
								? `\n  withheld: ${c.withheld} file(s) named instead of sent, ${c.withheldChars.toLocaleString()} chars — ` +
									`a file the cap would leave under half is a wrong claim with a pointer to the right one`
								: "") +
							"\n";
					ctx.ui.notify(
						`usage log — ${s.events} events in ${path.basename(file)}${s.broken > 0 ? ` (${s.broken} lines did not parse)` : ""}\n` +
							`  ${types || "nothing yet"}\n` +
							`  injects that found nothing: ${s.injectedNothing}\n` +
							cost +
							(s.files.length > 0
								? `  most injected: ${s.files.map((f) => `${shortName(f.path)} ${f.times}`).join(", ")}\n`
								: "") +
							(prompts ? `  last prompts:\n${prompts}` : ""),
						"info",
					);
					return;
				}
				if (word !== "") {
					ctx.ui.notify(`Unknown value "${word}". Usage: /memory log [on|off|prompts [on|off]|stats]`, "error");
					return;
				}
				const status = logStatus(logCfg);
				ctx.ui.notify(
					[
						`Usage log is ${status.enabled ? "on" : "off"}.`,
						"",
						"On: one JSON line per event — each prompt, the candidates the scorer looked at, what",
						"    went in, and why each rejected file was rejected; also every memory_search, and",
						"    every refused write. It is how a real question becomes a test fixture.",
						"Off: nothing is written (the default), because a prompt log records your work.",
						"",
						`File: ${status.file}`,
						`Size: ${Math.round(status.bytes / 1024)} KB of ${Math.round(LOG_CAP_BYTES / 1024)} KB, prompt text ${status.prompts
							? "included — /memory log prompts off keeps it out"
							: "redacted"}`,
						"",
						"Read it: /memory log stats",
					].join("\n"),
					"info",
				);
				return;
			}

			if (trimmed === "scope") {
				activeScope = detectScope(settings.scope, ctx.cwd ?? process.cwd());
				ctx.ui.notify([describeScope(activeScope), ...scopeFolders(scanMarkdownFiles(KNOWLEDGE_DIR, MEMORY_ROOT).map((f) => f.id), activeScope), "Override with /memory config scope.name <folder>; scope.mode is off | auto | explicit. Core/history and flat/shared knowledge remain global; this is not a privacy wall."].join("\n"), "info");
				return;
			}
			if (trimmed === "revisions" || trimmed.startsWith("revisions ")) {
				try {
					const file = trimmed.slice(9).trim() || null, history = revisions.list(file, settings.revisions);
					const limit = file ? 100 : 10;
					const lines = history.revisions.slice(0, limit).map((row) => `  ${row.id}  ${row.createdAt}  ${row.path} (${row.bytes} bytes)`);
					ctx.ui.notify([`Revision history ${settings.revisions.enabled ? "on" : "off"}; ${history.revisions.length} snapshot(s)${file ? ` for ${file}` : ""}; store ${history.bytes.toLocaleString()} bytes.`, `Limits: ${settings.revisions.maxPerFile}/file, ${settings.revisions.maxTotalBytes.toLocaleString()} bytes total.`, ...lines, ...(history.revisions.length > limit ? ["More snapshots exist; pass a filename to narrow the list."] : []), ...history.errors.slice(0, 3).map((error) => `Warning: ${error}`), "Restore: /memory restore <file> <id> — always backs up current text. External/harness writes are not captured."].join("\n"), "info");
				} catch (error) { ctx.ui.notify(`Revision history: ${String(error)}`, "error"); }
				return;
			}
			if (trimmed === "restore" || trimmed.startsWith("restore ")) {
				const args = trimmed.slice(7).trim(), split = args.lastIndexOf(" ");
				if (split < 1) { ctx.ui.notify("Usage: /memory restore <file> <exact revision id>", "error"); return; }
				const file = args.slice(0, split).trim(), id = args.slice(split + 1).trim();
				const target = resolveBankPath(MEMORY_ROOT, file);
				if (!target || internalPath(target.rel)) { ctx.ui.notify("Refused: invalid restore target.", "error"); return; }
				// Lock the configured-root spelling, like every other caller: `.full` may
				// be realpath (/private/var), which this bank root would read as outside.
				const release = await acquireWriteLock(path.resolve(MEMORY_ROOT, target.rel));
				if (!release) { ctx.ui.notify("Refused: restore target is locked; inspect .write-locks.", "error"); return; }
				try {
					const result = await revisions.restore(target.rel, id, settings.revisions);
					if (result.restored) {
						served.forget(target.rel); shownText.delete(target.rel); memoryIndex.updateDocument(target.rel);
						for (const key of CONFIG_KEYS) injectedTypes[key] = false;
						logEvent(logCfg, { t: "restore", f: target.rel, id, backup: result.backupId });
					}
					ctx.ui.notify(result.restored ? `Restored ${target.rel}; ${result.backupId ? `previous text backed up as ${result.backupId}` : "target was missing"}. memory_read before editing.` : `${target.rel} already matches that snapshot.`, "info");
				} catch (error) { ctx.ui.notify(`Refused: restore failed — ${String(error)}`, "error"); }
				finally { release(); }
				return;
			}

			// Sub-command: config [key] [value]
			if (trimmed === "config" || trimmed.startsWith("config ")) {
				const configArgs = trimmed.slice(6).trim();

				// No args: show current config
				if (!configArgs) {
					const configLines = CONFIG_KEYS.map((k) => `  ${k.padEnd(16)} ${config[k]}`);
					ctx.ui.notify(
						`Memory injection config (${CONFIG_PATH}):\n\n` +
						[...configLines, ...settingsLines(settings)].join("\n") + "\n\n" +
						`Usage: /memory config <key> <value>\n` +
						`Values: every-turn | first-turn | off`,
						"info",
					);
					return;
				}

				const [key, ...rest] = configArgs.split(/\s+/);
				const value = rest.join(" ") as Frequency;
				if (SETTING_SPECS.some((spec) => spec.key === key)) {
					if (!value) { ctx.ui.notify(settingsLines(settings).find((line) => line.trimStart().startsWith(key + " ="))!, "info"); return; }
					try {
						const next = changeSetting(settings, key, value); saveSettings(next); settings = next; topic.clear();
						activeScope = detectScope(settings.scope, ctx.cwd ?? process.cwd());
						injectedTypes.knowledge = false; injectedTypes.history = false;
						ctx.ui.notify(`Set ${key} = ${value} (persisted to config.json)`, "info");
					} catch (error) { ctx.ui.notify(String(error), "error"); }
					return;
				}

				if (!CONFIG_KEYS.includes(key as keyof InjectionConfig)) {
					ctx.ui.notify(`Unknown config key: "${key}". Valid keys: ${CONFIG_KEYS.join(", ")}`, "error");
					return;
				}

				const configKey = key as keyof InjectionConfig;

				// No value: show current value for this key
				if (!value) {
					ctx.ui.notify(`${configKey} = ${config[configKey]}`, "info");
					return;
				}

				if (!VALID_FREQUENCIES.includes(value)) {
					ctx.ui.notify(`Invalid value: "${value}". Must be one of: ${VALID_FREQUENCIES.join(", ")}`, "error");
					return;
				}

				config[configKey] = value;
				injectedTypes[configKey] = false; // reset so next turn uses new config
				saveConfig(config);
				ctx.ui.notify(`Set ${configKey} = ${value} (persisted to config.json)`, "info");
				return;
			}

			if (trimmed !== "" && trimmed !== "status") {
				ctx.ui.notify(`Unknown memory command: "${trimmed}".\n\n${memoryHelp}`, "error");
				return;
			}
			const activeProjects = readIfExists(path.join(CORE_DIR, "activeProjects.md"));
			const dailyContext = readIfExists(path.join(CORE_DIR, "dailyContext.md"));

			const lines: string[] = [`Memory bank: ${MEMORY_ROOT}`, ""];
			lines.push(`injection:         ${CONFIG_KEYS.map((k) => `${k}=${config[k]}`).join(", ")}`);
			lines.push(describeScope(activeScope));
			lines.push(`revisions:         ${settings.revisions.enabled ? "on" : "off"} (/memory revisions)`);
			lines.push(`retrieval:         ${settings.retrieval.mode}${settings.retrieval.mode === "balanced" ? " (experimental; labels not owner-reviewed)" : ""}`);
			lines.push(`debug:             ${debugMode ? "on  (/memory debug off)" : "off (/memory debug on)"}`);
			lines.push(`log:               ${logCfg.enabled ? `on  (${Math.round(logStatus(logCfg).bytes / 1024)} KB, /memory log stats)` : "off (/memory log on)"}`);

			lines.push(`activeProjects.md: ${activeProjects ? `${activeProjects.split("\n").length} lines` : "missing"}`);
			lines.push(`dailyContext.md:   ${dailyContext ? `${dailyContext.split("\n").length} lines` : "missing"}`);

			// Count knowledge files (all .md in knowledge/)
			let knowledgeCount = 0;
			try {
				knowledgeCount = fs.readdirSync(KNOWLEDGE_DIR).filter(isMarkdownPath).length;
			} catch {}
			lines.push(`knowledge files:   ${knowledgeCount}`);

			// Count history archives
			let archiveCount = 0;
			try {
				const months = fs.readdirSync(HISTORY_DIR);
				for (const month of months) {
					const monthDir = path.join(HISTORY_DIR, month);
					if (fs.statSync(monthDir).isDirectory()) {
						archiveCount += fs.readdirSync(monthDir).length;
					}
				}
			} catch {}
			lines.push(`daily archives:    ${archiveCount} files`);
			lines.push(`search index:      ${memoryIndex.documentCount} documents (MiniSearch BM25)`);
			lines.push("", memoryHelp);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

// ── Utils ────────────────────────────────────────────────────────


/**
 * "Where" separator, used only in the four results that name a place.
 *
 * A bank-relative path is a claim about a root the message does not state, and an
 * agent that cannot see the root assumes the one it is standing in. Measured
 * 2026-10-29: a harness `write` of `knowledge/example-port.md` from a project
 * confirmed `Successfully wrote to knowledge/example-port.md` — pi echoes the path
 * it was handed — the agent read that as "in the bank", and 45 minutes later a
 * `find /` took 179 s to find its own note. This extension cannot fix that other
 * tool's wording; it can refuse to leave the same doubt in its own. Four strings
 * only: a read still returns the file and nothing above it, and search results and
 * `memory_list` entries stay relative, because a listing of the bank under its own
 * root needs no translation to be understood.
 */
const AT = "→";

/** A missing bank file, named by the whole path that was not there. */
function notFound(relPath: string, filePath: string): string {
	return (
		`File not found: ${relPath} — nothing at ${filePath}. ` +
		`memory_list names what the bank holds.`
	);
}

/**
 * Every write in this extension is a whole-file write, so a write is only safe
 * relative to the version it was based on. The agent's working copy of
 * `activeProjects.md` is the block injected on the previous turn — it has no
 * reason to suspect the file moved, and no way to know. So remember how each
 * bank file looked when we served it, and refuse a whole-file write whose target
 * has since changed shape: another Pi session, a hand edit, or this extension's
 * own day rollover then costs one refused call and a re-read, not a silent
 * replacement. `npm run race` measures what it used to cost.
 */
const served = new ServedVersions();

/** Serialize cooperating memory tools. Never steal a lock: after a crash a human
 * must inspect and remove it, rather than risking two writers in the critical section. */
async function acquireWriteLock(filePath: string): Promise<(() => void) | null> {
	return acquireBankLock(MEMORY_ROOT, filePath);
}

/** Bank-relative, forward-slashed, so injection and tool calls agree on a key. */
function bankRel(relPath: string): string {
	const resolved = resolveBankPath(MEMORY_ROOT, relPath);
	if (!resolved) throw new Error(ERR_OUTSIDE_BANK);
	return resolved.rel;
}

/** Remember precisely what was returned, not a later version of the pathname. */
function noteServed(relPath: string, content: string, partial = false): void {
	served.note(bankRel(relPath), content, partial);
}

function staleWrite(relPath: string, allowUnread = false): string | null {
	return served.refusal(bankRel(relPath), readCurrentFile(path.resolve(MEMORY_ROOT, relPath)), allowUnread);
}

function isInsideBank(full: string): boolean {
	return resolveBankPath(MEMORY_ROOT, full) !== null;
}

/**
 * Build a tool result.
 *
 * Pi's AgentToolResult requires `details`: structured data for the UI and for
 * programmatic callers, never sent to the model. `content` is the model-facing
 * text. Every tool here reports which file (or query) it acted on in details.
 */
function toolResult(text: string, details: Record<string, unknown>, isError = false): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details, isError };
}

/**
 * One line naming what this turn injected, what it turned down, and what that
 * cost — the only way to answer "why did it ignore my proposal-tone file?".
 *
 * Injection scores every file, applies the history bar, keeps the best three,
 * and normally discards the reasoning. Rejection reasons come from
 * admitsToContext(), the same call the injector makes, so the explanation cannot
 * drift from the rule. Read-only, and reached only when debug mode is on.
 */
function describeInjection(opts: {
	coreFiles: string[];
	chosen: Array<{ path: string; score: number }>;
	considered: SearchResult[];
	eligibility: { includeKnowledge: boolean; includeHistory: boolean };
	prompt: string;
	block: string;
	/** Chosen, then withheld by the cap (§3.5). Same share the injector acted on. */
	withheld?: Array<{ path: string; share: number }>;
	policyRejected?: Map<string, string>;
	pathReason?: (rel: string) => string | null;
}): string {
	const { coreFiles, chosen, considered, eligibility, prompt, block, withheld = [], policyRejected = new Map(), pathReason = () => null } = opts;
	const topScore = topEligibleScore(considered.filter((r) => !pathReason(r.path)), eligibility);
	const picked = new Set(chosen.map((c) => c.path));
	// A withheld file is annotated where it was chosen rather than moved to "turned down":
	// it beat the other candidates and the cap stopped it, which are two different facts
	// and only the second one is about ranking.
	const cut = new Map(withheld.map((w) => [w.path, w]));

	let search: string;
	if (chosen.length > 0) {
		search = chosen
			.map((h) => {
				const w = cut.get(h.path);
				return `${shortName(h.path)} ${h.score.toFixed(1)}${w ? ` (not sent: ${Math.round(w.share * 100)} % of it is past the cap)` : ""}`;
			})
			.join(", ");
	} else if (!prompt.trim()) {
		search = "skipped, no prompt (custom run)";
	} else {
		search = `nothing matched "${clip(prompt, 40)}"`;
	}

	const turnedDown = considered
		.filter((r) => !picked.has(r.path))
		.slice(0, 3)
		.map((r) => {
			const verdict = admitsToContext(r.category, r.score, topScore, eligibility);
			return `${shortName(r.path)} ${r.score.toFixed(1)} (${pathReason(r.path) ?? policyRejected.get(r.path) ?? (verdict.admit ? `past top ${MAX_INJECTED_FILES}` : verdict.reason)})`;
		});

	const out = [
		`memory → core: ${coreFiles.length > 0 ? coreFiles.join(", ") : "none"}`,
		`injected: ${search}`,
	];
	if (turnedDown.length > 0) out.push(`turned down: ${turnedDown.join(", ")}`);
	out.push(`${block.split("\n").length} lines, ${block.length} chars`);
	return out.join(" | ");
}

/** Bank path shortened for one-line display, keeping the identifying part. */
function shortName(relPath: string): string {
	return relPath.replace(/^knowledge\//, "").replace(/^history\/daily\/\d{4}-\d{2}\//, "");
}

/** Trim for display, marking that it was trimmed. */
function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}
