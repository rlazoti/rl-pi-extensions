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
	/**
	 * Approved claims the bank held when this turn was injected.
	 *
	 * The trial clock starts only once the bank is worth measuring (D22), and
	 * "when" is a fact about that turn, so it is recorded on the turn. A line
	 * without the field — written before this existed — is unknown, not zero.
	 */
	claims: number;
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

export function overridesFile(paths: BankPaths): string {
	return join(paths.metrics, "overrides.jsonl");
}

/**
 * One sample per turn of what the model was about to be sent (R43, D24).
 *
 * The turn metric says what one block cost. This says what the conversation
 * carried, which is the number that grew without bound before the context handler
 * existed — 10,255 tokens of memory blocks in a nine-turn session.
 */
export interface ContextMetric {
	at: string;
	day: string;
	blocks: number;
	keptBlocks: number;
	droppedBlocks: number;
	keptTokens: number;
	droppedTokens: number;
	carried: boolean;
	session: string;
}

export function contextFile(paths: BankPaths): string {
	return join(paths.metrics, "context.jsonl");
}

export function appendContextMetric(paths: BankPaths, metric: Omit<ContextMetric, "at" | "day">, clock: Clock = systemClock): ContextMetric {
	if (!existsSync(paths.metrics)) mkdirSync(paths.metrics, { recursive: true });
	const { at, day } = stamp(clock);
	const full: ContextMetric = { at, day, ...metric };
	writeFileSync(contextFile(paths), `${JSON.stringify(full)}\n`, { flag: "a" });
	return full;
}

export function readContextMetrics(paths: BankPaths, opts: { sinceDay?: string } = {}): ContextMetric[] {
	const text = readOrNull(contextFile(paths));
	if (text === undefined) return [];
	const out: ContextMetric[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line) as ContextMetric;
			if (opts.sinceDay && parsed.day < opts.sinceDay) continue;
			out.push(parsed);
		} catch {
			continue;
		}
	}
	return out;
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

/**
 * One status-check override, recorded the moment it happens (R24, D14).
 *
 * This used to be a running total in the extension process, written onto every
 * turn after it and never reported, so the number D14 wanted (how often the
 * detector was wrong) could not be read and counted the same override again on
 * every later turn. An override belongs to a proposal, so it gets its own line.
 */
export interface OverrideRecord {
	at: string;
	day: string;
	key: string;
	scope: string;
	/** The reason the caller insisted, as it was given. */
	reason: string;
	session: string;
}

export function recordOverride(paths: BankPaths, override: { key: string; scope: string; reason: string; session: string }, clock: Clock = systemClock): OverrideRecord {
	if (!existsSync(paths.metrics)) mkdirSync(paths.metrics, { recursive: true });
	const { at, day } = stamp(clock);
	const full: OverrideRecord = { at, day, ...override };
	writeFileSync(overridesFile(paths), `${JSON.stringify(full)}\n`, { flag: "a" });
	return full;
}

export function readOverrides(paths: BankPaths, opts: { sinceDay?: string } = {}): OverrideRecord[] {
	const text = readOrNull(overridesFile(paths));
	if (text === undefined) return [];
	const out: OverrideRecord[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line) as OverrideRecord;
			if (opts.sinceDay && parsed.day < opts.sinceDay) continue;
			out.push(parsed);
		} catch {
			continue;
		}
	}
	return out;
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
	/** Injected turns recorded in the window, whether or not they count as evidence. */
	turns: number;
	retrievedTurns: number;
	/** Approved claims the bank held at the last recorded turn. */
	approvedClaims: number;
	clockStarted: boolean;
	/** Days since the trial clock started, today included. */
	spanDays: number;
	/** Days in the window that carry at least one turn since the clock started. */
	activeDays: number;
	coverageGate: number;
	medianTokens: number;
	baseline?: Baseline;
	ratio?: number;
	flags: { stale: number; rival: number; total: number };
	overrides: number;
	overrideKeys: string[];
	/**
	 * What the conversation carried, from `metrics/context.jsonl` (D24). Absent
	 * until a turn has been sampled.
	 */
	context?: { samples: number; medianKept: number; medianDropped: number; medianBlocks: number };
	go: boolean;
	/**
	 * What stops the go, one entry per unmet gate, in the order a reader would
	 * fix them. The verdict joins them, so a gate can never be reported and then
	 * overwritten by the next one — the bug that let a one-day burst read as a
	 * finished trial (D21).
	 */
	gates: string[];
	verdict: string;
	corruptTurnLines: number;
}

