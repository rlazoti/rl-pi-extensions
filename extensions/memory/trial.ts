/**
 * The trial (R43-R47): is this extension better, measured?
 *
 * Every injected turn appends one line to `metrics/turns.jsonl`. No prompt text
 * is stored: the trial measures size, not content.
 *
 * The baseline is not a guess. `/memory trial baseline` replays the last 14 days
 * of Pi session files, finds the block the *previous* extension injected, counts
 * it with the same estimator the injector uses, and writes the median. If the
 * block is not found the command says so and writes nothing — an invented
 * baseline would make the go/no-go decision fiction (R47).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { daysBetween, dayOf, systemClock, type Clock } from "./time.js";
import { readJson, writeJson, type BankPaths } from "./store.js";
import { tokensOf } from "./inject.js";

export const BASELINE_MARKER = "# Memory Bank Context";

export interface TurnMetric {
	/** Local ISO-ish stamp: `YYYY-MM-DD HH:MM:SS`. */
	at: string;
	day: string;
	tokens: { core: number; daily: number; retrieved: number; total: number };
	dropped: { claims: number; dailyItems: number };
	/** Status-check overrides recorded in this session so far (R24, R43). */
	overrides: number;
	session: string;
}

export interface FlagRecord {
	at: string;
	day: string;
	key: string;
	kind: "stale" | "rival";
	/** The claim as it was injected, so a flag can be checked against the store. */
	claim: string;
	scope: string;
	session: string;
}

export interface Baseline {
	medianTokens: number;
	samples: number;
	from: string;
	to: string;
	marker: string;
	generatedAt: string;
	estimated: false;
}

export function turnsFile(paths: BankPaths): string {
	return join(paths.metrics, "turns.jsonl");
}

export function flagsFile(paths: BankPaths): string {
	return join(paths.metrics, "flags.jsonl");
}

export function baselineFile(paths: BankPaths): string {
	return join(paths.metrics, "baseline.json");
}

function stamp(clock: Clock): { at: string; day: string } {
	const now = clock();
	const time = `${now.toTimeString().slice(0, 8)}`;
	return { at: `${dayOf(now)} ${time}`, day: dayOf(now) };
}

/** One metric line per injected turn (R43). */
export function appendTurn(paths: BankPaths, metric: Omit<TurnMetric, "at" | "day">, clock: Clock = systemClock): TurnMetric {
	if (!existsSync(paths.metrics)) mkdirSync(paths.metrics, { recursive: true });
	const { at, day } = stamp(clock);
	const full: TurnMetric = { at, day, ...metric };
	writeFileSync(turnsFile(paths), `${JSON.stringify(full)}\n`, { flag: "a" });
	return full;
}

export function readTurns(paths: BankPaths, opts: { sinceDay?: string } = {}): TurnMetric[] {
	const text = readOrNull(turnsFile(paths));
	if (text === undefined) return [];
	const turns: TurnMetric[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (line.trim() === "") continue;
		void index;
		try {
			const parsed = JSON.parse(line) as TurnMetric;
			if (opts.sinceDay && parsed.day < opts.sinceDay) continue;
			turns.push(parsed);
		} catch {
			// A half-written line is damage, and `corruptTurnLines` counts it.
			continue;
		}
	}
	return turns;
}

export function corruptTurnLines(paths: BankPaths): number {
	const text = readOrNull(turnsFile(paths));
	if (text === undefined) return 0;
	let corrupt = 0;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			JSON.parse(line);
		} catch {
			corrupt++;
		}
	}
	return corrupt;
}

/** `/memory flag <key> stale|rival` (R44). */
export function recordFlag(paths: BankPaths, flag: { key: string; kind: FlagRecord["kind"]; claim: string; scope: string; session: string }, clock: Clock = systemClock): FlagRecord {
	if (flag.kind !== "stale" && flag.kind !== "rival") throw new Error(`flag kind must be stale | rival (got "${flag.kind}")`);
	if (!existsSync(paths.metrics)) mkdirSync(paths.metrics, { recursive: true });
	const { at, day } = stamp(clock);
	const full: FlagRecord = { at, day, ...flag };
	writeFileSync(flagsFile(paths), `${JSON.stringify(full)}\n`, { flag: "a" });
	return full;
}

export function readFlags(paths: BankPaths, opts: { sinceDay?: string } = {}): FlagRecord[] {
	const text = readOrNull(flagsFile(paths));
	if (text === undefined) return [];
	const flags: FlagRecord[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line) as FlagRecord;
			if (opts.sinceDay && parsed.day < opts.sinceDay) continue;
			flags.push(parsed);
		} catch {
			continue;
		}
	}
	return flags;
}

