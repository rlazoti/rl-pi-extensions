/**
 * The rule as a table. Every row is a claim about what settle-guard does and
 * does not interrupt, including the rows where it stays out of the way.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	decide,
	hasToolCall,
	looksCutOff,
	thinkingLength,
	visibleTextLength,
	type GuardConfig,
	type Streak,
	type TurnSnapshot,
} from "./rule.ts";

const CFG: GuardConfig = { maxRetries: 2, maxTruncationRetries: 1, thinkingOnRetry: "off" };

/** Streak counters: how many of each shape this streak already spent. */
const S = (empties = 0, truncations = 0): Streak => ({ empties, truncations });

const turn = (over: Partial<TurnSnapshot> = {}): TurnSnapshot => ({
	role: "assistant",
	stopReason: "stop",
	content: [{ type: "thinking", thinking: "plan" }],
	outcome: "completed",
	...over,
});

describe("visible text and tool calls", () => {
	it("counts no text in a thinking-only message", () => {
		assert.equal(visibleTextLength([{ type: "thinking", thinking: "a lot of thought" }]), 0);
	});

	it("counts whitespace as nothing", () => {
		assert.equal(visibleTextLength([{ type: "text", text: "  \n\t\n" }]), 0);
	});

	it("counts real text", () => {
		assert.equal(visibleTextLength([{ type: "text", text: "hi there" }, { type: "text", text: " and more" }]), 16);
	});

	it("finds a tool call in any block", () => {
		assert.equal(hasToolCall([{ type: "thinking", thinking: "x" }, { type: "toolCall", name: "bash" } as never]), true);
		assert.equal(hasToolCall([{ type: "text", text: "mentions bash" }]), false);
		assert.equal(hasToolCall(undefined), false);
	});

	it("measures thinking without mixing it with text", () => {
		assert.equal(thinkingLength([{ type: "thinking", thinking: "12345" }, { type: "text", text: "hi" }]), 5);
	});
});

describe("decide: the empty turn", () => {
	it("retries a thinking-only turn that stopped with no answer", () => {
		const v = decide(turn(), S(0), CFG);
		assert.equal(v.action, "retry");
		assert.equal(v.progress, false);
		assert.match(v.reason, /reasoned for 4 characters and answered nothing/);
		assert.match(v.reason, /without reasoning/);
	});

	it("retries a turn with no content at all", () => {
		const v = decide(turn({ content: [] }), S(0), CFG);
		assert.equal(v.action, "retry");
		assert.match(v.reason, /produced no text and no tool call/);
	});

	it("retries a turn whose only text is whitespace", () => {
		assert.equal(decide(turn({ content: [{ type: "text", text: "\n  \n" }] }), S(0), CFG).action, "retry");
	});

	it("says nothing about reasoning when the retry keeps the level", () => {
		const v = decide(turn(), S(), { maxRetries: 2, maxTruncationRetries: 1, thinkingOnRetry: "keep" });
		assert.equal(v.action, "retry");
		assert.doesNotMatch(v.reason, /without reasoning/);
	});
});

describe("decide: stays out of the way", () => {
	it("does not interrupt a turn that answered", () => {
		const v = decide(turn({ content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "Done." }] }), S(0), CFG);
		assert.equal(v.action, "none");
		assert.equal(v.progress, true);
	});

	it("does not interrupt a turn that called a tool, even with no text", () => {
		const v = decide(turn({ stopReason: "toolUse", content: [{ type: "toolCall" } as never] }), S(0), CFG);
		assert.equal(v.action, "none");
		assert.equal(v.progress, true);
	});

	it("does not fight Escape", () => {
		const v = decide(turn({ outcome: "aborted" }), S(0), CFG);
		assert.equal(v.action, "none");
		assert.match(v.reason, /aborted/);
	});

	it("does not double-report an error run", () => {
		assert.equal(decide(turn({ outcome: "error" }), S(0), CFG).action, "none");
	});

	it("does not retry a turn that ran out of tokens", () => {
		const v = decide(turn({ stopReason: "length" }), S(0), CFG);
		assert.equal(v.action, "none");
		assert.match(v.reason, /length/);
	});

	it("asks even though Pi reports canContinue false in exactly this state", () => {
		// Measured on the live stub: canContinue is false for the empty turn and
		// still false when the continuation is accepted, so it must not gate us.
		assert.equal(decide(turn({ canContinue: false } as never), S(0), CFG).action, "retry");
	});

	it("does nothing for a non-assistant message", () => {
		assert.equal(decide(turn({ role: "user" }), S(0), CFG).action, "none");
	});

	it("does nothing when the budget is zero", () => {
		assert.equal(decide(turn(), S(0), { maxRetries: 0, maxTruncationRetries: 0, thinkingOnRetry: "off" }).action, "none");
	});

	it("does not guess when the stop reason is missing", () => {
		const v = decide(turn({ stopReason: undefined }), S(0), CFG);
		assert.equal(v.action, "none");
		assert.match(v.reason, /missing/);
	});
});

