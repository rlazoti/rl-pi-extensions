/**
 * settle-guard — the rule that decides whether an empty model turn gets asked
 * for again. Pure on purpose: no Pi, no filesystem, no clock, so the whole
 * decision is testable as a table.
 *
 * ## The failure this is for
 *
 * A reasoning model can finish its thinking block and emit end-of-turn without
 * writing an answer. The provider then returns reasoning text with no content
 * and `finish_reason: stop`, Pi records a thinking-only assistant message with
 * `stopReason: "stop"` and no tool call, and the agent loop has nothing left to
 * run. The session stops and waits for a human. Measured on one real
 * conversation: 8 of 9 replays with reasoning requested ended that way, 0 of 3
 * without it.
 *
 * ## The second failure, and why there are two tiers
 *
 * The other way the same session dies is a turn that *does* answer and is cut
 * mid-sentence: the model opens a code span, writes the reasoning delimiter tag
 * inside it, and the server stops generating at the tag. That leaves a turn with
 * text, no tool call and `stopReason: "stop"` — which is exactly how a normal
 * final answer ends, so it cannot be retried on shape alone. Across every session
 * on the affected machine, 670 turns look like that; 8 end inside an unclosed
 * markup construct, all 8 in the last 24 hours on the affected model, and two of
 * them are turns the human answered with "you stopped again". So tier two retries
 * only the unclosed-markup shape, once per streak, and never on `length`.
 *
 * ## What counts as empty
 *
 * No non-whitespace text block and no tool call in the assistant message, or a
 * marker where the answer should be. That predicate is model-agnostic on purpose:
 * an agent that answers with nothing and does nothing is stuck whatever produced
 * it, and a model that never does it will never trigger this.
 *
 * ## What is deliberately not here
 *
 * Measured on Pi 1.4.0: `context.canContinue` is false in exactly this state and
 * stays false when the continuation is accepted, because what makes a
 * continuation runnable is a proposed entry, not that flag. So nothing here reads
 * it, and reading it would disable the guard.
 *
 * `aborted` (the human pressed Escape) and `error` are left alone — Pi already
 * reports those, and retrying over a human's abort is rude. A stop reason of
 * `length` is left alone too: that is a budget the model ran out of, not the
 * silent stop, and silently retrying it doubles a long generation.
 */

export type GuardAction = "none" | "retry" | "give-up";

/**
 * Every decision the rule can make, as a stable name. The prose in `Verdict.reason`
 * is for the human and may be reworded; this is what a log parser greps.
 */
export type GuardCode =
	| "none"
	| "retry"
	| "budget"
	| "reasoned-empty"
	| "empty-content"
	| "refusal"
	| "truncated-text"
	| "progress"
	| "stop-reason"
	| "aborted"
	| "error"
	| "not-assistant"
	| "disabled";
export type GuardOutcome = "completed" | "aborted" | "error";

export interface BlockLike {
	type: string;
	text?: string;
	thinking?: string;
}

/** Which of the two failures a retry is for. They have separate budgets. */
export type RetryTier = "none" | "empty" | "truncation";

/** Why a turn looks cut off, when it does. */
export type CutOffSignal = "span-opener" | "unclosed-span" | "open-fence";

/** The part of a Pi assistant message this rule reads. */
export interface TurnSnapshot {
	role?: string;
	stopReason?: string;
	content?: BlockLike[];
	outcome?: GuardOutcome;
}

/** How many turns of each kind have been seen since the streak last broke. */
export interface Streak {
	empties: number;
	truncations: number;
}

export interface GuardConfig {
	/** Automatic retries allowed per streak of empty turns. */
	maxRetries: number;
	/** Retries allowed per streak for a turn that looks cut off mid-answer. */
	maxTruncationRetries: number;
	/** Ask the retry with reasoning switched off, or with the user's level. */
	thinkingOnRetry: "off" | "keep";
}

export interface Verdict {
	action: GuardAction;
	/** Which failure this verdict is about, and therefore which budget it spends. */
	tier: RetryTier;
	/** True when this turn made progress, which resets the retry streak. */
	progress: boolean;
	/** How many turns of this tier were already retried in this streak. */
	attempts: number;
	/** Human-readable why, for the log line and the status command. */
	reason: string;
	/** Stable identifier for the same decision: the future log parser greps this. */
	code: GuardCode;
}

/** Text the human can actually see. Whitespace-only text is nothing. */
export function visibleTextLength(content: BlockLike[] | undefined): number {
	if (!Array.isArray(content)) return 0;
	let n = 0;
	for (const block of content) {
		if (block && block.type === "text" && typeof block.text === "string") {
			n += block.text.trim().length;
		}
	}
	return n;
}

export function hasToolCall(content: BlockLike[] | undefined): boolean {
	if (!Array.isArray(content)) return false;
	return content.some((block) => block && block.type === "toolCall");
}

export function thinkingLength(content: BlockLike[] | undefined): number {
	if (!Array.isArray(content)) return 0;
	let n = 0;
	for (const block of content) {
		if (block && block.type === "thinking" && typeof block.thinking === "string") {
			n += block.thinking.length;
		}
	}
	return n;
}

/**
 * A turn whose entire visible answer is an engine or server marker — llama.cpp's
 * `[refusal]`, a server's content-filter notice — is not an answer. Matched only
 * when the marker is the whole thing, so a model that declines in a sentence and
 * then works is left alone.
 */
