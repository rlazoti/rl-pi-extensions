import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "./implementation.ts";

type Result = { content: Array<{ text: string }>; details: Record<string, unknown> };
type Component = { render(width: number): string[]; handleInput(data: string): void };
type Tool = { name: string; execute(id: string, args: unknown, signal: undefined, update: undefined, ctx: unknown): Promise<Result> };
const question = { id: "q", label: "Choice", question: "Choose?", multi: false, options: ["A", "B"] };

/** Everything the panel rendered after the keys were sent, for asserting on the confirm screen. */
type Captured = { narrow: string[]; wide: string[] };

function harness(keys: string[] = []) {
	let tool: Tool | undefined;
	const events: Array<{ name: string; data: unknown }> = [];
	const captured: Captured = { narrow: [], wide: [] };
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
				// One element of a render() array is one terminal row: a line wider than the
				// frame wraps into two, and one holding a newline is painted as two whatever
				// its width, shifting every row under it.
				const check = (label: string, width: number) => {
					for (const line of component.render(width)) {
						assert.ok(!line.includes("\n"), `${label} ${width}: line contains a newline: ${JSON.stringify(line)}`);
						assert.ok(visibleWidth(line) <= width, `${label} ${width}: ${line}`);
					}
				};
				check("before", 20);
				check("before", 80);
				for (const key of keys) component.handleInput(key);
				captured.narrow = component.render(20);
				captured.wide = component.render(80);
				check("after", 20);
				check("after", 80);
				return result;
			},
		},
	};
	return { tool, ctx, events, captured };
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

// ─── Notes that belong to a question, or to the whole ask ────────────────────

const twoQuestions = [
	{ id: "q1", label: "Strategy", question: "Which strategy?", multi: false, options: ["Fast", "Safe"] },
	{ id: "q2", label: "Rollout", question: "Roll out how?", options: ["Canary", "Big bang"] },
];

/** The result text is prose lines above one JSON line; split them the way the model reads them. */
function read(result: Result): { lines: string[]; json: any } {
	const all = result.content[0].text.split("\n");
	const jsonIndex = all.findIndex((l) => l.startsWith("{"));
	return { lines: all.slice(0, jsonIndex), json: JSON.parse(all.slice(jsonIndex).join("\n")) };
}

test("a shared note reaches the model as a line about everything, not as another answer", async () => {
	const h = harness([" ", "\t", "\t", "n", "nothing ships without tests", "\r", "\r"]);
	const result = await h.tool.execute("id", { questions: twoQuestions }, undefined, undefined, h.ctx);
	const { lines, json } = read(result);
	assert.deepEqual(lines, ["User note: nothing ships without tests"]);
	assert.equal(json.note, "nothing ships without tests");
	assert.deepEqual(json.answers.q1, [{ label: "Fast", value: "Fast" }]);
});

test("n on the Done tab edits the note instead of submitting an empty one", async () => {
	const h = harness(["\t", "\t", "n", "typed while on Done", "\r", "\r"]);
	const result = await h.tool.execute("id", { questions: twoQuestions }, undefined, undefined, h.ctx);
	assert.match(result.content[0].text, /User note: typed while on Done/);
	assert.equal(read(result).json.note, "typed while on Done");
});

test("Escape closes the note editor with nothing saved and the previous note intact", async () => {
	const h = harness(["n", "the real note", "\r", "n", "abandoned draft", "\x1b", "\t", "\t", "\r"]);
	const result = await h.tool.execute("id", { questions: twoQuestions }, undefined, undefined, h.ctx);
	assert.equal(read(result).json.note, "the real note");
	assert.ok(!result.content[0].text.includes("abandoned"), result.content[0].text);
});

test("reopening the note editor prefills it, so Enter alone keeps the note", async () => {
	const h = harness(["n", "keep me", "\r", "n", "\r", "\t", "\t", "\r"]);
	const result = await h.tool.execute("id", { questions: twoQuestions }, undefined, undefined, h.ctx);
	assert.equal(read(result).json.note, "keep me");
});

