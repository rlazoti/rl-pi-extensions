/**
 * The text every tab is made of. These are the assertions that keep the panel
 * honest: the table has to add up to the number in its own header, nothing may
 * overflow the frame, and what is estimated has to say so on the same screen.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ContextBudget } from "./tokens.ts";
import {
	describeSchema,
	findMatches,
	formatNumber,
	formatPercent,
	formatTokens,
	numberCell,
	renderBudget,
	renderGauge,
	breakLine,
	renderMessages,
	renderRaw,
	renderSystemPrompt,
	renderTools,
	wrapText,
} from "./text.ts";

function budget(overrides: Partial<ContextBudget> = {}): ContextBudget {
	return {
		total: 42000,
		contextWindow: 200000,
		measured: true,
		percent: 21,
		free: 158000,
		untilCompaction: 141616,
		reserveTokens: 16384,
		estimatedTotal: 41000,
		messages: 42,
		images: 0,
		rows: [
			{ category: "systemPrompt", label: "System prompt", tokens: 12000, estimated: 11500, percent: 28.6 },
			{ category: "toolDefinitions", label: "System tools", tokens: 6000, estimated: 5750, percent: 14.3 },
			{ category: "toolResults", label: "Tool results", tokens: 12000, estimated: 11500, percent: 28.6 },
			{ category: "assistant", label: "Assistant text", tokens: 3000, estimated: 2875, percent: 7.1 },
			{ category: "user", label: "Your messages", tokens: 3000, estimated: 2875, percent: 7.1 },
			{ category: "thinking", label: "Thinking", tokens: 3000, estimated: 2875, percent: 7.2 },
			{ category: "other", label: "Other", tokens: 3000, estimated: 2875, percent: 7.1 },
		],
		largest: [{ index: 14, tokens: 12000, label: "result read /very/long/path/that/should/be/collapsed.ts" }],
		...overrides,
	};
}

/**
 * The tokens column, read back out of the rendered table by the column position
 * of its own header. The point is that a human adding up the column gets the
 * number printed above it, so the test parses the panel rather than the model.
 */
/** Wrapped prose reads as one sentence. */
function flatten(lines: string[]): string {
	// Wrapped prose, with the hanging indent of a continued note removed: a
	// sentence that only matched at one panel width would be a width test.
	return lines.join(" ").replace(/·/g, " ").replace(/\s+/g, " ");
}

/**
 * The tokens column, read back out of the rendered table at the column position
 * of its own header: a human adding the column up has to get the number in the
 * header, so the test parses the panel rather than the model behind it.
 */
function tokensColumn(lines: string[]): number[] {
	const header = lines.find((line) => line.includes("tokens") && line.includes("share"));
	assert.ok(header, "no table header was rendered");
	const at = header.indexOf("tokens");
	// The table is the run of rows between the header and the blank line that
	// ends it; the largest-items list below the table carries percentages too.
	const rows: string[] = [];
	for (const line of lines.slice(lines.indexOf(header) + 1)) {
		if (line.trim() === "") break;
		if (line.startsWith("─")) continue;
		rows.push(line);
	}
	return rows.map((line) => parseCell(line.slice(at, at + 10).trim()));
}

function parseCell(cell: string): number {
	const token = cell.trim().split(/\s+/)[0] ?? "";
	assert.match(token, /^[\d.]+[kM]?$/, `"${cell}" is not a token count cell`);
	const multiplier = token.endsWith("k") ? 1000 : token.endsWith("M") ? 1_000_000 : 1;
	return Math.round(Number(token.replace(/[kM]/, "")) * multiplier);
}

describe("number formatting", () => {
	it("keeps a token count to one table cell", () => {
		assert.equal(formatTokens(940), "940");
		assert.equal(formatTokens(1234), "1.2k");
		assert.equal(formatTokens(42318), "42.3k");
		assert.equal(formatTokens(1500000), "1.5M");
		assert.equal(formatTokens(0), "0");
		assert.equal(formatTokens(null), "—");
	});

	it("groups large numbers without the platform's locale getting involved", () => {
		assert.equal(formatNumber(1234567), "1,234,567");
		assert.equal(formatNumber(null), "—");
		assert.equal(formatPercent(21.256), "21.3%");
		assert.equal(formatPercent(null), "—");
		assert.equal(numberCell("9", 4), "   9");
		assert.equal(numberCell("way too long", 4), "way too long");
	});
});

describe("renderGauge", () => {
	it("shows a partial cell rather than rounding an almost-empty bar away", () => {
		assert.match(renderGauge(0.5, 40), /^▂░{39}$/);
		assert.equal(renderGauge(0, 10), "░".repeat(10));
		assert.equal(renderGauge(100, 10), "█".repeat(10));
	});

	it("renders something when the percentage itself is unknown", () => {
		assert.equal(renderGauge(null, 6), "······");
	});

	it("clamps a nonsense percentage instead of drawing past the frame", () => {
		assert.equal(renderGauge(150, 5), "█████");
		assert.equal(renderGauge(-20, 5), "░░░░░");
	});
});

