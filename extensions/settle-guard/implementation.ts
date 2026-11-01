/**
 * settle-guard — ask again when a model turn ends with nothing in it.
 *
 * ## Why this exists
 *
 * A reasoning model can end its turn at the end of the thinking block, before
 * writing an answer. The provider reports reasoning plus `finish_reason: stop`
 * with no content; Pi records a thinking-only assistant message with no tool
 * call; the agent loop has nothing to execute; the session sits there waiting
 * for a keystroke. Measured on the real conversation that prompted this: 8 of 9
 * replays with reasoning requested, 0 of 3 without.
 *
 * The mechanism is one line: at the settle boundary, return `continue: true` and
 * Pi runs one more model request. The rule lives in `rule.ts`; this file is Pi,
 * the log, and the thinking-level bookkeeping.
 *
 * ## Where that hook is, and is not (measured on Pi 1.4.0)
 *
 * `turn_end` looks right and is not. Asking for a continuation there, in exactly
 * this state, is refused with `Extension error (<boundary>): turn_end requested
 * continuation without runnable model context`. A bare `{ continue: true }` at
 * `agent_before_settle` is refused the same way. What is accepted is a proposed
 * entry plus `continue: true` — the entry is what makes the request runnable —
 * so the ask carries a one-line nudge, hidden from the transcript.
 *
 * Two related traps, both measured here rather than read somewhere:
 * `context.canContinue` is `false` in exactly this state and stays `false` when
 * the continuation is accepted, so it means nothing to us; and a continuation
 * starts a new agent run, so an `agent_start` that clears the streak clears it on
 * every retry — a stub that always answered empty was retried 1,102 times, each
 * one logged as attempt 1.
 *
 * ## The thinking level, and why it is touched at all
 *
 * By default the retry is asked with reasoning off, because the measurement says
 * the turn fails 8 times in 9 with reasoning and never without it. The user's
 * level is saved and put back when that request finishes, so it is off only for
 * the request that replaces the empty one. It is restored only if it is still
 * `off`, so a level you change by hand in the meantime wins.
 *
 * ## The failure mode that matters
 *
 * A handler that throws at a boundary spoils the boundary. So every path is
 * wrapped, and the worst this file can do is stay quiet.
 */

import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	decide,
	type GuardCode,
	type GuardConfig,
	type RetryTier,
	type Streak,
	type TurnSnapshot,
	type Verdict,
} from "./rule.js";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TRUNC_RETRIES = 1;
const MAX_LOG_BYTES = 262144;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface GuardMode {
	enabled: boolean;
	config: GuardConfig;
	/** Where the log goes, or undefined when logging is switched off. */
	logDir?: string;
}

/**
 * A relative directory would mean a different log per working directory, and an
 * unexpanded `~` a directory named "~", so both are refused rather than guessed.
 */
export function resolveLogDir(raw: string | undefined): string | undefined {
	if (raw === undefined) return join(homedir(), ".pi", "settle-guard");
	const value = raw.trim();
	if (value === "" || value === "off" || value === "none") return undefined;
	const expanded = value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(1)) : value;
	return expanded.startsWith("/") ? expanded : undefined;
}

/** `PI_SETTLE_GUARD=off` is the only off-switch, and it is not in the transcript. */
export function parseEnabled(value: string | undefined): boolean {
	const v = (value ?? "").trim().toLowerCase();
	return !(v === "off" || v === "0" || v === "false");
}

export function parseRetries(value: string | undefined): number {
	const n = Number.parseInt((value ?? "").trim(), 10);
	if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_RETRIES;
	return Math.min(n, 5);
}

/**
 * `PI_SETTLE_GUARD_TRUNC`. Default 1: a turn cut off mid-markup is retried once
 * per streak, because the second one usually gets cut in the same place, and the
 * signature (an answer ending inside an unclosed span) is 8 turns out of 670.
 */
export function parseTruncation(value: string | undefined): number {
	const v = (value ?? "").trim().toLowerCase();
	if (v === "off" || v === "none") return 0;
	if (v === "") return DEFAULT_TRUNC_RETRIES;
	const n = Number.parseInt(v, 10);
	if (!Number.isFinite(n) || n < 0) return DEFAULT_TRUNC_RETRIES;
	return Math.min(n, 3);
}

