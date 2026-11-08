/**
 * What the extension did with the prompts that actually arrived.
 *
 * The eval fixtures are questions I invented. They can tell me whether a change broke
 * something; only real prompts tell me what to build next. Each event is one JSON line:
 * the prompt as it arrived, the candidates the scorer looked at, what went in, and the
 * reason each rejected file was rejected — enough to rebuild the case as a fixture.
 *
 * Off by default. A log of prompts is a log of whatever the user was working on, so it
 * is opt-in, it is inside the bank the user can delete, and `logPrompts: false` keeps the
 * text out while keeping the decisions.
 *
 * Lines are kept small on purpose: a prompt is clipped and at most six candidates are
 * listed, so one event is well under a page. Sessions share this file, and an append is
 * one write() — small lines are what stop two processes writing one line.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { LOG_DIR, patchConfigFile, readConfigFile } from "./bank.js";
import { contentTerms } from "./search.js";

export interface LogConfig {

	enabled: boolean;
	/** false keeps prompt and query text out of the file, and keeps the decisions. */
	prompts: boolean;
}

/** Past this, stop writing rather than fill a disk in silence. */
export const LOG_CAP_BYTES = 5 * 1024 * 1024;
/** Prompt text is clipped to this many characters; the decisions are logged in full. */
export const LOG_PROMPT_CHARS = 300;

export function loadLogConfig(): LogConfig {
	const raw = readConfigFile();
	return { enabled: raw.log === true, prompts: raw.logPrompts !== false };
}

export function saveLogConfig(next: Partial<LogConfig>): LogConfig {
	const merged = { ...loadLogConfig(), ...next };
	patchConfigFile({ log: merged.enabled, logPrompts: merged.prompts });
	return merged;
}

/** One file per month, so a month of logs can be moved or deleted on its own. */
export function logFilePath(now = new Date()): string {
	return path.join(LOG_DIR, `usage-${now.toISOString().slice(0, 7)}.jsonl`);
}

/**
 * Which process wrote this line, and the only way to change it.
 *
 * Two sessions append to one monthly file, so "did the last prompt get the same thing
 * twice" is only answerable if a reader can tell whose neighbour it is. Short, not
 * unique: enough to keep two open sessions from being read as one conversation, and
 * reset at session start because a new session has no memory of the last one either.
 */
let currentSession = randomUUID();
export function sessionId(): string { return currentSession; }
export function startSession(): string { currentSession = randomUUID(); return currentSession; }

/** First 8 hex digits of a string, enough to tell "this text repeated" from "it did not". */
export function shortHash(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
	return h.toString(16).padStart(8, "0");
}

/** Append one event. Never throws: a log that can break a turn is not a log. */
export function logEvent(
	cfg: LogConfig,
	event: Record<string, unknown>,
	ts = new Date(),
): { written: boolean; reason: string } {
	if (!cfg.enabled) return { written: false, reason: "log off" };
	const file = logFilePath(ts);
	try {
		const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
		if (bytes > LOG_CAP_BYTES) {
			return { written: false, reason: `log is over ${LOG_CAP_BYTES} bytes: ${file}` };
		}
		fs.mkdirSync(LOG_DIR, { recursive: true });
		fs.appendFileSync(file, JSON.stringify({ ts: ts.toISOString(), ...event }) + "\n");
		return { written: true, reason: file };
	} catch (err) {
		return { written: false, reason: err instanceof Error ? err.message : String(err) };
	}
}

export function logStatus(cfg: LogConfig): { enabled: boolean; prompts: boolean; file: string; bytes: number; atCap: boolean } {
	const file = logFilePath();
	let bytes = 0;
	try {
		bytes = fs.statSync(file).size;
	} catch {}
	return { enabled: cfg.enabled, prompts: cfg.prompts, file, bytes, atCap: bytes > LOG_CAP_BYTES };
}

/** What one log file says about cost, on top of the plain counts. */
export interface LogCost {
	/** Inject lines carrying `ch`/`cc`, the only ones a repeat can be measured on. */
	measured: number;
	/** Older lines, which have no hash to compare. Reported so a fresh log is honest. */
	legacy: number;
	/** Consecutive lines from one process that re-sent the same core, and what it cost. */
	coreRepeated: number;
	coreRepeatedChars: number;
	/** Consecutive lines from one process whose knowledge set was the same set. */
	knowledgeRepeated: number;
	knowledgeRepeatedChars: number;
	/** Files admitted as pointers instead of bodies, and the characters that saved. */
	pointers: number;
	pointerChars: number;
	/** Characters §3.2's cap kept out of the prompts, across the whole file. */
	cutChars: number;
	/** §3.5: files the cap left out by name, and what they would have cost. */
	withheld: number;
	withheldChars: number;
	/**
	 * What one prompt paid for knowledge and history, at p50 and p75: the number a total
	 * budget would be sized from, and the one `npm run measure` cannot give, because it
	 * dedups retried prompts (docs/rl-port-plan.md §0.1).
	 */
	knowledgeCharsP50: number | null;
	knowledgeCharsP75: number | null;
	/** Injected files, and how many of them scored nothing at all. */
	slots: number;
	slotsZero: number;
	slotsUnderFive: number;
	/**
	 * Score per distinct content term, for the second and third file only: the numbers a
	 * relevance floor is chosen against (absolute score has no scale — it multiplies with
	 * query length, so a raw 39 was 176 in a bigger bank).
	 */
	normTailP50: number | null;
	/** Tail slots that had prompt text to normalize — the denominator of the above. */
	normSamples: number;
	/** Tail slots that did not, because prompt logging was off. */
	normUnavailable: number;
}