describe("renderBudget", () => {
	it("states usage in the same words the status bar uses", () => {
		const lines = renderBudget(budget(), { model: "anthropic/claude-x" });
		assert.equal(lines[0], "Model             anthropic/claude-x");
		assert.equal(lines[1], "Usage             42,000 tokens");
		assert.match(lines[2], /^Context size      200,000 tokens$/);
		assert.match(lines.find((line) => line.startsWith("Compaction")) ?? "", /183,616 tokens \(reserve 16,384\).*141,616/);
	});

	it("gives each header figure one line and one label", () => {
		// "Context used 42,000 tokens" underneath "Usage 42,000 tokens" is the
		// duplicate this must never print: one number, one line, one label.
		const lines = renderBudget(budget(), { model: "m/x" });
		const labels = lines
			.filter((line) => /^[A-Z][a-z ]+\s{2,}\S/.test(line))
			.map((line) => line.match(/^[A-Z][a-z ]+/)?.[0]?.trim());
		assert.equal(new Set(labels).size, labels.length, `duplicated label in: ${labels.join(", ")}`);
		assert.equal(lines.filter((line) => /^Usage\s/.test(line)).length, 1);
		assert.equal(lines.some((line) => /tokens.*tokens/.test(line)), false);
	});

	it("prints a table whose columns add up to the number in its header", () => {
		const lines = renderBudget(budget(), {});
		assert.ok(lines.includes("Where the tokens went"));
		const column = tokensColumn(lines);
		assert.equal(column.length, 7);
		// The panel rounds each cell to 2-3 digits, so the sum is allowed to be off
		// by a cell per row — but it must not be off by a whole category.
		const slack = column.length * 500;
		assert.ok(
			Math.abs(column.reduce((total, tokens) => total + tokens, 0) - budget().total) < slack,
			`column sums to ${column.reduce((a, b) => a + b, 0)}, header says ${budget().total}`,
		);
	});

	it("says on the number itself when it is an estimate rather than a measurement", () => {
		const lines = renderBudget(budget({ measured: false, percent: null }), {});
		assert.match(lines[0], /^Usage             42,000 tokens.*not measured, estimated from text/);
		assert.match(flatten(lines), /estimate from text size/);
		// And not at all when the provider did report a number.
		assert.equal(renderBudget(budget(), {}).some((line) => /not measured/.test(line)), false);
	});

	it("explains where the split came from when it is scaled to the measurement", () => {
		const lines = renderBudget(budget(), {});
		assert.match(flatten(lines), /scaled to add up to it/);
	});

	it("admits when the context size is unknown rather than inventing one", () => {
		const lines = renderBudget(budget({ contextWindow: 0, percent: null, untilCompaction: null, untilCompactionPlaceholder: undefined } as never), {});
		assert.ok(lines.includes("Context size      unknown for this model"));
		assert.equal(lines.some((line) => line.includes("Compaction")), false);
	});

	it("keeps every line inside the frame, whatever it is handed", () => {
		const wide = budget({
			largest: [{ index: 1, tokens: 9_999_999, label: "x".repeat(500) }],
			rows: [{ category: "other", label: "A category name longer than the table wants to be", tokens: 1, estimated: 1, percent: 0.0001 }],
		});
		for (const width of [40, 60, 100, 160]) {
			for (const line of renderBudget(wide, { width, model: "m".repeat(200) })) {
				assert.ok(line.length <= width, `line of ${line.length} columns overflows a ${width}-column panel: ${line.slice(0, 60)}`);
			}
		}
	});

	it("lists the largest items with the index the Messages tab uses", () => {
		const lines = renderBudget(budget(), {});
		const item = lines.find((line) => line.startsWith("# 14"));
		assert.ok(item, `no largest-item line in:\n${lines.join("\n")}`);
		assert.match(item, /read \/very\/long\/path.*\.ts/);
	});

	it("reports images with the allowance they were charged at", () => {
		const lines = renderBudget(budget({ images: 3 }), {});
		assert.match(lines.join("\n"), /3 image block\(s\).*1\.2k/);
	});

	it("shows what could not be read instead of hiding it", () => {
		const lines = renderBudget(budget(), { problems: ["could not read the session: EACCES"] });
		assert.ok(lines.some((line) => line.includes("could not read the session: EACCES")));
	});

	it("has an honest empty state", () => {
		const lines = renderBudget(budget({ rows: [], total: 0, percent: null, largest: [], measured: false, messages: 0 }), {});
		assert.match(flatten(lines), /nothing to count yet/);
	});
});

