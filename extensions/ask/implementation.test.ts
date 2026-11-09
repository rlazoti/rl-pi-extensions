import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "./implementation.ts";

type Result = { content: Array<{ text: string }>; details: Record<string, unknown> };
type Component = { render(width: number): string[]; handleInput(data: string): void };
type Tool = { name: string; execute(id: string, args: unknown, signal: undefined, update: undefined, ctx: unknown): Promise<Result> };
const question = { id: "q", label: "Choice", question: "Choose?", multi: false, options: ["A", "B"] };

function harness(keys: string[] = []) {
	let tool: Tool | undefined;
	const events: Array<{ name: string; data: unknown }> = [];
	const api = {
		registerTool(value: Tool) { tool = value; },
		getSessionName: () => "test",
		events: { emit(name: string, data: unknown) { events.push({ name, data }); } },
	};
	extension(api as never);
	assert.ok(tool);
	const ctx = {
		hasUI: true, mode: "tui",
		ui: {
			input: async () => " hello ",
			custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => Component) => {
				let result: unknown;
				const component = factory(
					{ requestRender() {}, terminal: { columns: 80, rows: 24 } },
					{ fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s },
					{}, (value) => { result = value; },
				);
				for (const width of [20, 80]) {
					for (const line of component.render(width)) {
						assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
					}
				}
				for (const key of keys) component.handleInput(key);
				return result;
			},
		},
	};
	return { tool, ctx, events };
}

test("registered ask submits a selected answer and balances Herdr events", async () => {
	const h = harness([" ", "\t", "\r"]);
	assert.equal(h.tool.name, "ask");
	const result = await h.tool.execute("id", { questions: question }, undefined, undefined, h.ctx);
	assert.deepEqual(JSON.parse(result.content[0].text), { answers: { q: [{ label: "A", value: "A" }] }, skipped: [], unanswered: [] });
	assert.deepEqual(h.events.filter(e => e.name === "herdr:blocked").map(e => e.data), [{ active: true, label: "Waiting for input" }, { active: false }]);
	assert.equal(h.events.filter(e => e.name === "notify:send").length, 1);
});

test("tabbed UI preserves multiple selections, notes, custom input, and skipped questions", async () => {
	const h = harness([" ", "j", " ", "\r", "note", "\r", "j", "\r", "custom", "\r", "\t", "s", "\r"]);
	const questions = [
		{ id: "q", label: "Many", question: "Pick?", options: ["A", "B"] },
		{ id: "skip", label: "Skip", question: "Skip?", options: ["X"] },
	];
	const result = await h.tool.execute("id", { questions }, undefined, undefined, h.ctx);
	assert.deepEqual(JSON.parse(result.content[0].text), {
		answers: { q: [{ label: "A", value: "A" }, { label: "B", value: "B", note: "note" }, { value: "custom", custom: true }] },
		skipped: ["skip"], unanswered: [],
	});
});

test("large bracketed pastes reach the result as full custom answers and notes", async () => {
	const pasted = Array.from({ length: 480 }, (_, i) => `line ${i + 1}`).join("\n");
	const paste = `\x1b[200~${pasted}\x1b[201~`;
	const custom = harness(["j", "j", "\r", paste, "\r", "\t", "\r"]);
	const answer = await custom.tool.execute("id", { questions: question }, undefined, undefined, custom.ctx);
	assert.equal(JSON.parse(answer.content[0].text).answers.q[0].value, pasted);

	const note = harness(["\r", paste, "\r", "\t", "\r"]);
	const noted = await note.tool.execute("id", { questions: question }, undefined, undefined, note.ctx);
	assert.equal(JSON.parse(noted.content[0].text).answers.q[0].note, pasted);
});

test("single free-form input returns a custom answer", async () => {
	const h = harness();
	const result = await h.tool.execute("id", { questions: { id: "q", label: "Text", question: "Why?" } }, undefined, undefined, h.ctx);
	assert.deepEqual(JSON.parse(result.content[0].text).answers, { q: [{ value: "hello", custom: true }] });
});

test("cancel and no-UI keep the installed result contract", async () => {
	const h = harness(["\x1b"]);
	const cancelled = await h.tool.execute("id", { questions: question }, undefined, undefined, h.ctx);
	assert.match(cancelled.content[0].text, /Cancelled/);
	const noUI = await h.tool.execute("id", { questions: question }, undefined, undefined, { ...h.ctx, hasUI: false });
	assert.match(noUI.content[0].text, /no UI available/);
});

test("RPC uses input for a free-form question but never opens a TUI-only component", async () => {
	const h = harness();
	const ctx = { ...h.ctx, mode: "rpc", ui: { ...h.ctx.ui, custom: async () => { throw new Error("custom must not run"); } } };
	const free = await h.tool.execute("id", { questions: { id: "q", label: "Text", question: "Why?" } }, undefined, undefined, ctx);
	assert.equal(JSON.parse(free.content[0].text).answers.q[0].value, "hello");
	const choices = await h.tool.execute("id", { questions: question }, undefined, undefined, ctx);
	assert.match(choices.content[0].text, /no UI available/);
});

test("Herdr clears blocked state when the UI throws", async () => {
	const h = harness();
	const ctx = { ...h.ctx, ui: { ...h.ctx.ui, custom: async () => { throw new Error("UI failed"); } } };
	await assert.rejects(h.tool.execute("id", { questions: question }, undefined, undefined, ctx), /UI failed/);
	assert.deepEqual(h.events.filter(e => e.name === "herdr:blocked").map(e => e.data), [{ active: true, label: "Waiting for input" }, { active: false }]);
});