export function parseThinking(value: string | undefined): "off" | "keep" {
	return (value ?? "").trim().toLowerCase() === "keep" ? "keep" : "off";
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): GuardMode {
	return {
		enabled: parseEnabled(env.PI_SETTLE_GUARD),
		config: {
			maxRetries: parseRetries(env.PI_SETTLE_GUARD_RETRIES),
			maxTruncationRetries: parseTruncation(env.PI_SETTLE_GUARD_TRUNC),
			thinkingOnRetry: parseThinking(env.PI_SETTLE_GUARD_THINKING),
		},
		logDir: resolveLogDir(env.PI_SETTLE_GUARD_DIR),
	};
}

// --- log ---------------------------------------------------------------------

let logDir: string | undefined;
let logIsCapped = false;
let logSeamActive = false;

/**
 * Point the log somewhere else, for tests. The seam exists because a previous
 * version resolved the directory at import time, and the test suite wrote 1,267
 * records and 262 KB into the real `~/.pi/settle-guard/log.jsonl` — which then hit
 * its own cap, so the one real retry this extension caught that day was never
 * recorded. A test that forgets the environment now cannot reach your log at all.
 */
export function setLogDirForTesting(dir: string | null): void {
	logSeamActive = dir !== null;
	logDir = dir ?? undefined;
	logIsCapped = false;
}

/** Where the log is going right now, for the test that asserts the seam holds. */
export function logDirInUse(): string | undefined {
	return logDir;
}

/** One line per action. Never the prompt, never the model's text. */
export interface LogEvent {
	ts: string;
	action: string;
	/** Stable rule code, for the future parser. `reason` is the prose. */
	code: GuardCode;
	reason: string;
	attempts: number;
	thinking: ThinkingLevel | "unknown";
	model?: string;
	provider?: string;
}

export function appendLog(event: LogEvent): void {
	if (!logDir) return;
	try {
		mkdirSync(logDir, { recursive: true });
		const file = join(logDir, "log.jsonl");
		try {
			if (statSync(file).size > MAX_LOG_BYTES) {
				logIsCapped = true;
				return;
			}
		} catch {
			// no file yet: nothing to cap
		}
		appendFileSync(file, JSON.stringify(event).slice(0, 2000) + "\n", "utf8");
	} catch {
		// a log that cannot be written is never a reason to skip the retry
	}
}

// --- state -------------------------------------------------------------------

interface GuardState {
	/** Turns of each shape since the streak last broke — the two budgets. */
	streak: Streak;
	/** Total empty turns seen since the session started. */
	empties: number;
	/** Total turns that looked cut off, since the session started. */
	cutOff: number;
	/** Total retries asked since the session started. */
	retries: number;
	/** Level to put back after a retry, or null when none is outstanding. */
	saved: ThinkingLevel | null;
	/**
	 * True between asking for a retry and that retry's request starting. A
	 * continuation is a new agent run, and a new run is normally a new question —
	 * without this flag `agent_start` clears the streak on every retry, the budget
	 * never fills, and the loop is unbounded. Measured: 1,102 retries against a
	 * stub that always answers empty, every one logged as attempt 1.
	 */
	awaitingRetry: boolean;
	/** One give-up notice per streak per tier, so a stuck model is not nagged. */
	gaveUp: { empty: boolean; truncation: boolean };
}

export function newState(): GuardState {
	return {
		streak: { empties: 0, truncations: 0 },
		empties: 0,
		cutOff: 0,
		retries: 0,
		saved: null,
		gaveUp: { empty: false, truncation: false },
		awaitingRetry: false,
	};
}

/**
 * The turn that just ended, as the boundary sees it.
 *
 * `agent_before_settle` carries no `message` field: the last assistant turn is
 * read off the projected context. `turn_end` carries it directly, so both shapes
 * are accepted and the rule does not care which boundary asked.
 */
export function lastTurnSnapshot(event: Record<string, unknown>): TurnSnapshot {
	const context = (event.context ?? {}) as Record<string, unknown>;
	const projected = (Array.isArray(context.contextMessages) ? context.contextMessages
		: Array.isArray(context.llmMessages) ? context.llmMessages
		: []) as Record<string, unknown>[];
	let message = (event.message ?? {}) as Record<string, unknown>;
	for (let i = projected.length - 1; i >= 0; i -= 1) {
		if (projected[i]?.role === "assistant") {
			message = projected[i];
			break;
		}
	}
	return {
		role: typeof message.role === "string" ? message.role : undefined,
		stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
		content: Array.isArray(message.content) ? (message.content as TurnSnapshot["content"]) : undefined,
		outcome: event.outcome === "aborted" || event.outcome === "error" || event.outcome === "completed"
			? (event.outcome as TurnSnapshot["outcome"])
			: undefined,
	};
}

