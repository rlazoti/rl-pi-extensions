/**
 * Migration (R37-R40): the old bank becomes claims, a human at a time.
 *
 * The order is not cosmetic. A backup that has been listed back gates every other
 * step. Waves are reviewed in the order they matter: rules and preferences
 * first, because those are what the injector injects every turn; then facts a
 * domain at a time. A migrated claim is pending until Rodrigo approves it, and a
 * pending migrated claim is never injected (D9) — so the trial is measured on the
 * old bank's knowledge only after it has been through a human.
 *
 * The drafting itself is done by the agent in the session, one source file per
 * turn: `/memory migrate next` hands over one file's legacy entries plus the
 * instructions, and the agent calls `memory_propose` for each claim. The
 * extension keeps the progress, so the step can be stopped and resumed, and it
 * never edits a source file until cutover (R39).
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { appendDatedItems, type DailySection } from "./daily.js";
import { detectStatus, gatePropose } from "./gate.js";
import { type Claim } from "./grammar.js";
import { propose } from "./queue.js";
import { archiveFile, markdownFiles, readFileOrNull, readJson, type BankPaths, writeJson } from "./store.js";
import { dayOf, type Clock, systemClock } from "./time.js";

export const STATE_VERSION = 1;

export interface MigrationFile {
	/** Bank-relative path, e.g. `knowledge/git-standards.md`. */
	file: string;
	wave: string;
	entries: number;
	status: "todo" | "drafted" | "archived";
	proposals: number;
	note?: string;
}

export interface MigrationState {
	version: number;
	backup?: { file: string; verifiedAt: string; entries: number };
	waves: string[];
	files: Record<string, MigrationFile>;
	updatedAt: string;
}

export function migrationStateFile(paths: BankPaths): string {
	return join(paths.migration, "state.json");
}

export function readState(paths: BankPaths): MigrationState | undefined {
	const state = readJson<Partial<MigrationState>>(migrationStateFile(paths));
	if (state === undefined) return undefined;
	if (typeof state.files !== "object" || state.files === null || state.version !== STATE_VERSION) return undefined;
	return { version: STATE_VERSION, backup: state.backup, waves: state.waves ?? [], files: state.files as Record<string, MigrationFile>, updatedAt: state.updatedAt ?? "" };
}

export function writeState(paths: BankPaths, state: MigrationState): void {
	writeJson(migrationStateFile(paths), state);
}

/** Every step except the backup itself refuses to run without a verified backup (R37). */
export function requireBackup(state: MigrationState | undefined): string | undefined {
	if (!state?.backup) return "no verified backup: run /memory migrate backup first (R37)";
	return undefined;
}

// ── The legacy store format ───────────────────────────────────────────────
//
// The bank the previous extension wrote is a different grammar: metadata as
// "- field: value" bullets, a `status` field instead of a `state` one, bodies
// that may hold markdown lists and code fences. Nothing else in this component
// reads it — the migration reader does, and only for migration.

export interface LegacyEntry {
	key: string;
	fields: Record<string, string>;
	body: string;
	line: number;
}

export interface LegacyStore {
	file: string;
	entries: LegacyEntry[];
}

const LEGACY_HEADING = /^##\s+([^\s@]+)(?:@(\d{4}-\d{2}-\d{2}))?\s*$/;
const LEGACY_FIELD = /^-\s*([A-Za-z][A-Za-z0-9]*):\s*(.*)$/;

export function parseLegacyStore(text: string, file: string): LegacyStore {
	const lines = text.split("\n");
	const headings: number[] = [];
	for (let i = 0; i < lines.length; i++) if (LEGACY_HEADING.test(lines[i]!)) headings.push(i);
	const entries: LegacyEntry[] = [];
	for (let index = 0; index < headings.length; index++) {
		const start = headings[index]!;
		const end = index + 1 < headings.length ? headings[index + 1]! : lines.length;
		const match = LEGACY_HEADING.exec(lines[start]!)!;
		const fields: Record<string, string> = {};
		let cursor = start + 1;
		for (; cursor < end; cursor++) {
			const line = lines[cursor]!;
			if (line.trim() === "") {
				cursor++;
				break;
			}
			const field = LEGACY_FIELD.exec(line);
			if (field) fields[field[1]!] = field[2] ?? "";
		}
		entries.push({ key: match[1]!, fields, body: lines.slice(cursor, end).join("\n").trim(), line: start + 1 });
	}
	return { file, entries };
}