describe("decide: the budget", () => {
	it("gives up once the retries are used, and says so", () => {
		const v = decide(turn(), S(2), CFG);
		assert.equal(v.action, "give-up");
		assert.match(v.reason, /2 retries already used/);
	});

	it("retries up to the last allowed attempt", () => {
		assert.equal(decide(turn(), S(1), CFG).action, "retry");
	});

	it("never returns retry after give-up for any larger budget mismatch", () => {
		for (const attempts of [2, 3, 10]) {
			assert.equal(decide(turn(), S(attempts), CFG).action, "give-up", `attempts=${attempts}`);
		}
	});
});

describe("decide: total function", () => {
	it("answers something for shapes it was never given", () => {
		const junk: TurnSnapshot[] = [
			{},
			{ role: "assistant" },
			{ role: "assistant", content: undefined },
			{ role: "assistant", content: null as never },
			{ role: "assistant", content: [null as never, { type: "text" } as never] },
			{ role: "assistant", content: [{ type: "thinking" } as never], stopReason: "stop" },
		];
		for (const t of junk) {
			const v = decide(t, S(0), CFG);
			assert.ok(v.action === "retry" || v.action === "none" || v.action === "give-up");
			assert.equal(typeof v.reason, "string");
		}
	});
});

describe("decide: the turn that was cut off mid-answer", () => {
	/** The measured shape: 8 of 670 such turns on the affected machine. */
	const cutText = "Let me check the tokens for the reasoning tag and `";
	const cut = (text: string): TurnSnapshot => turn({ content: [{ type: "thinking", thinking: "x" }, { type: "text", text }] });

	it("retries a turn ending with an unclosed code-span opener", () => {
		const v = decide(cut(cutText), S(), CFG);
		assert.equal(v.action, "retry");
		assert.equal(v.tier, "truncation");
		assert.equal(v.code, "truncated-text");
		assert.match(v.reason, /cut off|unclosed code span/);
	});

	it("retries a turn ending inside an unclosed span or fence", () => {
		assert.equal(decide(cut("use `open-think-tag here"), S(), CFG).tier, "truncation");
		assert.equal(decide(cut("```\nconst x = 1"), S(), CFG).tier, "truncation");
	});

	it("leaves a finished answer alone, code span and all", () => {
		// The false-positive this tier lives or dies on: a closed span is not a cut.
		for (const text of ["Run `npm test` now.", "Done: `settle-guard`.", "Two spans `a` and `b`.", "Ends with a period."]) {
			const v = decide(cut(text), S(), CFG);
			assert.equal(v.action, "none", text);
			assert.equal(v.progress, true, text);
		}
	});

	it("has its own budget, spent by cut-off turns only", () => {
		// Two empties already used does not stop a cut-off retry, and one cut-off
		// used does stop the next one even though the empty budget has room.
		assert.equal(decide(cut(cutText), S(2, 0), CFG).action, "retry");
		const spent = decide(cut(cutText), S(0, 1), CFG);
		assert.equal(spent.action, "give-up");
		assert.equal(spent.tier, "truncation");
		assert.equal(spent.code, "budget");
	});

	it("does not retry a cut-off answer that ran out of tokens", () => {
		// A `length` stop is a spent budget: retrying it doubles a long generation.
		const v = decide({ ...cut(cutText), stopReason: "length" }, S(), CFG);
		assert.equal(v.action, "none");
		assert.match(v.reason, /length/);
	});

	it("can be switched off on its own", () => {
		const v = decide(cut(cutText), S(), { maxRetries: 2, maxTruncationRetries: 0, thinkingOnRetry: "off" });
		assert.equal(v.action, "none");
	});
});

describe("looksCutOff", () => {
	it("names the three shapes and nothing else", () => {
		assert.equal(looksCutOff("and `"), "span-opener");
		assert.equal(looksCutOff("and\n`"), "span-opener");
		assert.equal(looksCutOff("a `b"), "unclosed-span");
		assert.equal(looksCutOff("```\nlet x"), "open-fence");
		assert.equal(looksCutOff("a `b` c"), null);
		assert.equal(looksCutOff("plain sentence."), null);
		assert.equal(looksCutOff(""), null);
		assert.equal(looksCutOff("   \n "), null);
	});
});