/** What the model is told when it is asked again. Hidden from the transcript. */
export const RETRY_NUDGE =
	"Your previous turn produced no answer and no tool call. Continue now: either answer, or call a tool.";

/**
 * The other nudge, for a turn that answered and was cut. The second sentence is
 * the reason this tier exists: the turns being retried were killed by the model
 * writing the reasoning delimiter tag inside a code span, and asking again
 * without saying so tends to produce the same tag in the same place.
 */
export const CUTOFF_NUDGE =
	"Your previous answer was cut off mid-sentence. Continue from exactly where it stopped. "
	+ "Never write the reasoning delimiter tags literally, including inside code spans or file paths: "
	+ "name them in words instead.";

/** The nudge for a verdict's tier. */
export function nudgeFor(tier: RetryTier): string {
	return tier === "truncation" ? CUTOFF_NUDGE : RETRY_NUDGE;
}

export function statusLines(state: GuardMode, guard: GuardState): string[] {
	return [
		`settle-guard — ${state.enabled ? "on" : "off"} (set PI_SETTLE_GUARD=off to disable)`,
		`  per streak: ${state.config.maxRetries} empty, ${state.config.maxTruncationRetries} cut-off, retry thinking: ${state.config.thinkingOnRetry}`,
		`  this session: ${guard.empties} empty, ${guard.cutOff} cut off, ${guard.retries} retried`,
		`  streak: ${guard.streak.empties} empty, ${guard.streak.truncations} cut off${guard.gaveUp.empty || guard.gaveUp.truncation ? " (gave up, waiting for you)" : ""}`,
		`  log: ${logDir ?? "nowhere — set PI_SETTLE_GUARD_DIR"}${logDir ? "/log.jsonl" : ""}${logIsCapped ? " (capped; delete it to resume logging)" : ""}`,
	];
}

// --- extension ---------------------------------------------------------------