/** The kinds the old store used, mapped to the two this one has (R1). */
export function legacyKind(entry: LegacyEntry): "rule" | "fact" {
	const kind = (entry.fields.kind ?? "").toLowerCase();
	if (kind === "rule" || kind === "preference" || kind === "decision" || kind === "procedure") return "rule";
	return "fact";
}

/** A retired old entry is not worth a proposal: it goes to the archive. */
export function legacyIsRetired(entry: LegacyEntry): boolean {
	const status = (entry.fields.status ?? "active").toLowerCase();
	return status !== "active";
}

/**
 * Open work in the old working-state file. "In Progress" items become carry:
 * they are work that follows the day over, which is exactly what the new daily
 * log's carry section is for.
 */
export interface LegacyItem {
	section: "carry" | "completed" | "decision" | "note";
	text: string;
	day?: string;
}

const SECTION_LINE = /^##\s+(.+?)\s*$/;
const DATED_ITEM = /^-\s*\((\d{4}-\d{2}-\d{2})\)\s*(.+)$/;

export function legacyDailyItems(text: string): LegacyItem[] {
	const items: LegacyItem[] = [];
	let section: LegacyItem["section"] = "carry";
	let seenHeading = false;
	for (const line of text.split("\n")) {
		const heading = SECTION_LINE.exec(line);
		if (heading) {
			seenHeading = true;
			const name = heading[1]!.toLowerCase();
			if (name.includes("complete")) section = "completed";
			else if (name.includes("decision")) section = "decision";
			else if (name.includes("note")) section = "note";
			else section = "carry";
			continue;
		}
		const trimmed = line.trim();
		if (!trimmed.startsWith("- ")) continue;
		// Above the first section, a bullet in that file is metadata ("- date:",
		// "- carried from:"), not an item of work.
		if (!seenHeading) continue;
		const dated = DATED_ITEM.exec(trimmed);
		if (dated) items.push({ section, text: dated[2]!, day: dated[1] });
		else items.push({ section, text: trimmed.slice(2).trim() });
	}
	return items.filter((item) => item.text !== "");
}

// ── Planning and progress ─────────────────────────────────────────────────

export interface PlanResult {
	state: MigrationState;
	sources: string[];
	unreadable: { file: string; error: string }[];
	retired: string[];
}

/**
 * Build the wave list from the files that are actually there — never from a
 * remembered count, because a hardcoded count is a number that quietly goes
 * wrong the day a file is added.
 */
