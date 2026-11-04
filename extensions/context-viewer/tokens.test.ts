/**
 * The cost model, on its own. The important cases are where attribution could
 * silently lie: content that is counted twice, content that is counted nowhere,
 * and a table whose rows stop adding up to its header.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";

import { findPiInstallNodeModulesDir } from "../../test-support/hooks.mjs";

import { blockChars, buildBudget, CATEGORIES, estimateMessage } from "./tokens.ts";

const text = (value: string) => ({ type: "text", text: value });

describe("estimateMessage", () => {
	it("counts user text at one token per four characters", () => {
		assert.equal(estimateMessage({ role: "user", content: "a".repeat(40) }), 10);
		assert.equal(estimateMessage({ role: "user", content: [text("a".repeat(18))] }), 5);
	});

	it("counts the arguments the model wrote, not the call id", () => {
		// The id and any signature are transport, not context the model paid for.
		const message = {
			role: "assistant",
			content: [{ type: "toolCall", id: "toolu_01ABC", name: "read", arguments: { path: "a/b.md" } }],
		};
		const expected = Math.ceil(("read".length + JSON.stringify({ path: "a/b.md" }).length) / 4);
		assert.equal(estimateMessage(message), expected);
	});

	it("counts thinking, which is the block users forget is in the window", () => {
		assert.equal(estimateMessage({ role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(400) }] }), 100);
	});

	it("charges an image the host's fixed allowance, not its base64 length", () => {
		const image = { role: "user", content: [{ type: "image", data: "AAAA".repeat(100000), mimeType: "image/png" }] };
		assert.equal(estimateMessage(image), 1200);
	});

	it("counts a bash execution as its command plus its output", () => {
		const message = { role: "bashExecution", command: "ls".padEnd(8, " "), output: "o".repeat(12) };
		assert.equal(estimateMessage(message), 5);
	});

	it("counts summaries, which are the whole point of compaction", () => {
		assert.equal(estimateMessage({ role: "compactionSummary", summary: "s".repeat(80) }), 20);
		assert.equal(estimateMessage({ role: "branchSummary", summary: "s".repeat(40) }), 10);
	});

	it("never throws and never invents cost for a shape it does not know", () => {
		assert.equal(estimateMessage({ role: "fromTheFuture", whatever: true }), 0);
		assert.equal(estimateMessage({}), 0);
		assert.equal(estimateMessage(undefined as never), 0);
		assert.equal(estimateMessage({ role: "user", content: 42 as never }), 0);
	});

	it("treats a missing tool-call payload as its name alone", () => {
		assert.equal(estimateMessage({ role: "assistant", content: [{ type: "toolCall", name: "bash" }] }), 1);
	});
});

describe("blockChars", () => {
	it("is zero for blocks that carry no text", () => {
		assert.equal(blockChars({}), 0);
		assert.equal(blockChars(null), 0);
		assert.equal(blockChars(undefined), 0);
		assert.equal(blockChars({ type: "redacted_thinking" }), 0);
	});
});

describe("buildBudget", () => {
	const base = {
		systemPrompt: "s".repeat(4000),
		tools: [{ name: "read", parameters: { type: "object" } }],
		messages: [
			{ role: "user", content: "u".repeat(400) },
			{ role: "assistant", content: [{ type: "thinking", thinking: "t".repeat(400) }] },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }] },
			{ role: "toolResult", toolName: "read", content: [text("r".repeat(4000))] },
		],
	};

	it("puts each category where its cost actually is", () => {
		const budget = buildBudget({ ...base, usageTokens: null, contextWindow: 0 });
		const row = (category: string) => budget.rows.find((entry) => entry.category === category)?.tokens ?? 0;
		assert.equal(row("systemPrompt"), 1000);
		assert.equal(row("user"), 100);
		assert.equal(row("thinking"), 100);
		assert.equal(row("toolResults"), 1000);
		assert.ok(row("toolDefinitions") > 0);
		assert.ok(row("toolCalls") > 0);
	});

	it("keeps unrecognised content in one honest bucket instead of dropping it", () => {
		const budget = buildBudget({
			messages: [{ role: "fromTheFuture", content: "x".repeat(40) } as never],
		});
		assert.equal(budget.rows.find((row) => row.category === "other")?.tokens, 10);
	});

	it("scales the split to the measured total so the rows add up", () => {
		const budget = buildBudget({ ...base, usageTokens: 100000, contextWindow: 200000 });
		const sum = budget.rows.reduce((total, row) => total + row.tokens, 0);
		assert.equal(sum, 100000);
		assert.equal(budget.measured, true);
		assert.ok(budget.rows.every((row) => row.tokens >= 0));
	});

	it("leaves estimates unscaled when the host has reported nothing", () => {
		const budget = buildBudget({ ...base, usageTokens: null, contextWindow: 200000 });
		assert.equal(budget.measured, false);
		assert.equal(budget.estimatedTotal, budget.rows.reduce((total, row) => total + row.tokens, 0));
	});

	it("never divides by a zero total", () => {
		const budget = buildBudget({ usageTokens: 0, contextWindow: 0, messages: [] });
		assert.equal(budget.rows.length, 0);
		assert.equal(budget.percent, null);
		assert.equal(budget.free, 0);
	});

	it("reports free space and the distance to compaction", () => {
		const budget = buildBudget({ ...base, usageTokens: 50000, contextWindow: 200000, reserveTokens: 16384 });
		assert.equal(budget.free, 150000);
		assert.equal(budget.untilCompaction, 133616);
		assert.equal(budget.percent, 25);
	});

	it("names the biggest items by their position in the Messages tab", () => {
		const budget = buildBudget({ ...base, usageTokens: 100000, contextWindow: 200000 });
		assert.ok(budget.largest.length > 0);
		assert.equal(budget.largest[0].index, 3, "the tool result is the largest message");
		const sorted = [...budget.largest].sort((a, b) => b.tokens - a.tokens);
		assert.deepEqual(
			budget.largest.map((item) => item.index),
			sorted.map((item) => item.index),
		);
	});

	it("counts images without letting them vanish from the split", () => {
		const budget = buildBudget({
			messages: [{ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }],
			usageTokens: null,
		});
		assert.equal(budget.images, 1);
		assert.equal(budget.rows.find((row) => row.category === "user")?.tokens, 1200);
	});

	it("survives the junk a session file can contain", () => {
		const budget = buildBudget({
			systemPrompt: undefined,
			tools: [null as never, undefined as never, { name: "ok" }],
			messages: [null as never, { role: "user" } as never, { role: "user", content: null as never }],
			usageTokens: Number.NaN,
		});
		assert.ok(Number.isFinite(budget.estimatedTotal));
		assert.ok(CATEGORIES.length > 0);
	});

	it("absorbs rounding into one row rather than lying about the total", () => {
		// Three equal categories and a total that does not divide by three.
		const budget = buildBudget({
			messages: [
				{ role: "user", content: "u".repeat(401) },
				{ role: "toolResult", content: [text("r".repeat(401))] },
				{ role: "assistant", content: [{ type: "thinking", thinking: "t".repeat(401) }] },
			],
			usageTokens: 100,
			contextWindow: 1000,
		});
		assert.equal(
			budget.rows.reduce((total, row) => total + row.tokens, 0),
			100,
		);
	});
});

/**
 * The estimator is a copy of a rule that lives in the host: compaction charges
 * text at one token per four characters and an image at a fixed allowance. If
 * that copy drifts, this panel's numbers stop being comparable with the
 * percentage in the status bar, so the rule is checked against the host's own
 * function — read straight out of the installed Pi, in a subprocess, because the
 * test loader hijacks `@earendil-works/*` resolution and the package's own
 * sub-imports do not survive it.
 */
