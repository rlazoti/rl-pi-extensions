/**
 * Write gates for `core/dailyContext.md`: two limits, checked before a write lands.
 *
 * Pure on purpose: text before, text after, limits, and how many times each gate has
 * refused in a row. No filesystem, no clock, no Pi. The tools call it under the write
 * lock and before the recovery snapshot, so a refused write leaves no trace.
 *
 * Why two gates, and why these units:
 *
 *   word gate       one bullet in `Completed` / `Key Decisions`. It bounds how much each
 *                   entry says, which a character cap alone cannot (a median bullet
 *                   crept from 15 to 21 words in the bank this was measured on).
 *   character gate  the whole file, in the unit a prompt pays. A 150-line cap was tried
 *                   elsewhere and did not bound cost: files sat at 149-150 lines and
 *                   were still 20 KB. The cap here is `MAX_CORE_FILE_BUDGET_CHARS`, the
 *                   budget the guidelines already state, so what the agent may write is
 *                   what injection will send and nothing is cut.
 *
 * Two rules keep a gate from becoming a wall:
 *
 *   1. A write that does not grow the file always passes the character gate, even while
 *      the file is over the cap, so an oversized file can be trimmed in steps.
 *   2. Each gate refuses at most `GATE_MAX_REJECTIONS` times in a row. The next write is
 *      accepted with a warning that says so. The agent cannot trim and resubmit forever
 *      on a limit it may be unable to meet (an archive that is already one long bullet).
 *
 * A write that breaks both gates is accepted only once BOTH allowances are used. Letting
 * one gate's spent allowance accept the write would let it hide the other's refusal.
 *
 * A refusal has to carry its own fix. Measured over 131 real prompts (2026-11-13 audit):
 * three refusals, and not one of them was followed by an accepted write — the refused
 * bullets were simply lost, because the message named the problem and left the route out.
 * So every refusal says what state the file is in now (nothing landed, so the other
 * bullets did not either), the exact target (words, limit, how far over), and where
 * detail goes instead (a knowledge note, ungated, with a pointer left here). The escape
 * valve still bounds a gate that cannot be met: 2 refusals, then accept with a warning.
 */
import { MAX_CORE_FILE_BUDGET_CHARS } from "./caps.js";

export interface GateLimits {
	enabled: boolean;
	/** Max words in one `Completed` bullet. 0 turns the word gate off. */
	completedWords: number;
	/** Max words in one `Key Decisions` bullet. 0 turns the word gate off. */
	keyDecisionsWords: number;
	/** Max characters in the whole file when a write grows it. 0 turns the character gate off. */
	dailyContextMaxChars: number;
}

export const DEFAULT_GATE_LIMITS: GateLimits = {
	enabled: true,
	completedWords: 30,
	keyDecisionsWords: 25,
	dailyContextMaxChars: MAX_CORE_FILE_BUDGET_CHARS,
};

/** Consecutive refusals per gate before the next write is accepted with a warning. */
export const GATE_MAX_REJECTIONS = 2;

export interface GateState {
	words: number;
	chars: number;
}
export const NO_REJECTIONS: GateState = { words: 0, chars: 0 };

export type GateDecision = { action: "accept"; warning?: string } | { action: "reject"; message: string };

export interface GateResult {
	decision: GateDecision;
	/** What to hold for the next write. Always returned, so the caller never keeps a stale copy. */
	state: GateState;
}

export interface Bullet {
	section: "Completed" | "Key Decisions";
	text: string;
}

const BOUNDED_SECTIONS = new Set(["Completed", "Key Decisions"]);

/** What a refusal leaves behind, stated once so both gates' messages carry it. */
const DAILY_CONTEXT_STATE =
	"core/dailyContext.md still holds its previous text, so the entries this write also carried " +
	"are nowhere: resubmit the whole file, with every entry it was to add either shortened or moved to a note.";

/** Words in one bullet, not counting its `-` or `*` marker. */
export function wordCount(text: string): number {
	return text.replace(/^\s*[-*]\s+/, "").split(/\s+/).filter(Boolean).length;
}