export function planMigration(paths: BankPaths, opts: { clock?: Clock } = {}): PlanResult {
	const clock = opts.clock ?? systemClock;
	const sources: string[] = [];
	const unreadable: { file: string; error: string }[] = [];
	const retired: string[] = [];
	const files: Record<string, MigrationFile> = {};
	const ruleWave = "rules";
	const factWaves: string[] = [];

	const legacyDir = join(paths.root, "knowledge");
	for (const file of markdownFiles(legacyDir)) {
		const relative = file.slice(paths.root.length + 1);
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (error) {
			unreadable.push({ file: relative, error: error instanceof Error ? error.message : String(error) });
			continue;
		}
		const store = parseLegacyStore(text, relative);
		if (store.entries.length === 0) {
			// Nothing keyed: prose. It goes to the archive, not to a proposal.
			files[relative] = { file: relative, wave: "prose", entries: 0, status: "todo", proposals: 0, note: "no keyed entries: archive it as read-only prose" };
			continue;
		}
		const rules = store.entries.filter((entry) => legacyKind(entry) === "rule" && !legacyIsRetired(entry));
		const facts = store.entries.filter((entry) => legacyKind(entry) === "fact" && !legacyIsRetired(entry));
		const live = store.entries.filter((entry) => !legacyIsRetired(entry));
		for (const entry of store.entries) if (legacyIsRetired(entry)) retired.push(`${relative}:${entry.key}`);
		// A file that holds both rules and facts is drafted in the rules wave, and
		// says so: the agent drafting it must propose both, not just the first kind.
		if (rules.length > 0) files[relative] = { file: relative, wave: ruleWave, entries: live.length, status: "todo", proposals: 0, note: facts.length > 0 ? `${rules.length} ${rules.length === 1 ? "rule" : "rules"} and ${facts.length} ${facts.length === 1 ? "fact" : "facts"} in one file` : undefined };
		else if (facts.length > 0) {
			const domain = relative.replace(/^knowledge\//, "").replace(/\.md$/, "");
			files[relative] = { file: relative, wave: `facts:${domain}`, entries: facts.length, status: "todo", proposals: 0 };
			if (!factWaves.includes(`facts:${domain}`)) factWaves.push(`facts:${domain}`);
		} else {
			files[relative] = { file: relative, wave: "archive", entries: store.entries.length, status: "todo", proposals: 0, note: "every entry is retired: archive it" };
		}
		sources.push(relative);
	}

	const coreDir = join(paths.root, "core");
	for (const file of markdownFiles(coreDir)) {
		const relative = file.slice(paths.root.length + 1);
		files[relative] = { file: relative, wave: "daily", entries: 0, status: "todo", proposals: 0, note: "working state: its open items become daily-log items" };
		sources.push(relative);
	}

	const waves = [ruleWave, ...factWaves, "daily", "prose", "archive"].filter((wave) => Object.values(files).some((entry) => entry.wave === wave));
	const state: MigrationState = { version: STATE_VERSION, backup: readState(paths)?.backup, waves, files, updatedAt: dayOf(clock()) };
	return { state, sources, unreadable, retired };
}

export function savePlan(paths: BankPaths, planned: PlanResult): MigrationState {
	const existing = readState(paths);
	const merged: MigrationState = {
		version: STATE_VERSION,
		backup: existing?.backup,
		waves: planned.state.waves,
		files: { ...planned.state.files, ...(existing?.files ?? {}) },
		updatedAt: planned.state.updatedAt,
	};
	// A file the plan knows about but the state has already progressed keeps its
	// progress: re-planning must not undo reviewed work.
	for (const [name, entry] of Object.entries(merged.files)) {
		const before = existing?.files[name];
		if (before && before.status !== "todo") merged.files[name] = { ...entry, status: before.status, proposals: before.proposals };
	}
	writeState(paths, merged);
	return merged;
}

export interface DraftBrief {
	file: string;
	wave: string;
	instructions: string;
	entries: LegacyEntry[];
	retired: string[];
}

/** The files still to draft, in the plan's wave order (rules first, then a domain at a time). */
export interface TodoFile {
	file: string;
	wave: string;
	entries: number;
}

function todoQueue(state: MigrationState, opts: { wave?: string; file?: string } = {}): TodoFile[] {
	const waveRank = new Map(state.waves.map((wave, index) => [wave, index]));
	const rankOf = (wave: string): number => waveRank.get(wave) ?? waveRank.size;
	const wanted = opts.file === undefined ? undefined : opts.file.replace(/^\.?\/?/, "");
	const todos = Object.values(state.files)
		.filter(
			(entry) =>
				entry.status === "todo" &&
				(opts.wave === undefined || entry.wave === opts.wave) &&
				(wanted === undefined || entry.file === wanted || entry.file.endsWith(`/${wanted}`) || basename(entry.file, ".md") === basename(wanted, ".md")),
		)
		// Wave order is the plan's order — rules first, then facts a domain at a
		// time — not an alphabetical accident.
		.sort((a, b) => rankOf(a.wave) - rankOf(b.wave) || a.file.localeCompare(b.file))
		.map((entry) => ({ file: entry.file, wave: entry.wave, entries: entry.entries }));
	return todos;
}

function briefFor(paths: BankPaths, todo: TodoFile): DraftBrief | { done: true; reason: string } {
	const absolute = join(paths.root, todo.file);
	const instructions = [
		`Source: ${todo.file} (wave ${todo.wave}, ${todo.entries} claim${todo.entries === 1 ? "" : "s"} to draft).`,
		"For each entry below, decide whether it is still true.",
		'- Write a rule or a fact with memory_propose: kind rule | fact, scope global | project:<id> | path:<glob>, asOf the date the claim became true (the old entry\'s asOf, not today), source "migrated from ' + todo.file + '", tags (add "always" only to a rule that must be injected every turn), and origin migration.',
		"- One claim per call, body at most 600 characters, no status text (no SHAs, PR numbers, run links or dated verbs) — status goes to memory_log.",
		"- Anything that is only status, or a note about a decision that no longer stands, goes to memory_archive instead of a claim.",
		"When the file is drafted, record it: /memory migrate drafted " + todo.file,
	].join("\n");

	if (!absolute.startsWith(paths.root)) return { done: true, reason: `${todo.file} is not inside the bank` };
	let entries: LegacyEntry[] = [];
	let retired: string[] = [];
	const text = (() => {
		try {
			return readFileSync(absolute, "utf8");
		} catch {
			return undefined;
		}
	})();
	if (text !== undefined) {
		const store = parseLegacyStore(text, todo.file);
		entries = store.entries.filter((entry) => !legacyIsRetired(entry));
		retired = store.entries.filter(legacyIsRetired).map((entry) => `${entry.key} (${entry.fields.status ?? "?"})`);
	}
	return { file: todo.file, wave: todo.wave, instructions, entries, retired };
}

/** The next file to draft (or a named one), or the reason there is none. */
export function nextDraft(paths: BankPaths, opts: { wave?: string; file?: string } = {}): DraftBrief | { done: true; reason: string } {
	const state = readState(paths);
	const blocked = requireBackup(state);
	if (blocked) return { done: true, reason: blocked };
	if (state === undefined) return { done: true, reason: "no migration plan: run /memory migrate plan first" };
	const [first] = todoQueue(state, opts);
	if (!first) {
		if (opts.file !== undefined) return { done: true, reason: `${opts.file} is not a file waiting to be drafted (already drafted, not planned, or in another wave)` };
		return { done: true, reason: opts.wave ? `nothing left in wave ${opts.wave}` : "every source file has been drafted" };
	}
	return briefFor(paths, first);
}

/** R38 `--batch <n>`: the next few files of a wave, so a turn can cover a batch. */
export function draftQueue(paths: BankPaths, opts: { wave?: string; batch?: number } = {}): TodoFile[] | { done: true; reason: string } {
	const state = readState(paths);
	const blocked = requireBackup(state);
	if (blocked) return { done: true, reason: blocked };
	if (state === undefined) return { done: true, reason: "no migration plan: run /memory migrate plan first" };
	const queue = todoQueue(state, { wave: opts.wave });
	if (queue.length === 0) return { done: true, reason: opts.wave ? `nothing left in wave ${opts.wave}` : "every source file has been drafted" };
	const batch = opts.batch === undefined || opts.batch < 1 ? 1 : opts.batch;
	return queue.slice(0, batch);
}

/**
 * Draft a whole wave in one pass: every live entry in every file of the wave
 * becomes a pending claim with `origin: migration`, through the same gate a
 * hand-written proposal passes. The text is carried over verbatim — the judgment
 * is left where the spec puts it, with Rodrigo at review — and anything the gate
 * refuses is reported with its reason rather than quietly kept.
 *
 * This is the fast path for a big bank. Rewriting an entry into a tighter claim
 * stays available (`/memory migrate draft` hands the file over for that), and a
 * claim still never injects until it is approved (D9).
 */
export function applyMigration(
	paths: BankPaths,
	opts: { wave?: string; all?: boolean; clock?: Clock } = {},
): { proposed: { file: string; key: string }[]; refused: { file: string; key: string; problem: string }[]; files: string[]; wave: string } | { done: true; reason: string } {
	const clock = opts.clock ?? systemClock;
	const state = readState(paths);
	const blocked = requireBackup(state);
	if (blocked) return { done: true, reason: blocked };
	if (state === undefined) return { done: true, reason: "no migration plan: run /memory migrate plan first" };

	const queue = todoQueue(state, { wave: opts.wave }).filter((todo) => todo.wave !== "daily");
	if (queue.length === 0) return { done: true, reason: opts.wave ? `nothing left in wave ${opts.wave}` : "every claim file has been drafted" };
	const wanted = opts.all ? queue : queue.filter((todo) => todo.wave === queue[0]!.wave);

	const proposed: { file: string; key: string }[] = [];
	const refused: { file: string; key: string; problem: string }[] = [];
	const today = dayOf(clock());

	for (const todo of wanted) {
		const text = readFileOrNull(join(paths.root, todo.file));
		if (text === undefined) {
			refused.push({ file: todo.file, key: "(file)", problem: "the source file cannot be read" });
			continue;
		}
		let count = 0;
		for (const entry of parseLegacyStore(text, todo.file).entries) {
			if (legacyIsRetired(entry)) {
				refused.push({ file: todo.file, key: entry.key, problem: `retired (${entry.fields.status ?? "?"}): archive it, do not propose it` });
				continue;
			}
			const draft: Claim = {
				key: entry.key,
				kind: legacyKind(entry),
				scope: entry.fields.scope ?? "global",
				asOf: entry.fields.asOf ?? "",
				source: `migrated from ${todo.file}${entry.fields.source ? ` (originally: ${entry.fields.source})` : ""}`,
				body: entry.body,
				aliases: splitList(entry.fields.aliases),
				tags: splitList(entry.fields.tags),
				links: splitList(entry.fields.links),
				origin: "migration",
				state: "pending",
				proposedAt: today,
			};
			const gate = gatePropose({ claim: draft });
			if (!gate.ok) {
				refused.push({ file: todo.file, key: entry.key, problem: gate.problems.join("; ") });
				continue;
			}
			propose(paths, gate.claim, today);
			proposed.push({ file: todo.file, key: entry.key });
			count++;
		}
		const tracked = state.files[todo.file];
		if (tracked) {
			tracked.status = "drafted";
			tracked.proposals = count;
			tracked.note = `applied: ${count} claim(s) proposed`;
		}
	}

	state.updatedAt = today;
	writeState(paths, state);
	return { proposed, refused, files: wanted.map((todo) => todo.file), wave: wanted[0]!.wave };
}

function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(/[;,]/)
		.map((part) => part.trim())
		.filter((part) => part !== "");
}