/** The window `/memory trial` reports, and the gate R45 sets on each number. */
export const TRIAL_DAYS = 7;
export const SIZE_RATIO_GATE = 0.25;
/**
 * D23: an absolute ceiling beside the relative one, measured on this machine at
 * 1,077 tokens median over 25 real injections. The ratio alone says nothing here:
 * against a 17,232-token baseline the 2,000-token budget is 12%, so a bank that
 * spent its whole budget every turn would pass a 25% gate for ever.
 */
export const MAX_MEDIAN_TOKENS = 1200;
/** D22: the trial clock starts at 3 approved claims… */
export const MIN_APPROVED_CLAIMS = 3;
/** …and a go needs 5 turns that actually got something back from the ranker. */
export const MIN_RETRIEVED_TURNS = 5;

/**
 * `/memory trial` (R45): the week's numbers and every reason they do not yet
 * allow a go.
 *
 * Nothing is estimated and nothing is dropped: the median is over the turns in
 * the window, and the gates say whether the window is evidence at all. A trial
 * that cannot say go says why, gate by gate.
 */
export function trialReport(paths: BankPaths, opts: { today: string; days?: number }): TrialReport {
	const days = opts.days ?? TRIAL_DAYS;
	const sinceDay = shiftDay(opts.today, -(days - 1));
	const turns = readTurns(paths, { sinceDay });
	const flags = readFlags(paths, { sinceDay });
	const overrides = readOverrides(paths, { sinceDay });
	const stale = flags.filter((flag) => flag.kind === "stale").length;
	const rival = flags.filter((flag) => flag.kind === "rival").length;
	const baseline = readBaseline(paths);
	const observed = turns.filter((turn) => turn.tokens.total > 0);
	const contextSamples = readContextMetrics(paths, { sinceDay });
	const coverageGate = Math.ceil(days / 2);
	// The clock starts at the first turn whose bank was worth measuring. A turn
	// recorded before that is not evidence, and a run of turns recorded while the
	// bank was empty is not a trial that finished.
	const clockDays = turns.filter((turn) => (turn.claims ?? 0) >= MIN_APPROVED_CLAIMS).map((turn) => turn.day);
	const startDay = clockDays.length === 0 ? undefined : clockDays.sort()[0]!;
	const sinceClock = startDay === undefined ? [] : turns.filter((turn) => turn.day >= startDay);
	const spanDays = startDay === undefined ? 0 : daysBetween(startDay, opts.today) + 1;
	const activeDays = new Set(sinceClock.map((turn) => turn.day)).size;
	const retrievedTurns = turns.filter((turn) => turn.tokens.retrieved > 0).length;
	const report: TrialReport = {
		days,
		turns: turns.length,
		retrievedTurns,
		approvedClaims: turns.length === 0 ? 0 : turns[turns.length - 1]!.claims ?? 0,
		clockStarted: startDay !== undefined,
		spanDays,
		activeDays,
		coverageGate,
		medianTokens: median(observed.map((turn) => turn.tokens.total)),
		baseline,
		flags: { stale, rival, total: stale + rival },
		overrides: overrides.length,
		overrideKeys: [...new Set(overrides.map((entry) => entry.key))],
		context: contextSamples.length === 0
			? undefined
			: {
					samples: contextSamples.length,
					medianKept: median(contextSamples.map((sample) => sample.keptTokens)),
					medianDropped: median(contextSamples.map((sample) => sample.droppedTokens)),
					medianBlocks: median(contextSamples.map((sample) => sample.blocks)),
				},
		go: false,
		gates: [],
		verdict: "",
		corruptTurnLines: corruptTurnLines(paths),
	};
	if (turns.length === 0) {
		report.verdict = `no injected turns recorded in the last ${days} days — the trial has not started`;
		return report;
	}

	if (!report.clockStarted) {
		report.gates.push(`the trial clock has not started: the turns recorded so far saw ${report.approvedClaims} approved claim${report.approvedClaims === 1 ? "" : "s"}, and the clock starts at ${MIN_APPROVED_CLAIMS}`);
	} else {
		if (spanDays < days) report.gates.push(`the trial started ${spanDays} day${spanDays === 1 ? "" : "s"} ago; the window is ${days} days`);
		if (activeDays < coverageGate) report.gates.push(`only ${activeDays} of ${days} days carry turns (the gate is ${coverageGate})`);
		if (retrievedTurns < MIN_RETRIEVED_TURNS) report.gates.push(`only ${retrievedTurns} turn${retrievedTurns === 1 ? "" : "s"} retrieved a claim (the gate is ${MIN_RETRIEVED_TURNS})`);
	}

	if (!baseline) {
		report.gates.push("no baseline: run /memory trial baseline first");
	} else {
		report.ratio = baseline.medianTokens === 0 ? Number.POSITIVE_INFINITY : report.medianTokens / baseline.medianTokens;
		if (report.ratio > SIZE_RATIO_GATE) {
			report.gates.push(`median ${report.medianTokens} tokens is ${ratioText(report.ratio)} of the baseline's ${baseline.medianTokens} (the gate is ${Math.round(SIZE_RATIO_GATE * 100)}%)`);
		}
		if (report.medianTokens > MAX_MEDIAN_TOKENS) {
			report.gates.push(`median ${report.medianTokens} tokens is over the ${MAX_MEDIAN_TOKENS}-token ceiling`);
		}
	}
	if (report.flags.total > 0) {
		const total = report.flags.total;
		report.gates.push(`${total} claim${total === 1 ? " was" : "s were"} flagged stale or rival`);
	}

	const pct = report.ratio === undefined ? "" : ratioText(report.ratio);
	if (report.gates.length === 0) {
		report.go = true;
		report.verdict = `go: median ${report.medianTokens} tokens against a baseline of ${baseline!.medianTokens} (${pct}, threshold ${Math.round(SIZE_RATIO_GATE * 100)}%), under the ${MAX_MEDIAN_TOKENS}-token ceiling, and ${report.flags.total} stale or rival flag${report.flags.total === 1 ? "" : "s"}`;
	} else {
		report.verdict = `not yet: ${report.gates.join("; ")}`;
	}
	return report;
}

