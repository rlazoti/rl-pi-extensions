import assert from "node:assert/strict";
import test from "node:test";

import { CARRY_MARKER, pruneMemoryBlocks, type ContextMessageLike } from "./context.ts";

/**
 * The context handler's job, tested on the messages themselves: Pi hands the
 * whole conversation to every model call, so a memory block written on turn 1 is
 * still sent on turn 40 (R25.1, D24).
 */

const BLOCK = (n: number, opts: { retrieved?: boolean; timestamp?: number } = {}): ContextMessageLike => ({
	role: "custom",
	customType: "memory",
	display: false,
	timestamp: opts.timestamp ?? n * 1000,
	content: [`## Memory — rules and facts for this context (project: github.com/rlazoti/x)`, ``, `### Always-on rules`, `- [rule · global · 2026-01-0${n}] rule.${n}: block ${n}`, ...(opts.retrieved === false ? [] : [``, `### Related claims`, `- [fact · global · 2026-01-0${n}] fact.${n}: retrieved because it matched the request`])].join("\n"),
} as ContextMessageLike);

const user = (text: string): ContextMessageLike => ({ role: "user", content: [{ type: "text", text }] }) as ContextMessageLike;
const memoryOf = (messages: ContextMessageLike[]): string[] => messages.filter((message) => message.customType === "memory").map((message) => String(message.content));

test("context: no memory block, nothing to do", () => {
	const messages = [user("hello"), user("again")];
	const result = pruneMemoryBlocks(messages);
	assert.deepEqual(result.messages, messages);
	assert.equal(result.sample.blocks, 0);
	assert.equal(result.sample.droppedBlocks, 0);
});

test("context: of several blocks only the newest is sent, and everything else keeps its place", () => {
	const messages = [user("one"), BLOCK(1, { retrieved: true }), user("two"), BLOCK(2, { retrieved: true }), user("three"), BLOCK(3, { retrieved: true })];
	const result = pruneMemoryBlocks(messages);
	assert.deepEqual(memoryOf(result.messages).length, 1);
	assert.match(String(result.messages.at(-1)!.content), /block 3/);
	// The user turns are untouched and in order.
	assert.deepEqual(result.messages.filter((message) => message.role === "user").map((message) => (message.content as { text: string }[])[0]!.text), ["one", "two", "three"]);
	assert.deepEqual(result.messages.map((message) => message.role), ["user", "user", "user", "custom"]);
	assert.equal(result.sample.blocks, 3);
	assert.equal(result.sample.keptBlocks, 1);
	assert.equal(result.sample.droppedBlocks, 2);
	assert.ok(result.sample.droppedTokens > 0);
	assert.equal(result.sample.carried, false);
});

test("context: a turn that retrieved nothing keeps the newest block that did (D24)", () => {
	// The short follow-up: "yes" matches nothing, so the claims that answered the
	// previous turn would vanish from the middle of a task.
	const messages = [user("how do I name a branch"), BLOCK(1, { retrieved: true }), user("yes"), BLOCK(2, { retrieved: false })];
	const result = pruneMemoryBlocks(messages);
	const kept = memoryOf(result.messages);
	assert.equal(kept.length, 2, "the newest block, plus the newest one carrying retrieved claims");
	assert.match(kept[0]!, /block 1/);
	assert.ok(kept[0]!.includes(CARRY_MARKER), "the carried block is marked");
	assert.ok(kept[0]!.startsWith(CARRY_MARKER), "the carried block is marked, so the model knows which turn it is from");
	assert.ok(!kept[1]!.includes(CARRY_MARKER), "the newest block is sent as it was written");
	assert.match(kept[1]!, /block 2/);
	assert.equal(result.sample.carried, true);
	assert.equal(result.sample.keptBlocks, 2);
});

test("context: two turns that retrieved nothing carry one block back, never two", () => {
	const messages = [BLOCK(1, { retrieved: true }), BLOCK(2, { retrieved: false }), BLOCK(3, { retrieved: false })];
	const result = pruneMemoryBlocks(messages);
	const kept = memoryOf(result.messages);
	assert.equal(kept.length, 2);
	assert.match(kept[0]!, /block 1/);
	assert.match(kept[1]!, /block 3/);
});

test("context: nothing was ever retrieved, so only the newest block goes", () => {
	const messages = [BLOCK(1, { retrieved: false }), BLOCK(2, { retrieved: false })];
	const result = pruneMemoryBlocks(messages);
	const kept = memoryOf(result.messages);
	assert.equal(kept.length, 1);
	assert.match(kept[0]!, /block 2/);
	assert.equal(result.sample.carried, false);
});

test("context: only the newest block exists and it retrieved something", () => {
	const messages = [user("q"), BLOCK(1, { retrieved: true })];
	const result = pruneMemoryBlocks(messages);
	assert.equal(result.sample.blocks, 1);
	assert.equal(result.sample.keptBlocks, 1);
	assert.equal(result.sample.droppedBlocks, 0);
	// Nothing was rewritten, so the same objects come back.
	assert.equal(result.messages[1], messages[1]);
});

test("context: another extension's custom message is not ours to drop", () => {
	const other = { role: "custom", customType: "herdr-status", content: "not memory", timestamp: 5 } as ContextMessageLike;
	const messages = [other, BLOCK(1, { retrieved: true }), other];
	const result = pruneMemoryBlocks(messages);
	assert.deepEqual(result.messages.filter((message) => message.customType === "herdr-status").length, 2);
	assert.equal(result.sample.blocks, 1);
});

test("context: a block whose content is a block array is kept whole and never rewritten", () => {
	const arrayBlock = { role: "custom", customType: "memory", timestamp: 9, content: [{ type: "text", text: "## Memory — rules and facts for this context (project: x)\n### Related claims\n- one" }] } as ContextMessageLike;
	const messages = [arrayBlock, BLOCK(2, { retrieved: false })];
	const result = pruneMemoryBlocks(messages);
	// The array block is the only one that retrieved, so it is the carried one.
	const kept = result.messages.find((message) => message === arrayBlock);
	assert.ok(kept, "the array block survived");
	assert.deepEqual(kept!.content, arrayBlock.content, "a block this module cannot reproduce is sent byte for byte, with no marker glued on");
	assert.equal(result.sample.carried, true, "it is still the carried block");
});

test("context: pruning is stable, so the same conversation always sends the same thing", () => {
	const messages = [BLOCK(1, { retrieved: true }), BLOCK(2, { retrieved: false }), BLOCK(3, { retrieved: false })];
	const first = pruneMemoryBlocks(messages);
	const second = pruneMemoryBlocks(first.messages);
	assert.deepEqual(second.messages.map((message) => message.timestamp), first.messages.map((message) => message.timestamp));
	assert.equal(second.sample.droppedBlocks, 0, "pruning twice drops nothing more");
});