/**
 * The working-state wave: the open items in a daily-context file become dated
 * items in today's log, with their original dates. A file that is project status
 * instead (release state, SHAs, tool lists) gets nothing: projects live outside
 * memory (R2), and its text is status the store refuses to keep as a claim.
 * Status-bearing items are reported and left out, never silently dropped.
 */
export function migrateDailyItems(
	paths: BankPaths,
	opts: { clock?: Clock } = {},
): { dailyFile: string; converted: { file: string; added: number; skipped: number }[]; statusOnly: { file: string; items: number }[]; refused: { file: string; item: string }[]; total: number } | { done: true; reason: string } {
	const clock = opts.clock ?? systemClock;
	const state = readState(paths);
	const blocked = requireBackup(state);
	if (blocked) return { done: true, reason: blocked };
	if (state === undefined) return { done: true, reason: "no migration plan: run /memory migrate plan first" };

	const converted: { file: string; added: number; skipped: number }[] = [];
	const statusOnly: { file: string; items: number }[] = [];
	const refused: { file: string; item: string }[] = [];
	let total = 0;
	let dailyFile = "";

	for (const entry of Object.values(state.files)) {
		if (entry.wave !== "daily") continue;
		const text = readFileOrNull(join(paths.root, entry.file));
		if (text === undefined) continue;
		const items = legacyDailyItems(text);
		if (!/daily/i.test(basename(entry.file))) {
			statusOnly.push({ file: entry.file, items: items.length });
			entry.status = "drafted";
			entry.proposals = 0;
			entry.note = "project status, not memory (R2): nothing carried; the file is archived at cutover";
			continue;
		}
		const clean: { section: DailySection; text: string; day?: string }[] = [];
		for (const item of items) {
			if (detectStatus(item.text).length > 0) {
				refused.push({ file: entry.file, item: item.text.slice(0, 120) });
				continue;
			}
			clean.push(item);
		}
		const result = appendDatedItems(paths, clean, dayOf(clock()));
		dailyFile = result.file;
		converted.push({ file: entry.file, added: result.added, skipped: result.skipped });
		total += result.added;
		entry.status = "drafted";
		entry.proposals = 0;
		entry.note = `${result.added} open item(s) carried into daily/today.md${refused.length > 0 ? `, ${refused.length} status item(s) left out` : ""}`;
	}

	state.updatedAt = dayOf(clock());
	writeState(paths, state);
	return { dailyFile, converted, statusOnly, refused, total };
}