function ratioText(ratio: number): string {
	return Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : "infinite";
}

export function formatTrialReport(report: TrialReport): string {
	const lines = [`Trial, last ${report.days} days: ${report.turns} injected turns, median ${report.medianTokens} tokens per turn`];
	if (report.baseline) lines.push(`  baseline: median ${report.baseline.medianTokens} tokens from ${report.baseline.samples} blocks marked "${report.baseline.marker}", ${report.baseline.from} to ${report.baseline.to}`);
	else lines.push("  baseline: none recorded — /memory trial baseline computes it from session files (R47)");
	if (report.ratio !== undefined) lines.push(`  size: ${ratioText(report.ratio)} of the baseline (the gate is ${Math.round(SIZE_RATIO_GATE * 100)}%), median ${report.medianTokens} against a ceiling of ${MAX_MEDIAN_TOKENS}`);
	else lines.push(`  size: median ${report.medianTokens} against a ceiling of ${MAX_MEDIAN_TOKENS}, and the ratio needs a baseline`);
	lines.push(`  evidence: ${report.clockStarted ? `${report.turns} turns over ${report.spanDays} days` : `${report.turns} turns before the clock started`}, ${report.retrievedTurns} of them retrieved a claim (the gate is ${MIN_RETRIEVED_TURNS}), bank at ${report.approvedClaims} approved claims (the clock starts at ${MIN_APPROVED_CLAIMS})`);
	lines.push(`  coverage: ${report.activeDays} of ${report.days} days carry turns, over ${report.spanDays} of ${report.days} days (the gate is ${report.coverageGate} days)`);
	lines.push(`  flags: ${report.flags.stale} stale, ${report.flags.rival} rival`);
	lines.push(`  overrides: ${report.overrides} in the window${report.overrideKeys.length === 0 ? "" : ` (${report.overrideKeys.slice(0, 5).join(", ")}${report.overrideKeys.length > 5 ? ", …" : ""})`}`);
	if (report.context) lines.push(`  context: ${report.context.samples} samples, median ${report.context.medianKept} memory tokens carried per model call, median ${report.context.medianDropped} dropped (from ${report.context.medianBlocks} blocks)`);
	if (report.corruptTurnLines > 0) lines.push(`  metrics damage: ${report.corruptTurnLines} unreadable lines in turns.jsonl`);
	lines.push(`  ${report.verdict}`);
	return lines.join("\n");
}