/** Nearest-rank percentile, so p50 of four values is the second and p75 the third. */
function percentile(values: number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Read the log back as counts. Malformed lines are skipped and counted. */
export function summarizeLog(file: string): {
	events: number;
	broken: number;
	byType: Record<string, number>;
	injectedNothing: number;
	/** Inject bytes that a previous prompt of the same session already paid for. */
	cost: LogCost;
	prompts: string[];
	files: Array<{ path: string; times: number }>;
} {
	const out = {
		events: 0,
		broken: 0,
		byType: {} as Record<string, number>,
		injectedNothing: 0,
		cost: {
			measured: 0,
			legacy: 0,
			coreRepeated: 0,
			coreRepeatedChars: 0,
			knowledgeRepeated: 0,
			knowledgeRepeatedChars: 0,
			pointers: 0,
			pointerChars: 0,
			cutChars: 0,
			withheld: 0,
			withheldChars: 0,
			knowledgeCharsP50: null as number | null,
			knowledgeCharsP75: null as number | null,
			slots: 0,
			slotsZero: 0,
			slotsUnderFive: 0,
			normTailP50: null as number | null,
			normSamples: 0,
			normUnavailable: 0,
		},
		prompts: [] as string[],
		files: [] as Array<{ path: string; times: number }>,
	};
	let raw = "";
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return out;
	}
	const seenFiles = new Map<string, number>();
	// Per process, because two sessions append to one file and a line from the other one
	// is not "the previous prompt".
	const lastByProcess = new Map<string, { hash: string; files: string }>();
	const normTail: number[] = [];
	// Per-prompt cost of the non-core part of the block, over the lines that report a core size.
	const knowledgeChars: number[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			out.broken++;
			continue;
		}
		out.events++;
		out.byType[ev.t] = (out.byType[ev.t] ?? 0) + 1;
		if ((ev.t === "reset" || ev.t === "session") && typeof ev.sid === "string") lastByProcess.delete(ev.sid);
		if (ev.t === "inject") {
			const hits = Array.isArray(ev.in) ? ev.in : [];
			if (hits.length === 0) out.injectedNothing++;
			for (const hit of hits) seenFiles.set(hit.f, (seenFiles.get(hit.f) ?? 0) + 1);
			if (typeof ev.p === "string" && ev.p && ev.p !== "[redacted]") out.prompts.push(ev.p);

			for (let i = 0; i < hits.length; i++) {
				out.cost.slots++;
				if (hits[i].s === 0) out.cost.slotsZero++;
				if (hits[i].s < 5) out.cost.slotsUnderFive++;
				if (i === 0) continue;
				// Normalized score needs the words the prompt actually asked with, and a
				// redacted prompt has none. Count those instead of guessing a term count.
				const terms = typeof ev.qt === "number" && Number.isFinite(ev.qt) ? ev.qt :
					typeof ev.p === "string" && ev.p !== "[redacted]" ? new Set(contentTerms(ev.p)).size : 0;
				if (terms > 0) {
					normTail.push(hits[i].s / terms);
					out.cost.normSamples++;
				} else {
					out.cost.normUnavailable++;
				}
			}

			if (typeof ev.ch !== "string" || typeof ev.cc !== "number") {
				out.cost.legacy++;
				continue;
			}
			out.cost.cutChars += typeof ev.cu === "number" ? ev.cu : 0;
			// §3.5. A line written before the rule existed reports neither field, which sums
			// to zero — the honest reading of "this log has no evidence about it either way".
			if (typeof ev.wc === "number") out.cost.withheld += ev.wc;
			if (typeof ev.wch === "number") out.cost.withheldChars += ev.wch;
			out.cost.pointers += typeof ev.pt === "number" ? ev.pt : 0;
			out.cost.pointerChars += typeof ev.sv === "number" ? ev.sv : 0;
			out.cost.measured++;
			knowledgeChars.push(Math.max(0, (ev.chars ?? 0) - ev.cc));
			const proc = typeof ev.sid === "string" ? ev.sid : "one";
			const fileList = hits.map((h: { f: string }) => h.f).sort().join(",");
			const prev = lastByProcess.get(proc);
			if (prev) {
				const knChars = Math.max(0, (ev.chars ?? 0) - ev.cc);
				if (prev.hash === ev.ch) {
					out.cost.coreRepeated++;
					out.cost.coreRepeatedChars += ev.cc;
				}
				if (prev.files === fileList && fileList !== "") {
					out.cost.knowledgeRepeated++;
					out.cost.knowledgeRepeatedChars += knChars;
				}
			}
			lastByProcess.set(proc, { hash: ev.ch, files: fileList });
		}
	}
	out.files = [...seenFiles.entries()]
		.map(([p, times]) => ({ path: p, times }))
		.sort((a, b) => b.times - a.times)
		.slice(0, 5);
	if (normTail.length > 0) {
		normTail.sort((a, b) => a - b);
		out.cost.normTailP50 = Math.round(normTail[Math.floor(normTail.length / 2)] * 10) / 10;
	}
	out.cost.knowledgeCharsP50 = percentile(knowledgeChars, 50);
	out.cost.knowledgeCharsP75 = percentile(knowledgeChars, 75);
	return out;
}
