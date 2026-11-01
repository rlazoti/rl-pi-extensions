/**
 * The rule as a table. Every row is a claim about what settle-guard does and
 * does not interrupt, including the rows where it stays out of the way.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decide, hasToolCall, thinkingLength, visibleTextLength, type GuardConfig, type TurnSnapshot } from "./rule.ts";

const CFG: GuardConfig = { maxRetries: 2, thinkingOnRetry: "off" };

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
		const v = decide(turn(), 0, CFG);
		assert.equal(v.action, "retry");
		assert.equal(v.progress, false);
		assert.match(v.reason, /reasoned for 4 characters and answered nothing/);
		assert.match(v.reason, /without reasoning/);
	});

	it("retries a turn with no content at all", () => {
		const v = decide(turn({ content: [] }), 0, CFG);
		assert.equal(v.action, "retry");
		assert.match(v.reason, /produced no text and no tool call/);
	});

	it("retries a turn whose only text is whitespace", () => {
		assert.equal(decide(turn({ content: [{ type: "text", text: "\n  \n" }] }), 0, CFG).action, "retry");
	});

	it("says nothing about reasoning when the retry keeps the level", () => {
		const v = decide(turn(), 0, { maxRetries: 2, thinkingOnRetry: "keep" });
		assert.equal(v.action, "retry");
		assert.doesNotMatch(v.reason, /without reasoning/);
	});
});

describe("decide: stays out of the way", () => {
	it("does not interrupt a turn that answered", () => {
		const v = decide(turn({ content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "Done." }] }), 0, CFG);
		assert.equal(v.action, "none");
		assert.equal(v.progress, true);
	});

	it("does not interrupt a turn that called a tool, even with no text", () => {
		const v = decide(turn({ stopReason: "toolUse", content: [{ type: "toolCall" } as never] }), 0, CFG);
		assert.equal(v.action, "none");
		assert.equal(v.progress, true);
	});

	it("does not fight Escape", () => {
		const v = decide(turn({ outcome: "aborted" }), 0, CFG);
		assert.equal(v.action, "none");
		assert.match(v.reason, /aborted/);
	});

	it("does not double-report an error run", () => {
		assert.equal(decide(turn({ outcome: "error" }), 0, CFG).action, "none");
	});

	it("does not retry a turn that ran out of tokens", () => {
		const v = decide(turn({ stopReason: "length" }), 0, CFG);
		assert.equal(v.action, "none");
		assert.match(v.reason, /length/);
	});

	it("asks even though Pi reports canContinue false in exactly this state", () => {
		// Measured on the live stub: canContinue is false for the empty turn and
		// still false when the continuation is accepted, so it must not gate us.
		assert.equal(decide(turn({ canContinue: false } as never), 0, CFG).action, "retry");
	});

	it("does nothing for a non-assistant message", () => {
		assert.equal(decide(turn({ role: "user" }), 0, CFG).action, "none");
	});

	it("does nothing when the budget is zero", () => {
		assert.equal(decide(turn(), 0, { maxRetries: 0, thinkingOnRetry: "off" }).action, "none");
	});

	it("does not guess when the stop reason is missing", () => {
		const v = decide(turn({ stopReason: undefined }), 0, CFG);
		assert.equal(v.action, "none");
		assert.match(v.reason, /missing/);
	});
});

describe("decide: the budget", () => {
	it("gives up once the retries are used, and says so", () => {
		const v = decide(turn(), 2, CFG);
		assert.equal(v.action, "give-up");
		assert.match(v.reason, /2 retries already used/);
	});

	it("retries up to the last allowed attempt", () => {
		assert.equal(decide(turn(), 1, CFG).action, "retry");
	});

	it("never returns retry after give-up for any larger budget mismatch", () => {
		for (const attempts of [2, 3, 10]) {
			assert.equal(decide(turn(), attempts, CFG).action, "give-up", `attempts=${attempts}`);
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
			const v = decide(t, 0, CFG);
			assert.ok(v.action === "retry" || v.action === "none" || v.action === "give-up");
			assert.equal(typeof v.reason, "string");
		}
	});
});