export function isRefusalMarker(content: BlockLike[] | undefined): boolean {
	if (!Array.isArray(content)) return false;
	const text = content
		.filter((block) => block && block.type === "text" && typeof block.text === "string")
		.map((block) => (block as { text: string }).text)
		.join(" ")
		.trim();
	if (!text) return false;
	return REFUSAL_MARKER.test(text);
}

const REFUSAL_MARKER = /^[\[(]\s*(refusals?|content[ -]?filter(?:ed)?|filtered|redacted|content[ -]?policy|blocked|safety[ -]?stop)\s*[\])]([.\s]*)$/i;

/** Every text block joined, in order, untrimmed at the ends we can measure. */
export function joinedText(content: BlockLike[] | undefined): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block && block.type === "text" && typeof block.text === "string")
		.map((block) => (block as { text: string }).text)
		.join("");
}

/**
 * Does this answer stop in the middle of its own markup?
 *
 * Three shapes, all of them things a finished answer does not do: it ends with a
 * code-span opener (space then backtick, the measured signature — the tag that
 * killed the turn was inside the span it never closed); it ends with an odd
 * number of backticks, so a span is still open; or a fenced block is still open.
 * Deliberately not "does not end with a full stop", which would retry most of the
 * answers in a normal session.
 */
export function looksCutOff(text: string): CutOffSignal | null {
	const body = text.replace(/\s+$/, "");
	if (!body) return null;
	const fences = body.split("\n").filter((line) => /^\s*```/.test(line)).length;
	if (fences % 2 === 1) return "open-fence";
	if (/[\s([]`$/.test(body.slice(-2))) return "span-opener";
	const ticks = body.split("`").length - 1;
	if (ticks > 0 && ticks % 2 === 1) return "unclosed-span";
	return null;
}

const CUT_OFF_WHY: Record<CutOffSignal, string> = {
	"span-opener": "ended with an unclosed code span, mid-sentence",
	"unclosed-span": "ended inside an unclosed code span",
	"open-fence": "ended inside an unclosed code fence",
};

/**
 * Decide what to do about one finished model turn.
 *
 * @param turn what the model just produced
 * @param attempts consecutive empty turns already seen in this streak
 */
export function decide(turn: TurnSnapshot, streak: Streak, config: GuardConfig): Verdict {
	const none = (progress: boolean, reason: string, code: GuardCode = "none"): Verdict =>
		({ action: "none", tier: "none", progress, attempts: 0, reason, code });

	if (config.maxRetries <= 0 && config.maxTruncationRetries <= 0) {
		return none(false, "retries are set to 0", "disabled");
	}
	if (turn.role !== "assistant") return none(false, `last message is a ${turn.role ?? "unknown"} message`, "not-assistant");
	if (turn.outcome === "aborted") return none(false, "the run was aborted, which is the human's decision", "aborted");
	if (turn.outcome === "error") return none(false, "the run ended in error, which Pi reports on its own", "error");

	const tools = hasToolCall(turn.content);
	if (tools) return none(true, "the turn produced a tool call", "progress");

	const text = visibleTextLength(turn.content);
	const refused = isRefusalMarker(turn.content);
	const cutOff = text > 0 && !refused ? looksCutOff(joinedText(turn.content)) : null;
	if (text > 0 && !refused && !cutOff) {
		return none(true, `the turn produced ${text} characters of answer`, "progress");
	}

	if (turn.stopReason !== "stop") {
		return none(false, `stop reason is ${turn.stopReason ?? "missing"}, not a silent stop`, "stop-reason");
	}

	// From here the turn is one of the two shapes, and only the tier differs.
	const thought = thinkingLength(turn.content);
	const tier: RetryTier = refused ? "empty" : text === 0 ? "empty" : "truncation";
	const used = tier === "truncation" ? streak.truncations : streak.empties;
	const limit = tier === "truncation" ? config.maxTruncationRetries : config.maxRetries;
	// A tier switched off on its own says nothing at all: "give up" is a message
	// about a budget you never set, and the human would read it as a malfunction.
	if (limit <= 0) {
		return {
			action: "none",
			tier: "none",
			progress: false,
			attempts: 0,
			reason: cutOff ? "cut-off retries are switched off" : "empty-turn retries are switched off",
			code: "disabled",
		};
	}
	const code: GuardCode = refused
		? "refusal"
		: text === 0 ? (thought > 0 ? "reasoned-empty" : "empty-content") : "truncated-text";
	const shape = refused
		? "answered only a refusal or filter marker"
		: text === 0
			? thought > 0 ? `reasoned for ${thought} characters and answered nothing` : "produced no text and no tool call"
			: `answered ${text} characters and ${CUT_OFF_WHY[cutOff as CutOffSignal]}`;

	if (used >= limit) {
		return {
			action: "give-up",
			tier,
			progress: false,
			attempts: used,
			reason: `${shape}, ${used} ${tier === "truncation" ? "cut-off retries" : "retries"} already used`,
			code: "budget",
		};
	}
	return {
		action: "retry",
		tier,
		progress: false,
		attempts: used,
		reason: `${shape}; asking again${config.thinkingOnRetry === "off" ? " without reasoning" : ""}`,
		code,
	};
}