test("clearing the note text takes it out of the result entirely", async () => {
	// The editor reopens prefilled, so clearing means deleting what is there — a blank
	// Enter would keep the note, which is what makes Enter-on-reopen safe.
	const draft = "to be removed";
	const h = harness(["n", draft, "\r", "n", ...Array(draft.length).fill("\x7f"), "\r", "\t", "\t", "\r"]);
	const result = await h.tool.execute("id", { questions: twoQuestions }, undefined, undefined, h.ctx);
	const { lines, json } = read(result);
	assert.deepEqual(lines, []);
	assert.equal("note" in json, false);
});

test("m annotates one question without picking an option, and names it in the result", async () => {
	const h = harness(["m", "only the strategy question matters", "\r", "\t", "\t", "\r"]);
	const result = await h.tool.execute("id", { questions: twoQuestions }, undefined, undefined, h.ctx);
	const { lines, json } = read(result);
	assert.deepEqual(json.questionNotes, { q1: "only the strategy question matters" });
	assert.deepEqual(lines, ['User note on q1 ("Which strategy?"): only the strategy question matters']);
	assert.deepEqual(json.unanswered, ["q1", "q2"]);
});

test("both notes are written for the model, one per question that has one", async () => {
	const h = harness(["m", "first note", "\r", "\t", "m", "second note", "\r", "n", "shared note", "\r", "\t", "\r"]);
	const result = await h.tool.execute("id", { questions: twoQuestions }, undefined, undefined, h.ctx);
	assert.deepEqual(read(result).lines, [
		"User note: shared note",
		'User note on q1 ("Which strategy?"): first note',
		'User note on q2 ("Roll out how?"): second note',
	]);
});

test("the confirm screen shows every note that is about to be sent", async () => {
	const h = harness([" ", "\r", "an option note", "\r", "m", "a question note", "\r", "n", "a shared note", "\r", "\t", "\t"]);
	await h.tool.execute("id", { questions: twoQuestions }, undefined, undefined, h.ctx);
	const summary = h.captured.wide.join("\n");
	assert.match(summary, /an option note/);
	assert.match(summary, /a question note/);
	assert.match(summary, /a shared note/);
});

test("the Done tab offers the note when there is none, so it is discoverable", async () => {
	const h = harness(["\t", "\t"]);
	await h.tool.execute("id", { questions: twoQuestions }, undefined, undefined, h.ctx);
	assert.match(h.captured.wide.join("\n"), /note: \(none — n to add\)/);
});

test("a pasted multi-line answer is folded into one terminal row", async () => {
	const pasted = "line one\nline two\x1b[31m\x07line three";
	const h = harness(["j", "j", "\r", pasted, "\r"]);
	await h.tool.execute("id", { questions: twoQuestions }, undefined, undefined, h.ctx);
	assert.match(h.captured.wide.join("\n"), /line one line two line three/);
});

test("the transcript renderer names the note beside the question it qualifies", async () => {
	const h = harness();
	const theme = { fg: (_name: string, s: string) => s, bg: (_name: string, s: string) => s, bold: (s: string) => s };
	const renderResult = (h.tool as unknown as { renderResult(r: unknown, o: unknown, t: unknown): { render(w: number): string[] } }).renderResult;
	const rendered = renderResult(
		{
			details: {
				questions: { q1: "Which strategy?" },
				answers: { q1: [{ label: "Fast", value: "Fast" }] },
				skipped: [],
				unanswered: [],
				questionNotes: { q1: "asked on the strategy tab" },
				note: "applies to all",
			},
		},
		undefined,
		theme,
	).render(80).join("\n");
	assert.match(rendered, /Which strategy\?: Fast/);
	assert.match(rendered, /Which strategy\? note: "asked on the strategy tab"/);
	assert.match(rendered, /note: "applies to all"/);
});
