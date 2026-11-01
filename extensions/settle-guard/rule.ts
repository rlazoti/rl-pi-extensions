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
 * ## What counts as empty
 *
 * No non-whitespace text block and no tool call in the assistant message. That
 * is the whole predicate. It is model-agnostic on purpose: an agent that
 * answers with nothing and does nothing is stuck whatever produced it, and a
 * model that never does it will never trigger this.
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

/** The part of a Pi assistant message this rule reads. */
export interface TurnSnapshot {
	role?: string;
	stopReason?: string;
	content?: BlockLike[];
	outcome?: GuardOutcome;
}

export interface GuardConfig {
	/** Automatic retries allowed per streak of empty turns. */
	maxRetries: number;
	/** Ask the retry with reasoning switched off, or with the user's level. */
	thinkingOnRetry: "off" | "keep";
}

export interface Verdict {
	action: GuardAction;
	/** True when this turn made progress, which resets the retry streak. */
	progress: boolean;
	/** How many empty turns came before this one. */
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

/**
 * Decide what to do about one finished model turn.
 *
 * @param turn what the model just produced
 * @param attempts consecutive empty turns already seen in this streak
 */
export function decide(turn: TurnSnapshot, attempts: number, config: GuardConfig): Verdict {
	const empty = attempts < config.maxRetries;
	const none = (progress: boolean, reason: string, code: GuardCode = "none"): Verdict =>
		({ action: "none", progress, attempts, reason, code });

	if (config.maxRetries <= 0) return none(false, "retries are set to 0", "disabled");
	if (turn.role !== "assistant") return none(false, `last message is a ${turn.role ?? "unknown"} message`, "not-assistant");
	if (turn.outcome === "aborted") return none(false, "the run was aborted, which is the human's decision", "aborted");
	if (turn.outcome === "error") return none(false, "the run ended in error, which Pi reports on its own", "error");

	const text = visibleTextLength(turn.content);
	const tools = hasToolCall(turn.content);
	if (tools) {
		return none(true, "the turn produced a tool call", "progress");
	}

	// A whole turn that is only the engine's own marker is the same non-answer,
	// and asking again is what recovers from it.
	if (text > 0 && !isRefusalMarker(turn.content)) {
		return none(true, `the turn produced ${text} characters of answer`, "progress");
	}

	if (turn.stopReason !== "stop") {
		return none(false, `stop reason is ${turn.stopReason ?? "missing"}, not a silent stop`, "stop-reason");
	}
	const thought = thinkingLength(turn.content);
	const code: GuardCode = isRefusalMarker(turn.content)
		? "refusal"
		: thought > 0 ? "reasoned-empty" : "empty-content";
	const shape = isRefusalMarker(turn.content)
		? "answered only a refusal or filter marker"
		: thought > 0 ? `reasoned for ${thought} characters and answered nothing` : "produced no text and no tool call";
	if (!empty) {
		return {
			action: "give-up",
			progress: false,
			attempts,
			reason: `${shape}, ${attempts} retries already used`,
			code: "budget",
		};
	}
	return {
		action: "retry",
		progress: false,
		attempts,
		reason: `${shape}; asking again${config.thinkingOnRetry === "off" ? " without reasoning" : ""}`,
		code,
	};
}