describe("describeSchema", () => {
	it("marks which parameters the model has to supply", () => {
		const lines = describeSchema({
			type: "object",
			properties: {
				command: { type: "string", description: "The command to run" },
				timeout: { type: "number" },
			},
			required: ["command"],
		});
		assert.deepEqual(lines, ["command: string — The command to run", "timeout?: number"]);
	});

	it("expands arrays, enums and unions", () => {
		const lines = describeSchema({
			type: "object",
			properties: {
				mode: { type: "string", enum: ["log", "block"] },
				paths: { type: "array", items: { type: "string" } },
				pick: { anyOf: [{ type: "string" }, { type: "number" }] },
				files: { type: "array", items: { type: "object", properties: { path: { type: "string" } } } },
			},
		});
		assert.match(lines.join("\n"), /mode\?: string "log"\|"block"/);
		assert.match(lines.join("\n"), /paths\?: array/);
		assert.match(lines.join("\n"), /pick\?: string \| number/);
		assert.match(lines.join("\n"), /files\?:/);
	});

	it("falls back to the raw schema rather than showing nothing", () => {
		assert.deepEqual(describeSchema(undefined), ["(no schema)"]);
		assert.deepEqual(describeSchema({ type: "object" }), ['{"type":"object"}']);
		assert.deepEqual(describeSchema("nonsense"), ['"nonsense"']);
	});
});

describe("renderTools", () => {
	it("shows what the model was actually told about each tool", () => {
		const lines = renderTools([
			{
				name: "bash",
				description: "Run a shell command",
				parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
				promptGuidelines: ["Prefer absolute paths."],
			},
		]);
		const text = lines.join("\n");
		assert.match(text, /1 tool\(s\) declared to the model/);
		assert.match(text, /^── bash$/m);
		assert.match(text, /Run a shell command/);
		assert.match(text, /command: string/);
		assert.match(text, /Prefer absolute paths\./);
	});

	it("has an empty state", () => {
		assert.deepEqual(renderTools([]), ["(no tools declared to the model)"]);
	});
});

describe("renderMessages", () => {
	it("names every message by index, role and estimated cost", () => {
		const lines = renderMessages([{ role: "user", content: "hello" }]);
		assert.match(lines[0], /^━━ #0 user · ~2$/);
		assert.equal(lines[1], "  hello");
	});

	it("renders each block type without losing it", () => {
		const lines = renderMessages([
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "answer" },
					{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
					{ type: "image", mimeType: "image/png", data: "AAAA" },
					{ type: "somethingNew" },
				],
			},
		]);
		const text = lines.join("\n");
		assert.match(text, /\[thinking 3 chars\]/);
		assert.match(text, /^  answer$/m);
		assert.match(text, /\[tool call read\]/);
		assert.match(text, /"path": "a\.ts"/);
		assert.match(text, /\[image image\/png\]/);
		assert.match(text, /\[somethingNew\]/);
	});

	it("renders the host-only message types too", () => {
		const lines = renderMessages([
			{ role: "bashExecution", command: "ls", output: "file\nfile2" },
			{ role: "compactionSummary", summary: "the earlier part" },
			{ role: "toolResult", toolName: "read", isError: true, content: [{ type: "text", text: "boom" }] },
		]);
		const text = lines.join("\n");
		assert.match(text, /\$ ls/);
		assert.match(text, /  file\n  file2/);
		assert.match(text, /  the earlier part/);
		assert.match(text, /toolResult · read · error/);
	});

	it("shows the reported usage of an assistant turn next to the estimate", () => {
		const lines = renderMessages([{ role: "assistant", content: [{ type: "text", text: "x" }], usage: { input: 100, output: 40 } }]);
		assert.match(lines[0], /in 100 out 40/);
	});

	it("separates messages and survives an empty context", () => {
		assert.deepEqual(renderMessages([]), ["(no messages in context)"]);
		const lines = renderMessages([{ role: "user", content: "one" }, { role: "user", content: "two" }]);
		assert.equal(lines.filter((line) => line.startsWith("━━")).length, 2);
		assert.ok(lines.includes(""));
	});
});

describe("renderSystemPrompt and renderRaw", () => {
	it("passes the prompt through unchanged, line for line", () => {
		assert.deepEqual(renderSystemPrompt("a\nb\nc"), ["a", "b", "c"]);
		assert.deepEqual(renderSystemPrompt(undefined), ["(no system prompt reported)"]);
	});

	it("emits one parseable document per line", () => {
		const lines = renderRaw({
			systemPrompt: "you are pi",
			tools: [{ name: "read", parameters: { type: "object" } }],
			messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "hello" }] }],
			usage: { tokens: 10, contextWindow: 100, percent: 10 },
		});
		const payload = lines.filter((line) => !line.startsWith("#"));
		assert.equal(payload.length, 5);
		for (const line of payload) assert.doesNotThrow(() => JSON.parse(line), line.slice(0, 40));
		const messages = payload.slice(3).map((line) => JSON.parse(line) as { role?: string; index?: number });
		assert.deepEqual(
			messages.map((message) => message.index),
			[0, 1],
		);
	});
});