export function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function readOrNull(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

// ── Baseline from Pi session files (R47) ───────────────────────────────────

export interface SessionBlock {
	/** The injected block exactly as the session recorded it. */
	text: string;
	tokens: number;
	session: string;
	day: string;
}

function sessionFiles(dir: string): string[] {
	const out: string[] = [];
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of names) {
		const full = join(dir, name);
		let stat;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		if (stat.isDirectory()) out.push(...sessionFiles(full));
		else if (name.endsWith(".jsonl")) out.push(full);
	}
	return out;
}

function textsOf(entry: Record<string, unknown>): string[] {
	const content = entry.content ?? (entry.message as Record<string, unknown> | undefined)?.content;
	if (typeof content === "string") return [content];
	if (Array.isArray(content)) {
		return content
			.map((block) => (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string" ? ((block as Record<string, unknown>).text as string) : ""))
			.filter((text) => text !== "");
	}
	return [];
}

/**
 * Every injected block in one session file, at most one per user turn.
 *
 * A turn starts at a user message. The extension's block arrives with that turn,
 * and a turn that injected the same block twice (a retry, a re-run) is still one
 * observation, because the trial compares what a turn cost, not how many times
 * the same text was written down.
 */
export function blocksInSession(file: string, marker: string): SessionBlock[] {
	const text = readOrNull(file);
	if (text === undefined) return [];
	const blocks: SessionBlock[] = [];
	let inTurn = false;
	let counted = false;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const message = entry.message as Record<string, unknown> | undefined;
		if (entry.type === "message" && message?.role === "user") {
			inTurn = true;
			counted = false;
		}
		if (!inTurn || counted) continue;
		for (const candidate of textsOf(entry)) {
			if (!candidate.trimStart().startsWith(marker)) continue;
			blocks.push({
				text: candidate,
				tokens: tokensOf(candidate),
				session: String(entry.id ?? file),
				day: typeof entry.timestamp === "string" ? entry.timestamp.slice(0, 10) : "",
			});
			counted = true;
			break;
		}
	}
	return blocks;
}

export interface BaselineResult {
	ok: boolean;
	baseline?: Baseline;
	reason?: string;
	filesScanned: number;
	blocksFound: number;
}

/**
 * The baseline, or an honest report. R47: the marker must actually be found;
 * nothing is estimated when it is not.
 */
export function computeBaseline(opts: {
	paths: BankPaths;
	sessionsDir: string;
	days: number;
	today: string;
	marker?: string;
}): BaselineResult {
	const marker = opts.marker ?? BASELINE_MARKER;
	const fromDay = shiftDay(opts.today, -(opts.days - 1));
	// A session file cannot hold an entry newer than its last write, so an old
	// file is skipped without opening it. The entry timestamps still decide.
	const windowStart = Date.parse(`${fromDay}T00:00:00Z`);
	const files = sessionFiles(opts.sessionsDir).filter((file) => {
		try {
			return statSync(file).mtimeMs >= windowStart;
		} catch {
			return false;
		}
	});
	const blocks: SessionBlock[] = [];
	for (const file of files) {
		for (const block of blocksInSession(file, marker)) {
			if (block.day !== "" && (block.day < fromDay || block.day > opts.today)) continue;
			blocks.push(block);
		}
	}
	if (blocks.length === 0) {
		return {
			ok: false,
			reason: `no block starting "${marker}" was found in ${files.length} session files under ${opts.sessionsDir}. Nothing was written: the baseline has to be measured, not estimated.`,
			filesScanned: files.length,
			blocksFound: 0,
		};
	}
	const days = blocks.map((block) => block.day).filter((day) => day !== "").sort();
	const baseline: Baseline = {
		medianTokens: median(blocks.map((block) => block.tokens)),
		samples: blocks.length,
		from: days[0] ?? fromDay,
		to: days[days.length - 1] ?? opts.today,
		marker,
		generatedAt: new Date().toISOString(),
		estimated: false,
	};
	return { ok: true, baseline, filesScanned: files.length, blocksFound: blocks.length };
}

function shiftDay(day: string, delta: number): string {
	const date = new Date(`${day}T12:00:00Z`);
	date.setUTCDate(date.getUTCDate() + delta);
	return date.toISOString().slice(0, 10);
}

export function writeBaseline(paths: BankPaths, baseline: Baseline): void {
	if (!existsSync(paths.metrics)) mkdirSync(paths.metrics, { recursive: true });
	writeJson(baselineFile(paths), baseline);
}

export function readBaseline(paths: BankPaths): Baseline | undefined {
	return readJson<Baseline>(baselineFile(paths));
}

export interface TrialReport {
	days: number;
	turns: number;
	medianTokens: number;
	baseline?: Baseline;
	ratio?: number;
	flags: { stale: number; rival: number; total: number };
	go: boolean;
	verdict: string;
	corruptTurnLines: number;
}

/**
 * `/memory trial` (R45): median injected tokens per turn against the baseline,
 * plus every stale or rival flag. Go means the median is at most 25% of the
 * baseline and there are no flags.
 */
export function trialReport(paths: BankPaths, opts: { today: string; days?: number }): TrialReport {
	const days = opts.days ?? 7;
	const sinceDay = shiftDay(opts.today, -(days - 1));
	const turns = readTurns(paths, { sinceDay });
	const flags = readFlags(paths, { sinceDay });
	const stale = flags.filter((flag) => flag.kind === "stale").length;
	const rival = flags.filter((flag) => flag.kind === "rival").length;
	const baseline = readBaseline(paths);
	const observed = turns.filter((turn) => turn.tokens.total > 0);
	const report: TrialReport = {
		days,
		turns: turns.length,
		medianTokens: median(observed.map((turn) => turn.tokens.total)),
		baseline,
		flags: { stale, rival, total: stale + rival },
		go: false,
		verdict: "",
		corruptTurnLines: corruptTurnLines(paths),
	};
	if (turns.length === 0) {
		report.verdict = `no injected turns recorded in the last ${days} days — the trial has not started`;
		return report;
	}
	if (daysBetween(sinceDay, opts.today) + 1 < days) {
		report.verdict = `only ${daysBetween(sinceDay, opts.today) + 1} of ${days} days covered`;
	}
	if (!baseline) {
		report.verdict = `${report.turns} turns recorded, but no baseline: run /memory trial baseline first`;
		return report;
	}
	report.ratio = baseline.medianTokens === 0 ? Number.POSITIVE_INFINITY : report.medianTokens / baseline.medianTokens;
	const sizeOk = report.ratio <= 0.25;
	const flagsOk = report.flags.total === 0;
	report.go = sizeOk && flagsOk;
	const pct = Number.isFinite(report.ratio) ? `${Math.round(report.ratio * 100)}%` : "infinite";
	const flagPhrase = `${report.flags.total} stale or rival flag${report.flags.total === 1 ? "" : "s"}`;
	if (report.go) {
		report.verdict = `go: median ${report.medianTokens} tokens against a baseline of ${baseline.medianTokens} (${pct}, threshold 25%), and ${flagPhrase}`;
	} else if (!sizeOk && !flagsOk) {
		report.verdict = `no-go: median ${report.medianTokens} tokens against a baseline of ${baseline.medianTokens} (${pct}, threshold 25%), and ${flagPhrase}`;
	} else if (!sizeOk) {
		report.verdict = `not yet: median ${report.medianTokens} tokens is ${pct} of the baseline's ${baseline.medianTokens}; the threshold is 25%`;
	} else {
		report.verdict = `not yet: the size gate passes (${pct} of baseline), but ${report.flags.total} claim${report.flags.total === 1 ? " was" : "s were"} flagged stale or rival`;
	}
	return report;
}

export function formatTrialReport(report: TrialReport): string {
	const lines = [`Trial, last ${report.days} days: ${report.turns} injected turns, median ${report.medianTokens} tokens per turn`];
	if (report.baseline) lines.push(`  baseline: median ${report.baseline.medianTokens} tokens from ${report.baseline.samples} blocks marked "${report.baseline.marker}", ${report.baseline.from} to ${report.baseline.to}`);
	else lines.push("  baseline: none recorded — /memory trial baseline computes it from session files (R47)");
	if (report.ratio !== undefined) lines.push(`  size: ${Math.round(report.ratio * 100)}% of the baseline (the gate is 25%)`);
	lines.push(`  flags: ${report.flags.stale} stale, ${report.flags.rival} rival`);
	if (report.corruptTurnLines > 0) lines.push(`  metrics damage: ${report.corruptTurnLines} unreadable lines in turns.jsonl`);
	lines.push(`  ${report.verdict}`);
	return lines.join("\n");
}