const ORACLE_SCRIPT = `
let data = "";
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", async () => {
  const modulePath = process.env.PI_COMPACTION_PATH;
  const { pathToFileURL } = await import("node:url");
  const mod = await import(pathToFileURL(modulePath).href);
  const messages = JSON.parse(data);
  process.stdout.write(JSON.stringify(messages.map((message) => mod.estimateTokens(message))));
});
`;

function hostEstimates(messages: unknown[]): number[] | undefined {
	const nodeModules = findPiInstallNodeModulesDir();
	if (!nodeModules) return undefined;
	const compaction = join(nodeModules, "@earendil-works", "pi-coding-agent", "dist", "core", "compaction", "compaction.js");
	if (!existsSync(compaction)) return undefined;
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "-e", ORACLE_SCRIPT],
		{ input: JSON.stringify(messages), env: { ...process.env, PI_COMPACTION_PATH: compaction }, encoding: "utf8" },
	);
	if (result.status !== 0) return undefined;
	return JSON.parse(result.stdout) as number[];
}

const ORACLE_MESSAGES: unknown[] = [
	{ role: "user", content: "hello there" },
	{ role: "user", content: [{ type: "text", text: "block content" }, { type: "image", data: "AAAA", mimeType: "image/png" }] },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "pondering" },
			{ type: "text", text: "an answer" },
			{ type: "toolCall", id: "1", name: "read", arguments: { path: "a/b.ts", offset: 1 } },
		],
	},
	{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "file body" }] },
	{ role: "custom", customType: "x", content: "injected", display: false },
	{ role: "bashExecution", command: "ls -la", output: "total 8", exitCode: 0, cancelled: false, truncated: false },
	{ role: "compactionSummary", summary: "the earlier part", tokensBefore: 99999 },
	{ role: "branchSummary", summary: "the other branch", fromId: null },
];

describe("agreement with the host's own estimator", () => {
	it("matches pi's estimateTokens on every shape a session can hold", (t) => {
		const host = hostEstimates(ORACLE_MESSAGES);
		if (!host) {
			t.skip("the installed Pi's compaction module is not readable, so there is nothing to compare against");
			return;
		}
		ORACLE_MESSAGES.forEach((message, index) => {
			assert.equal(
				estimateMessage(message as never),
				host[index],
				`estimator disagrees with the host on ${JSON.stringify(message).slice(0, 100)}`,
			);
		});
	});

	it("agrees on the thing the host is most likely to change: the image allowance", (t) => {
		const host = hostEstimates([{ role: "user", content: [{ type: "image", data: "A", mimeType: "image/png" }] }]);
		if (!host) {
			t.skip("no host module to compare against");
			return;
		}
		assert.equal(estimateMessage({ role: "user", content: [{ type: "image", data: "A", mimeType: "image/png" }] } as never), host[0]);
	});
});