export interface Progress {
	total: number;
	todo: number;
	drafted: number;
	archived: number;
	byWave: { wave: string; total: number; done: number }[];
	backup?: { file: string; verifiedAt: string; entries: number };
}

export function migrationProgress(paths: BankPaths): Progress {
	const state = readState(paths);
	const files = Object.values(state?.files ?? {});
	const byWave = new Map<string, { total: number; done: number }>();
	for (const entry of files) {
		const bucket = byWave.get(entry.wave) ?? { total: 0, done: 0 };
		bucket.total++;
		if (entry.status !== "todo") bucket.done++;
		byWave.set(entry.wave, bucket);
	}
	return {
		total: files.length,
		todo: files.filter((entry) => entry.status === "todo").length,
		drafted: files.filter((entry) => entry.status === "drafted").length,
		archived: files.filter((entry) => entry.status === "archived").length,
		byWave: [...byWave.entries()].map(([wave, bucket]) => ({ wave, ...bucket })),
		backup: state?.backup,
	};
}

export function markDrafted(paths: BankPaths, file: string, proposals: number, clock: Clock = systemClock): { ok: true; file: string } | { ok: false; problem: string } {
	const state = readState(paths);
	const blocked = requireBackup(state);
	if (blocked) return { ok: false, problem: blocked };
	const entry = state!.files[file];
	if (!entry) return { ok: false, problem: `no such migration file: ${file} (try /memory migrate status)` };
	if (entry.status === "archived") return { ok: false, problem: `${file} is already archived` };
	entry.status = "drafted";
	entry.proposals = Math.max(0, Math.trunc(proposals));
	state!.updatedAt = dayOf(clock());
	writeState(paths, state!);
	return { ok: true, file };
}