/** The entries (one per non-empty line) of the sections the word gate watches, at either heading level. */
export function boundedBullets(text: string): Bullet[] {
	const out: Bullet[] = [];
	let section: string | null = null;
	for (const line of text.split("\n")) {
		const heading = line.match(/^#{2,3}\s+(.+?)\s*$/);
		if (heading) {
			section = heading[1];
			continue;
		}
		if (!section || !BOUNDED_SECTIONS.has(section)) continue;
		// Every non-empty line is an entry, bullet or not: the tool says "use a - prefix", but a long line
		// that forgot it would otherwise walk straight past the gate.
		const text = line.replace(/^\s*[-*]\s+/, "").trim();
		if (text) out.push({ section: section as Bullet["section"], text });
	}
	return out;
}

/** Bullets present in `after` that are not in `before`, counting repeats, so an old long bullet is never "new". */
function addedBullets(before: string, after: string): Bullet[] {
	const seen = new Map<string, number>();
	for (const b of boundedBullets(before)) {
		const key = `${b.section}\u0000${b.text}`;
		seen.set(key, (seen.get(key) ?? 0) + 1);
	}
	const added: Bullet[] = [];
	for (const b of boundedBullets(after)) {
		const key = `${b.section}\u0000${b.text}`;
		const left = seen.get(key) ?? 0;
		if (left > 0) seen.set(key, left - 1);
		else added.push(b);
	}
	return added;
}

const preview = (text: string): string => (text.length > 70 ? `${text.slice(0, 69)}…` : text);

/**
 * What a file's sections cost, biggest first — so a character refusal can name where the
 * weight is instead of telling the reader to guess which of eight sections to trim.
 */
export function sectionWeights(text: string): Array<{ name: string; chars: number }> {
	if (!text) return [];
	const out: Array<{ name: string; chars: number }> = [];
	let current: { name: string; chars: number } | null = null;
	for (const line of text.split("\n")) {
		const heading = line.match(/^#{2,3}\s+(.+?)\s*$/);
		if (heading) {
			if (current) out.push(current);
			current = { name: heading[1], chars: line.length + 1 };
			continue;
		}
		// Text above the first heading has no section to blame; give it one so the numbers add up.
		if (!current) current = { name: "(before the first heading)", chars: 0 };
		current.chars += line.length + 1;
	}
	if (current) out.push(current);
	return out.filter((s) => s.chars > 0).sort((a, b) => b.chars - a.chars);
}

/** Where the detail goes when a bullet does not fit: a note, plus a pointer short enough to pass. */
const DETAIL_ROUTE =
	"Or keep the detail off the injected file: memory_update a knowledge/<name>.md note (the word gate " +
	"does not watch it) and leave a one-line pointer here, under the limit.";

function wordViolations(before: string, after: string, limits: GateLimits): string[] {
	const lines: string[] = [];
	for (const b of addedBullets(before, after)) {
		const limit = b.section === "Completed" ? limits.completedWords : limits.keyDecisionsWords;
		if (limit <= 0) continue;
		const n = wordCount(b.text);
		if (n > limit) {
			lines.push(`  [${b.section}: ${n} words > ${limit} (${n - limit} over)] - ${preview(b.text)}`);
		}
	}
	return lines;
}

interface CharViolation {
	summary: string;
	advice: string;
}

function charViolation(before: string, after: string, limits: GateLimits): CharViolation | null {
	const cap = limits.dailyContextMaxChars;
	if (cap <= 0 || after.length <= cap) return null;
	// Block growth, never progress: shrinking or rewriting at the same size is how an over-cap file gets fixed.
	if (after.length <= before.length) return null;
	return {
		summary:
			`core/dailyContext.md would be ${after.length.toLocaleString()} characters, ` +
			`${(after.length - cap).toLocaleString()} over the ${cap.toLocaleString()}-character cap`,
		advice:
			"The whole file is injected on every turn, so every character is a recurring cost. A write that " +
			"does not grow the file always passes, so trimming it is never blocked. The heaviest sections are " +
			`${sectionWeights(after).slice(0, 3).map((s) => `${s.name} ${s.chars.toLocaleString()} chars`).join(", ")}. ` +
			"The live daily file is the only copy of today until rollover archives it, so move old entries to " +
			"a knowledge note (memory_update, no cap) before cutting them — rules in knowledge/memory-bank-maintenance.md.",
	};
}

/**
 * Decide one write of `core/dailyContext.md`.
 *
 * `before` is the file as it is on disk now (empty when it does not exist), `after` is
 * what the write would leave. The caller owns `state` for the session and stores what
 * comes back.
 */
export function checkDailyWrite(before: string, after: string, limits: GateLimits, state: GateState): GateResult {
	if (!limits.enabled) return { decision: { action: "accept" }, state: NO_REJECTIONS };

	const words = wordViolations(before, after, limits);
	const chars = charViolation(before, after, limits);
	if (words.length === 0 && chars === null) return { decision: { action: "accept" }, state: NO_REJECTIONS };

	const fired = { words: words.length > 0, chars: chars !== null };
	const spent = (gate: "words" | "chars") => !fired[gate] || state[gate] >= GATE_MAX_REJECTIONS;
	/** `counters` is null for an accepted write, which has no "rejection n of m" to report. */
	const detail = (counters: GateState | null): string => {
		const tag = (n: number) => (counters ? ` (rejection ${Math.min(n, GATE_MAX_REJECTIONS)} of ${GATE_MAX_REJECTIONS})` : "");
		const parts: string[] = [];
		if (fired.words) {
			parts.push(
				`dailyContext entries have word limits${tag(counters?.words ?? 0)}. Shorten each one and resubmit:\n${words.join("\n")}\n` +
				`Cut each entry to its single outcome, at or under the limit it names. ${DETAIL_ROUTE}`,
			);
		}
		if (chars) parts.push(`${chars.summary}${tag(counters?.chars ?? 0)}. ${chars.advice}`);
		return parts.join("\n");
	};

	if (spent("words") && spent("chars")) {
		return {
			decision: {
				action: "accept",
				warning:
					`Accepted over-limit write after ${GATE_MAX_REJECTIONS} rejections, so the gate cannot block the session. ` +
					detail(null),
			},
			state: NO_REJECTIONS,
		};
	}

	// A gate that did not fire this time starts from zero: its refusals were not "in a row" with this one.
	const next: GateState = {
		words: fired.words ? Math.min(state.words + 1, GATE_MAX_REJECTIONS) : 0,
		chars: fired.chars ? Math.min(state.chars + 1, GATE_MAX_REJECTIONS) : 0,
	};
	return {
		decision: {
			action: "reject",
			message:
				// Say what state the file is in: a refused write lands nothing, so the entries in it
				// that were fine did not go in either. Without this line a reader can resubmit only the
				// offending bullet and silently lose the rest.
				`Rejected: ${detail(next)}\nNothing was written — ${DAILY_CONTEXT_STATE}\n` +
				`After ${GATE_MAX_REJECTIONS} rejections in a row for the same limit, the next write is accepted with a warning.`,
		},
		state: next,
	};
}