describe("helpers", () => {
	it("wraps without eating words or exceeding the width", () => {
		const lines = wrapText("one two three four five six seven eight", "  ", 18);
		for (const line of lines) assert.ok(line.length <= 18, line);
		const rejoined = lines.join(" ").replace(/\s+/g, " ").trim();
		assert.equal(rejoined, "one two three four five six seven eight");
	});

	it("finds matches case-insensitively and never on an empty query", () => {
		const lines = ["alpha", "BETA", "gamma beta"];
		assert.deepEqual(findMatches(lines, "beta"), [1, 2]);
		assert.deepEqual(findMatches(lines, ""), []);
	});
});

/**
 * The contract the terminal imposes: one array element is one screen line. An
 * element holding a newline is drawn as two rows by the terminal but budgeted as
 * one by the overlay, which shifts every row below it, drags the frame out of
 * alignment and leaves the previous screen behind. Only the Messages tab has
 * content that is multi-line by nature, which is why it was the one that broke.
 */
describe("one array element is one screen line", () => {
	const hostileMessages = [
		{ role: "user", content: "first line\nsecond line\n\nafter a blank line" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reasoning\nover two lines" },
				{ type: "text", text: "answer\nspanning\nthree lines" },
				{ type: "toolCall", name: "bash", arguments: { command: "ls\n-la", nested: { a: 1 } } },
				{ type: "image", mimeType: "image/png" },
				{ type: "mystery", text: "unknown block\nwith a newline" },
			],
		},
		{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "out 1\nout 2" }], isError: true },
		{ role: "bashExecution", command: "echo hi\necho there", output: "hi\nthere" },
		{ role: "compactionSummary", summary: "summary line one\nline two" },
		{ role: "branchSummary", summary: "branch\nsummary" },
	];

	const noNewlines = (label: string, lines: string[]) => {
		for (const line of lines) {
			assert.ok(!line.includes("\n"), `${label}: an element holds a newline, so the overlay would miscount rows: ${JSON.stringify(line.slice(0, 60))}`);
		}
	};

	it("splits multi-line message content instead of passing it through", () => {
		noNewlines("messages", renderMessages(hostileMessages));
	});

	it("splits multi-line tool descriptions, guidelines and schemas", () => {
		noNewlines(
			"tools",
			renderTools([
				{ name: "bash", description: "Run a command.\nIt runs in a shell.", promptGuidelines: ["Prefer ls.\nNever find /."] },
				{ name: "weird", parameters: { type: "object", properties: { command: { type: "string", description: "one\ntwo" }, list: { type: "array", enum: ["a\nb"] } }, required: ["command"] } },
			]),
		);
	});

	it("splits a system prompt that contains its own blank lines", () => {
		noNewlines("system", renderSystemPrompt("You are helpful.\n\nRules:\n- one\n- two\n"));
	});

	it("keeps the raw dump one document per line even when the data is multi-line", () => {
		noNewlines("raw", renderRaw({ systemPrompt: "a\nb", tools: [{ name: "x" }], messages: hostileMessages, usage: null }));
	});

	it("wraps every budget note rather than nesting one", () => {
		noNewlines("budget", renderBudget(budget(), { problems: ["a note\nover two lines", "plain"] }));
	});
});

describe("breakLine", () => {
	it("leaves a line that fits alone", () => {
		assert.deepEqual(breakLine("short", 20), ["short"]);
		assert.deepEqual(breakLine("", 20), [""]);
	});

	it("breaks at a space and keeps every character", () => {
		const text = "the quick brown fox jumps over the lazy dog";
		const rows = breakLine(text, 10);
		for (const row of rows) assert.ok(row.length <= 10, `row too wide: ${row}`);
		// The only thing lost is the space each break stood on.
		assert.equal(rows.join(" "), text);
	});

	it("cuts through a word that is longer than the frame", () => {
		const rows = breakLine("x".repeat(25), 10);
		assert.deepEqual(rows, ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
	});

	it("makes progress at every width, including one column", () => {
		for (const width of [1, 2, 3, 7]) {
			const rows = breakLine("a bcdefg hij", width);
			assert.ok(rows.every((row) => row.length <= width), `width ${width}: ${JSON.stringify(rows)}`);
			assert.ok(rows.length > 1 && rows.join("").length > 0, `width ${width} produced ${JSON.stringify(rows)}`);
		}
	});
});