/**
 * Cutover (R39, R40): source files move to the read-only archive, never deleted.
 * Refused while any source is undrafted — a half-migrated bank with the old
 * sources gone is the one state this tool must not create.
 */
export function cutoverSources(paths: BankPaths, clock: Clock = systemClock): { ok: true; archived: string[]; skipped: string[] } | { ok: false; problem: string } {
	const state = readState(paths);
	const blocked = requireBackup(state);
	if (blocked) return { ok: false, problem: blocked };
	const undrafted = Object.values(state!.files).filter((entry) => entry.status === "todo");
	if (undrafted.length > 0) {
		return { ok: false, problem: `${undrafted.length} source files have not been drafted (${undrafted.slice(0, 3).map((entry) => entry.file).join(", ")}${undrafted.length > 3 ? ", …" : ""}); cutover would leave them unreachable` };
	}
	const archived: string[] = [];
	const skipped: string[] = [];
	for (const entry of Object.values(state!.files)) {
		const absolute = join(paths.root, entry.file);
		if (!existsSync(absolute)) {
			skipped.push(entry.file);
			continue;
		}
		archiveFile(paths, absolute);
		entry.status = "archived";
		archived.push(entry.file);
	}
	state!.updatedAt = dayOf(clock());
	writeState(paths, state!);
	return { ok: true, archived, skipped };
}

export function recordBackup(paths: BankPaths, backup: { file: string; entries: number }, clock: Clock = systemClock): MigrationState {
	const state = readState(paths) ?? { version: STATE_VERSION, waves: [], files: {}, updatedAt: dayOf(clock()) };
	state.backup = { file: backup.file, verifiedAt: dayOf(clock()), entries: backup.entries };
	state.updatedAt = dayOf(clock());
	writeState(paths, state);
	return state;
}

export function formatMigrationProgress(progress: Progress): string {
	const lines = [
		`Migration: ${progress.drafted} drafted, ${progress.archived} archived, ${progress.todo} still to draft, of ${progress.total} source files`,
		...progress.byWave.map((bucket) => `  ${bucket.wave}: ${bucket.done}/${bucket.total}`),
	];
	lines.push(progress.backup ? `  backup: ${progress.backup.file} (verified ${progress.backup.verifiedAt}, ${progress.backup.entries} files)` : "  backup: none — every migration step refuses until /memory migrate backup runs");
	return lines.join("\n");
}