export default function settleGuard(pi: ExtensionAPI): void {
	const mode = readConfig();
	// Resolved at load, not at module init: the environment is set before Pi loads
	// an extension, and a test's directory certainly is not set before import.
	if (!logSeamActive) {
		logDir = mode.logDir;
		logIsCapped = false;
	}
	const guard = newState();

	const restoreThinking = () => {
		if (guard.saved === null) return;
		try {
			// Only put it back if nothing else changed it in the meantime: a level
			// the human moved during the retry is theirs to keep.
			if (pi.getThinkingLevel() === "off") pi.setThinkingLevel(guard.saved);
		} catch {
			// a session that cannot change the level simply keeps the retry's level
		}
		guard.saved = null;
	};

	pi.on("session_start", () => {
		guard.streak = { empties: 0, truncations: 0 };
		guard.empties = 0;
		guard.cutOff = 0;
		guard.retries = 0;
		guard.saved = null;
		guard.gaveUp = { empty: false, truncation: false };
	});

	// A new run is normally a new question, and the old streak is not its
	// business. Except when it is our own retry starting: that is the same
	// question, and clearing here would make the retry budget unreachable.
	pi.on("agent_start", () => {
		if (guard.awaitingRetry) {
			guard.awaitingRetry = false;
			return;
		}
		guard.streak = { empties: 0, truncations: 0 };
		guard.gaveUp = { empty: false, truncation: false };
	});

	// A prompt from the human is a new question even when it arrives between our
	// ask and our retry, so the pending continuation stops counting.
	pi.on("input", () => {
		guard.awaitingRetry = false;
	});

	pi.on("agent_end", async () => {
		try {
			restoreThinking();
		} catch {
			// never block a run from ending
		}
	});

	// `turn_end` is too early to decide and too late for the level: by the time
	// it fires, Pi has already decided the run has nothing left to do, and asks
	// for a continuation there are refused. It is only where the retry's request
	// finishes, which is when the saved thinking level goes back.
	pi.on("turn_end", async () => {
		try {
			restoreThinking();
		} catch {
			// never break a turn that finished normally
		}
	});

	// The settle boundary is the actionable one: it may propose entries and ask
	// for one more model request. Bare `{ continue: true }` is refused there too
	// ("requested continuation without runnable model context") — measured on Pi
	// 1.4.0 — so the ask carries the entry that makes the request runnable.
	pi.on("agent_before_settle", async (_event, ctx) => {
		try {
			const event = _event as unknown as Record<string, unknown>;
			if (!mode.enabled) return undefined;

			const turn = lastTurnSnapshot(event);
			const verdict: Verdict = decide(turn, guard.streak, mode.config);
			if (verdict.progress) {
				guard.streak = { empties: 0, truncations: 0 };
				guard.gaveUp = { empty: false, truncation: false };
				return undefined;
			}
			if (verdict.action === "none") return undefined;

			const model = ctx.model as { name?: string; provider?: string } | undefined;
			const who = [model?.provider, model?.name].filter(Boolean).join("/") || "the model";
			const tier = verdict.tier === "truncation" ? "truncation" : "empty";
			const cutOff = tier === "truncation";
			const countKey: keyof Streak = cutOff ? "truncations" : "empties";
			const limit = cutOff ? mode.config.maxTruncationRetries : mode.config.maxRetries;

			if (verdict.action === "give-up") {
				if (guard.gaveUp[tier]) return undefined;
				guard.gaveUp[tier] = true;
				appendLog({
					ts: new Date().toISOString(),
					action: "gave-up",
					code: verdict.code,
					reason: verdict.reason,
					attempts: verdict.attempts,
					thinking: currentLevel(pi),
					model: model?.name,
					provider: model?.provider,
				});
				try {
					ctx.ui.notify(
						cutOff
							? `settle-guard: ${who} was cut off mid-answer again. Stopped retrying — press continue, and it will keep happening until reasoning is off.`
							: `settle-guard: ${who} ended ${verdict.attempts + 1} turns in a row without an answer. Stopped retrying — press continue, or lower the thinking level.`,
						"warning",
					);
				} catch {
					// a UI that cannot speak is not a reason to skip the log line above
				}
				return undefined;
			}

			guard.streak[countKey] += 1;
			if (cutOff) guard.cutOff += 1;
			else guard.empties += 1;
			guard.retries += 1;
			// Logged before the change: the level worth correlating with a dead turn
			// is the one that turn ran with, not the retry's.
			const levelBefore = currentLevel(pi);
			if (mode.config.thinkingOnRetry === "off") {
				try {
					const level = pi.getThinkingLevel();
					if (level !== "off") {
						guard.saved = level;
						pi.setThinkingLevel("off");
					}
				} catch {
					guard.saved = null;
				}
			}
			appendLog({
				ts: new Date().toISOString(),
				action: "retry",
				code: verdict.code,
				reason: verdict.reason,
				attempts: guard.streak[countKey],
				thinking: levelBefore,
				model: model?.name,
				provider: model?.provider,
			});
			try {
				ctx.ui.notify(
					`settle-guard: ${who} ${cutOff ? "was cut off mid-answer" : "gave an empty turn"} (${verdict.reason}), retrying (${guard.streak[countKey]}/${limit}).`,
					"info",
				);
			} catch {
				// notification is a courtesy; the retry is the point
			}
			guard.awaitingRetry = true;
			return {
				// The entry is what makes the continuation runnable; Pi refuses the
				// ask without one. Hidden, so it does not clutter the transcript.
				entries: [{
					type: "custom_message",
					customType: cutOff ? "settle-guard/retry-cutoff" : "settle-guard/retry",
					content: nudgeFor(verdict.tier),
					display: false,
				}],
				continue: true,
			};
		} catch {
			return undefined;
		}
	});

	pi.registerCommand("settle-guard", {
		description: "Show settle-guard state: empty turns caught, retries asked, log location",
		handler: async (_args, ctx) => {
			try {
				ctx.ui.notify(statusLines(mode, guard).join("\n"), "info");
			} catch {
				// a command that cannot print has already written the log line
			}
		},
	});
}

function currentLevel(pi: ExtensionAPI): ThinkingLevel | "unknown" {
	try {
		return pi.getThinkingLevel() as ThinkingLevel;
	} catch {
		return "unknown";
	}
}
