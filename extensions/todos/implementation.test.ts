/**
 * The session glue, driven through a fake Pi.
 *
 * The store, the text and the panel have their own tests; what is only visible
 * here is the *sequence* — which file a session opens, what gets put in front of
 * the model every turn, when the nudge fires, and what happens when the storage the
 * user asked for cannot be opened. A task list that breaks a session is the one
 * outcome this extension is not allowed to produce, so most of this file is about
 * failures.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { ENV_VAR, REMINDER_INTERVAL_TURNS } from "./config.ts";
import { DENSITY_SHORTCUT } from "./render.ts";
import { PLAN_NUDGE_THRESHOLD } from "./plan-nudge.ts";
import { PANEL_HEIGHT_PERCENT } from "./viewer.ts";
import { WIDGET_KEY } from "./widget.ts";
import todosExtension from "./implementation.ts";

// ── the fake Pi ──────────────────────────────────────────────────────────────

type Handler = (event: Record<string, unknown>, ctx: FakeCtx) => Promise<unknown> | unknown;

interface FakeTool {
	name: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute(...args: never[]): Promise<unknown>;
	renderCall?(args: never, theme: FakeTheme): unknown;
	renderResult?(result: never, options: { expanded: boolean }, theme: FakeTheme): unknown;
}

interface FakeCtx {
	cwd: string;
	mode: string;
	hasUI: boolean;
	sessionManager: { getSessionId(): string };
	ui: {
		notify(message: string, type?: string): void;
		setWidget(key: string, factory: unknown, options?: unknown): void;
		custom(factory: unknown, options?: unknown): Promise<unknown>;
		select(title: string, options: string[]): Promise<string | undefined>;
		confirm(title: string, message: string): Promise<boolean>;
	};
}

interface FakeTheme {
	fg(token: string, text: string): string;
	bold(text: string): string;
	strikethrough(text: string): string;
}

/** A Theme stand-in: the widgets and tool rows only need to be able to colour text. */
const theme: FakeTheme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
};

interface Options {
	cwd?: string;
	sessionId?: string;
	mode?: string;
	hasUI?: boolean;
	/** What `ctx.ui.select` answers, in order. A function sees the options it was asked with. */
	answers?: (string | undefined | ((options: string[]) => string | undefined))[];
	customResult?: unknown;
	confirmResult?: boolean;
}

function harness(options: Options = {}) {
	const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "todos-ext-"));
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, FakeTool>();
	const commands = new Map<string, { description: string; handler(...args: never[]): Promise<unknown> }>();
	const notes: { message: string; type?: string }[] = [];
	const widgetCalls: { key: string; factory: unknown; options?: unknown }[] = [];
	const customCalls: { factory: unknown; options?: unknown }[] = [];
	const selectCalls: { title: string; options: string[] }[] = [];
	const confirmCalls: { title: string; message: string }[] = [];
	const shortcuts = new Map<string, { description?: string; handler(ctx: FakeCtx): unknown }>();
	const answers = [...(options.answers ?? [])];

	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: (tool: FakeTool) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: { description: string; handler(...args: never[]): Promise<unknown> }) =>
			commands.set(name, command),
		registerShortcut: (shortcut: string, shortcutOptions: { description?: string; handler(ctx: FakeCtx): unknown }) =>
			shortcuts.set(shortcut, shortcutOptions),
	};
	todosExtension(pi as never);

	const ctx: FakeCtx = {
		cwd,
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		sessionManager: { getSessionId: () => options.sessionId ?? "session-1" },
		ui: {
			notify: (message, type) => notes.push({ message, type }),
			setWidget: (key, factory, opts) => widgetCalls.push({ key, factory, options: opts }),
			custom: async (factory, opts) => {
				customCalls.push({ factory, options: opts });
				return options.customResult;
			},
			confirm: async (title, message) => {
				confirmCalls.push({ title, message });
				return options.confirmResult ?? false;
			},
			select: async (title: string, options: string[]) => {
				// Recorded so a test can pick an option by its real label instead of
				// hardcoding a string the menu is free to reword.
				selectCalls.push({ title, options });
				const answer = answers.shift();
				return typeof answer === "function" ? answer(options) : answer;
			},
		},
	};

	const fire = (name: string, event: Record<string, unknown> = {}) => {
		const handler = handlers.get(name);
		assert.ok(handler, `the extension never subscribed to ${name}`);
		return handler(event, ctx);
	};

	/** A tool's answer, as the model sees it. */
	async function runTool(name: string, params: Record<string, unknown> = {}) {
		const tool = tools.get(name);
		assert.ok(tool, `${name} is not registered`);
		const result = (await tool.execute(
			"call-1" as never,
			params as never,
			undefined as never,
			undefined as never,
			ctx as never,
		)) as { content: Array<{ type: string; text: string }>; details: { tasks: unknown[] } };
		return { text: result.content.map((part) => part.text).join(""), details: result.details };
	}

	const taskFiles = () => readdirSync(join(cwd, ".pi", "tasks")).filter((name) => name.endsWith(".json"));
	const warnings = () => notes.filter((note) => note.type === "warning").map((note) => note.message);
	const registered = () => widgetCalls.filter((call) => call.factory !== undefined);
	const unregistered = () => widgetCalls.filter((call) => call.factory === undefined);

	/** The rows the widget is showing, painted the way the host would paint them. */
	const widgetRows = (width = 80): string[] => {
		const last = [...widgetCalls].reverse().find((call) => call.key === WIDGET_KEY);
		if (!last?.factory) return [];
		const component = (last.factory as (tui: unknown, paintTheme: FakeTheme) => { render(w: number): string[] })(
			{ requestRender: () => {} },
			theme,
		);
		// These integration checks inspect task content; the widget tests cover the frame.
		return component.render(width).slice(1);
	};

	/** Press a global shortcut the way the editor does. */
	const press = (shortcut: string) => {
		const bound = shortcuts.get(shortcut);
		assert.ok(bound, `nothing is bound to ${shortcut}`);
		return bound.handler(ctx);
	};

	return {
		cwd,
		ctx,
		tools,
		commands,
		notes,
		widgetCalls,
		customCalls,
		selectCalls,
		confirmCalls,
		fire,
		runTool,
		taskFiles,
		warnings,
		registered,
		unregistered,
		shortcuts,
		widgetRows,
		press,
		turn: (n = 1) => Promise.all(Array.from({ length: n }, () => fire("turn_start"))),
	};
}

let dirs: string[] = [];
const savedEnv = { ...process.env };

beforeEach(() => {
	delete process.env[ENV_VAR];
});

afterEach(async () => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
	mock.timers.reset();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "todos-ext-"));
	dirs.push(dir);
	return dir;
}

describe("opt-in continuation confirmation", () => {
	const boundary = { outcome: "completed", continue: false, entries: [], context: { contextMessages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Work remains." }] }] } };
	async function setup(confirmResult: boolean) {
		const h = harness({ cwd: tempDir(), confirmResult });
		await h.fire("session_start", { reason: "startup" });
		await h.runTool("TodoCreate", { content: "Finish the work" });
		return h;
	}
	it("never prompts without explicit opt-in, and asks just once after the next request", async () => {
		const h = await setup(true);
		await h.fire("agent_before_settle", boundary);
		assert.equal(h.confirmCalls.length, 0);
		await h.commands.get("todos")!.handler("watch" as never, h.ctx as never);
		await h.fire("before_agent_start", { messageType: "user", prompt: "continue", systemPrompt: "base" });
		const result = await h.fire("agent_before_settle", boundary) as { continue: boolean; entries: unknown[] };
		assert.equal(h.confirmCalls.length, 1);
		assert.equal(result.continue, true);
		assert.equal(result.entries.length, 1);
		await h.fire("agent_before_settle", boundary);
		assert.equal(h.confirmCalls.length, 1);
	});
	it("leaves a declined confirmation alone", async () => {
		const h = await setup(false);
		await h.commands.get("todos")!.handler("watch" as never, h.ctx as never);
		await h.fire("before_agent_start", { messageType: "user", prompt: "continue", systemPrompt: "base" });
		assert.equal(await h.fire("agent_before_settle", boundary), undefined);
		assert.equal(h.confirmCalls.length, 1);
	});
	it("does not prompt in non-interactive mode or supersede another continuation", async () => {
		const h = await setup(true);
		await h.commands.get("todos")!.handler("watch" as never, h.ctx as never);
		await h.fire("before_agent_start", { messageType: "user", prompt: "work", systemPrompt: "base" });
		assert.equal(await h.fire("agent_before_settle", { ...boundary, continue: true }), undefined);
		assert.equal(h.confirmCalls.length, 0);
		h.ctx.hasUI = false;
		await h.commands.get("todos")!.handler("watch" as never, h.ctx as never);
		await h.fire("before_agent_start", { messageType: "user", prompt: "work", systemPrompt: "base" });
		assert.equal(await h.fire("agent_before_settle", boundary), undefined);
		assert.equal(h.confirmCalls.length, 0);
	});
	it("does not ask on error, or when only blocked tasks remain", async () => {
		const h = await setup(true);
		await h.commands.get("todos")!.handler("watch" as never, h.ctx as never);
		await h.fire("before_agent_start", { messageType: "user", prompt: "continue", systemPrompt: "base" });
		await h.fire("agent_before_settle", { ...boundary, outcome: "error" });
		assert.equal(h.confirmCalls.length, 0);
		await h.runTool("TodoUpdate", { id: "t1", status: "blocked" });
		await h.commands.get("todos")!.handler("watch" as never, h.ctx as never);
		await h.fire("before_agent_start", { messageType: "user", prompt: "continue", systemPrompt: "base" });
		await h.fire("agent_before_settle", boundary);
		assert.equal(h.confirmCalls.length, 0);
	});
});

// ── where the list lives ─────────────────────────────────────────────────────

describe("the file a session opens", () => {
	it("is one per session, under the project", async () => {
		const h = harness({ cwd: tempDir(), sessionId: "abc" });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "Write the test" });

		assert.deepEqual(h.taskFiles(), ["tasks-abc.json"]);
		assert.ok(readFileSync(join(h.cwd, ".pi", "tasks", "tasks-abc.json"), "utf-8").includes("Write the test"));
	});

	it("survives a new session in project scope, which is the point of project scope", async () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "tasks-config.json"), JSON.stringify({ taskScope: "project" }), "utf-8");

		const first = harness({ cwd, sessionId: "one" });
		await first.fire("session_start", { reason: "new" });
		await first.runTool("TodoCreate", { content: "Carry this over" });

		const second = harness({ cwd, sessionId: "two" });
		await second.fire("session_start", { reason: "new" });
		const listed = await second.runTool("TodoList");

		assert.deepEqual(first.taskFiles(), ["tasks.json"], "shared, so one file");
		assert.ok(listed.text.includes("Carry this over"), "a new session inherits the open work");
	});

	it("keeps nothing on disk when the user asked for memory, or for none", async () => {
		process.env[ENV_VAR] = "off";
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "Ephemeral" });

		assert.equal(existsSync(join(h.cwd, ".pi", "tasks")), false, "PI_TODOS=off means no file, ever");
		assert.ok((await h.runTool("TodoList")).text.includes("Ephemeral"), "the list still works in memory");
	});

	it("reports a corrupt file once and keeps the session working in memory", async () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".pi", "tasks"), { recursive: true });
		const path = join(cwd, ".pi", "tasks", "tasks-abc.json");
		writeFileSync(path, "{ not json", "utf-8");

		const h = harness({ cwd, sessionId: "abc" });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "Still working" });

		assert.equal(h.warnings().length, 1, "a broken store is said once per message, not every turn");
		assert.match(h.warnings()[0]!, /in memory/);
		assert.ok((await h.runTool("TodoList")).text.includes("Still working"));
		assert.ok(
			readdirSync(join(cwd, ".pi", "tasks")).some((name) => name.includes("corrupt")),
			"the bytes are kept, not overwritten",
		);
	});

	it("clears a memory list left behind by an earlier session", async () => {
		process.env[ENV_VAR] = "off";
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "Old session's work" });

		await h.fire("session_start", { reason: "new" });
		assert.match((await h.runTool("TodoList")).text, /No tasks/);
	});

	it("keeps the list when the session was resumed", async () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "tasks-config.json"), JSON.stringify({ taskScope: "project" }), "utf-8");

		const h = harness({ cwd, sessionId: "abc" });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "Half done" });

		await h.fire("session_start", { reason: "resume" });
		assert.ok((await h.runTool("TodoList")).text.includes("Half done"));
	});
});

// ── the four tools ───────────────────────────────────────────────────────────

describe("TodoCreate", () => {
	it("creates one task from top-level fields", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		const created = await h.runTool("TodoCreate", { content: "Add the migration", priority: "high" });

		assert.match(created.text, /Created #t1: Add the migration/);
		assert.equal(created.details.tasks.length, 1);
	});

	it("creates a batch in one call, and says which ids they got", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		const created = await h.runTool("TodoCreate", { tasks: [{ content: "A" }, { content: "B", priority: "low" }] });

		assert.match(created.text, /Created 2 tasks — #t1: A, #t2: B/);
		assert.equal(created.details.tasks.length, 2);
	});

	it("names the item it rejected instead of creating half a plan", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		const rejected = await h.runTool("TodoCreate", { tasks: [{ content: "A" }, { content: "   " }] });

		assert.match(rejected.text, /tasks\[1\] needs a non-empty content field/);
		assert.equal((await h.runTool("TodoList")).details.tasks.length, 0, "a bad batch leaves no tasks behind");
	});

	it("explains what it needs when given nothing", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		assert.match((await h.runTool("TodoCreate", {})).text, /tasks\[\] array or a top-level content/);
	});

	it("tells the model when a rule refused the task", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		const outcome = await h.runTool("TodoCreate", { content: "Orphan", parentId: "t99" });
		assert.match(outcome.text, /TodoCreate:/);
		assert.ok(outcome.text.length > 12, "the reason has to be readable, not just a failure");
	});
});

describe("TodoList and TodoGet", () => {
	it("says there is nothing and what to do about it", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		assert.match((await h.runTool("TodoList")).text, /No tasks\. Use TodoCreate/);
	});

	it("answers with the list the model can act on", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { tasks: [{ content: "A" }, { content: "B" }] });
		await h.runTool("TodoUpdate", { id: "t2", addBlockedBy: ["t1"] });

		const listed = await h.runTool("TodoList");
		assert.match(listed.text, /\[pending\] \[medium\] #t1 A \[ready\]/);
		assert.match(listed.text, /#t2 B \[blocked by #t1\]/);
	});

	it("says a task does not exist rather than returning nothing", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		assert.match((await h.runTool("TodoGet", { id: "t7" })).text, /No task #t7\. Call TodoList/);
	});

	it("reads one task back in full", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "Investigate", description: "why is it slow" });
		const detail = await h.runTool("TodoGet", { id: "t1" });

		assert.match(detail.text, /Task #t1: Investigate/);
		assert.match(detail.text, /Description: why is it slow/);
	});
});

describe("TodoUpdate", () => {
	it("reports which fields it changed", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "A" });
		const updated = await h.runTool("TodoUpdate", { id: "t1", status: "in_progress" });

		assert.equal(updated.text, "Updated #t1: status");
	});

	it("says the task is gone", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		assert.match((await h.runTool("TodoUpdate", { id: "t1", status: "completed" })).text, /No task #t1/);
	});

	it("refuses a cycle and says why, in the result", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { tasks: [{ content: "A" }, { content: "B" }] });
		await h.runTool("TodoUpdate", { id: "t1", addBlockedBy: ["t2"] });
		const cycle = await h.runTool("TodoUpdate", { id: "t2", addBlockedBy: ["t1"] });

		assert.match(cycle.text, /TodoUpdate:/);
		assert.match(cycle.text, /cycle/i);
	});

	it("deletes with status deleted", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "A" });
		await h.runTool("TodoUpdate", { id: "t1", status: "deleted" });

		assert.equal((await h.runTool("TodoList")).details.tasks.length, 0);
	});

	it("shows the row it painted through renderCall and renderResult", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "A" });
		const tool = h.tools.get("TodoUpdate")!;
		const call = tool.renderCall!({ id: "t1", status: "completed" } as never, theme as never);
		const result = await h.runTool("TodoUpdate", { id: "t1", status: "completed" });
		const painted = tool.renderResult!(result as never, { expanded: false }, theme as never);

		assert.ok(call instanceof Object);
		assert.ok(painted instanceof Object);
	});
});

// ── what goes into the model's context ──────────────────────────────────────

describe("the system prompt", () => {
	it("puts the open work in front of the model", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "Write the test" });

		const injected = (await h.fire("before_agent_start", { systemPrompt: "You are Pi." })) as { systemPrompt: string };
		assert.ok(injected.systemPrompt.startsWith("You are Pi."));
		assert.match(injected.systemPrompt, /## Current Task List/);
		assert.match(injected.systemPrompt, /Write the test/);
	});

	it("says nothing when there is no open work, because every turn costs", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		assert.equal(await h.fire("before_agent_start", { systemPrompt: "You are Pi." }), undefined);

		await h.runTool("TodoCreate", { content: "Done already" });
		await h.runTool("TodoUpdate", { id: "t1", status: "completed" });
		assert.equal(await h.fire("before_agent_start", { systemPrompt: "You are Pi." }), undefined);
	});

	it("mentions each tool in its own guidance", () => {
		const h = harness({ cwd: tempDir() });
		const create = h.tools.get("TodoCreate")!;
		assert.ok(create.description.includes("TodoCreate"));
		assert.ok(create.promptGuidelines!.length >= 2);
		assert.ok(h.tools.get("TodoList")!.promptSnippet);
		assert.ok(h.tools.get("TodoGet")!.promptSnippet);
		assert.ok(h.tools.get("TodoUpdate")!.promptSnippet);
	});
});

describe("the nudge", () => {
	it("leaves a task tool's own result alone", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "A" });
		await h.turn(REMINDER_INTERVAL_TURNS);

		const result = await h.fire("tool_result", { toolName: "TodoList", content: [] });
		assert.equal(result, undefined, "the task tools are the behaviour, not the reminder's subject");
	});

	it("comes once, after a quiet stretch, and only when there is work to track", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "A" });

		assert.equal(await h.fire("tool_result", { toolName: "read", content: [{ type: "text", text: "file" }] }), undefined);
		await h.turn(REMINDER_INTERVAL_TURNS);

		const nudged = (await h.fire("tool_result", { toolName: "read", content: [{ type: "text", text: "file" }] })) as {
			content: Array<{ text: string }>;
		};
		assert.equal(nudged.content.length, 2);
		assert.match(nudged.content[1]!.text, /<system-reminder>/);
		assert.match(nudged.content[1]!.text, /TodoUpdate/);

		await h.turn(REMINDER_INTERVAL_TURNS);
		assert.equal(
			await h.fire("tool_result", { toolName: "read", content: [] }),
			undefined,
			"twice in a row would be nagging",
		);
	});

	it("stays quiet when the list is empty", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.turn(REMINDER_INTERVAL_TURNS + 2);

		assert.equal(await h.fire("tool_result", { toolName: "read", content: [] }), undefined);
	});

	it("stops nudging after the model uses a task tool", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "A" });
		await h.turn(REMINDER_INTERVAL_TURNS);
		await h.fire("tool_result", { toolName: "read", content: [] });

		await h.runTool("TodoList");
		await h.turn(REMINDER_INTERVAL_TURNS);
		assert.equal(
			await h.fire("tool_result", { toolName: "read", content: [] }),
			undefined,
			"a model that is already tracking needs no reminder",
		);
	});
});

// ── the plan nudge ───────────────────────────────────────────────────────────

describe("the plan nudge", () => {
	/** A file change on a fresh turn — the unit the rule counts. */
	async function work(h: ReturnType<typeof harness>, tool = "edit") {
		await h.turn();
		return h.fire("tool_result", { toolName: tool, content: [{ type: "text", text: "patched" }] });
	}

	it("asks on the third turn of file changes, never on a batch in one turn", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.turn();

		// Three writes in one turn is one job. Both live sessions did exactly this
		// and rightly ignored the ask, so the trigger is the turn, not the call.
		for (let i = 0; i < PLAN_NUDGE_THRESHOLD; i++) {
			assert.equal(
				await h.fire("tool_result", { toolName: "write", content: [{ type: "text", text: "wrote" }] }),
				undefined,
				"three files, one turn: no ask",
			);
		}

		assert.equal(await work(h), undefined, "a second turn of work");
		const asked = (await work(h, "write")) as { content: Array<{ text: string }> };
		assert.equal(asked.content.length, 2, "it rides on the result, it is not its own message");
		assert.match(asked.content[1]!.text, /separate turns/);
		assert.match(asked.content[1]!.text, /TodoCreate/);

		for (let i = 0; i < PLAN_NUDGE_THRESHOLD; i++) {
			assert.equal(
				await work(h),
				undefined,
				"a model that ignores the ask is not nagged again",
			);
		}
	});

	it("never speaks to a session that is only reading", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });

		for (let i = 0; i < PLAN_NUDGE_THRESHOLD * 3; i++) {
			assert.equal(await work(h, "read"), undefined);
		}
	});

	it("never speaks to a session that already planned", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "A" });

		// Three turns is the plan threshold; staying under four keeps the other
		// reminder (which this list *should* earn) out of the assertion.
		for (let i = 0; i < PLAN_NUDGE_THRESHOLD; i++) {
			assert.equal(await work(h), undefined);
		}
	});

	it("carries the plan ask, not the quiet-turns one, once a list has gone", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "A" });
		await h.runTool("TodoUpdate", { id: "t1", status: "deleted" });
		await h.turn(REMINDER_INTERVAL_TURNS * 2);

		for (let i = 0; i < PLAN_NUDGE_THRESHOLD - 1; i++) {
			assert.equal(await work(h), undefined);
		}
		const asked = (await work(h)) as { content: Array<{ text: string }> };
		assert.match(asked.content.at(-1)!.text, /separate turns/);
		assert.doesNotMatch(
			asked.content.at(-1)!.text,
			/Task tools have not been used recently/,
			"an empty list has nothing to come back to",
		);
	});

	it("is inert when the config says planNudge: false", async () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "tasks-config.json"), JSON.stringify({ planNudge: false }), "utf-8");
		const h = harness({ cwd });
		await h.fire("session_start", { reason: "new" });

		for (let i = 0; i < PLAN_NUDGE_THRESHOLD * 2; i++) {
			assert.equal(await work(h), undefined);
		}
	});
});

// ── the widget and the row ───────────────────────────────────────────────────

describe("the widget", () => {
	it("appears above the editor when there is a list, and goes when the list goes", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		assert.deepEqual(h.registered(), [], "an empty session loses no row");

		const created = await h.runTool("TodoCreate", { content: "A" });
		assert.equal(h.registered().length, 1);
		assert.equal(h.registered()[0]!.key, "rl-todos", "namespaced, so another extension keeps its row");

		await h.runTool("TodoUpdate", { id: "t1", status: "deleted" });
		assert.ok(h.unregistered().length >= 1, `${created.text} — the row must not outlive the list`);
	});

	it("gives the row back on shutdown", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "A" });
		await h.fire("session_shutdown", {});

		assert.ok(h.unregistered().length >= 1);
	});
});

// ── the density shortcut ──────────────────────────────────────────────────────

/**
 * One key trades widget rows for output rows. The parts worth pinning are the
 * ones a reader cannot see from the code: that the key the overflow line names is
 * the key that is actually bound, that the config sets where a session starts and
 * not where it stays, and that a session which pressed the key keeps its choice
 * across every hook that re-reads the file.
 */
describe("the density shortcut", () => {
	it("is bound to the key the widget's own overflow rows name", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });

		assert.ok(h.shortcuts.has(DENSITY_SHORTCUT), `${DENSITY_SHORTCUT} is not bound`);
		assert.match(h.shortcuts.get(DENSITY_SHORTCUT)!.description ?? "", /task widget/i);
	});

	it("cycles the widget down and round, and says where it landed", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { tasks: [{ content: "One" }, { content: "Two" }, { content: "Three" }] });
		await h.runTool("TodoUpdate", { id: "t1", status: "in_progress" });
		assert.equal(h.widgetRows().length, 4, "the tally and three rows");

		await h.press(DENSITY_SHORTCUT);
		const attention = h.widgetRows();
		assert.match(h.notes.at(-1)!.message, /attention/);
		assert.equal(attention.length, 3, "the tally, the one task that is moving, and the two dropped ones counted");
		assert.equal(attention.join(" | ").includes("Two"), false, "the queue is what the key buys back");
		assert.match(attention.at(2)!, /2 more/);

		await h.press(DENSITY_SHORTCUT);
		assert.match(h.notes.at(-1)!.message, /minimal/);
		const minimal = h.widgetRows();
		assert.equal(minimal.length, 1);
		assert.match(minimal[0]!, /3 tasks/, "and the counts survive the last row going");

		await h.press(DENSITY_SHORTCUT);
		assert.match(h.notes.at(-1)!.message, /full/);
		assert.equal(h.widgetRows().length, 4, "and the rows come back");
	});

	it("has nothing to contract when there is no list, and says so", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });

		await h.press(DENSITY_SHORTCUT);
		assert.match(h.notes.at(-1)!.message, /No task list/);
		assert.deepEqual(h.registered(), [], "pressing the key must not create a row");
	});

	it("starts a session at the configured density", async () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "tasks-config.json"), JSON.stringify({ widgetDensity: "attention" }), "utf-8");
		const h = harness({ cwd });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { tasks: [{ content: "One" }, { content: "Two" }] });

		assert.match(h.widgetRows().join(" | "), /nothing needs attention/, "the config chose the shape, not a keypress");
	});

	it("offers the density in the settings menu and applies it to this session", async () => {
		const cwd = tempDir();
		const h = harness({
			cwd,
			answers: ["Widget rows: full", (list) => list.find((entry) => entry.startsWith("minimal")), undefined],
		});
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { tasks: [{ content: "One" }, { content: "Two" }] });
		await h.commands.get("todos")!.handler("settings" as never, h.ctx as never);

		assert.ok(
			h.selectCalls[0]!.options.some((entry) => entry === "Widget rows: full"),
			"the menu is where a setting is findable",
		);
		assert.match(h.selectCalls[1]!.title, new RegExp(DENSITY_SHORTCUT.replace("+", "\\+")), "and it names the key");
		assert.equal(JSON.parse(readFileSync(join(cwd, ".pi", "tasks-config.json"), "utf-8")).widgetDensity, "minimal");
		assert.equal(h.widgetRows().length, 1, "chosen in this session, so it takes effect in this session");
		assert.ok(h.notes.some((note) => note.message.includes('Widget rows are now "minimal"')));
	});

	it("applies the configured density when explicitly reselected after a shortcut", async () => {
		const h = harness({
			cwd: tempDir(),
			answers: ["Widget rows: full", (list) => list.find((entry) => entry.startsWith("full")), undefined],
		});
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { tasks: [{ content: "One" }, { content: "Two" }] });
		await h.press(DENSITY_SHORTCUT);
		assert.match(h.widgetRows().join(" | "), /nothing needs attention/);
		await h.commands.get("todos")!.handler("settings" as never, h.ctx as never);
		assert.equal(h.widgetRows().length, 3, "explicitly choosing full restores both task rows");
		await h.turn();
		assert.equal(h.widgetRows().length, 3, "the selection survives config reload");
	});

	it("starts the next session at the configured density again", async () => {
		// `dispose` puts the widget back to full, so a session after a shutdown would
		// otherwise inherit neither the keypress nor the file — the worst of both.
		const cwd = tempDir();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "tasks-config.json"), JSON.stringify({ widgetDensity: "minimal" }), "utf-8");
		const h = harness({ cwd });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { tasks: [{ content: "One" }, { content: "Two" }] });
		await h.press(DENSITY_SHORTCUT);
		assert.equal(h.widgetRows().length, 3, "minimal cycles to full, so this session is looking at everything");

		await h.fire("session_shutdown", {});
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { tasks: [{ content: "Three" }, { content: "Four" }] });
		assert.equal(h.widgetRows().length, 1, "back to what the file says, not to full");
	});

	it("keeps the session's own cycle when the config is read again", async () => {
		// Every turn re-reads `.pi/tasks-config.json`. If that read also re-applied the
		// density, a contraction would silently undo itself at the next prompt.
		const cwd = tempDir();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "tasks-config.json"), JSON.stringify({ widgetDensity: "attention" }), "utf-8");
		const h = harness({ cwd });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { tasks: [{ content: "One" }, { content: "Two" }] });

		await h.press(DENSITY_SHORTCUT);
		assert.equal(h.widgetRows().length, 1, "attention → minimal");
		await h.turn(2);
		await h.runTool("TodoList");

		assert.equal(h.widgetRows().length, 1, "a config re-read must not undo the keypress");
		const notes = h.notes.map((note) => note.message);
		assert.equal(notes.filter((message) => /Tasks widget:/.test(message)).length, 1, "no second announcement");
		await h.press(DENSITY_SHORTCUT);
		assert.match(h.notes.at(-1)!.message, /full/, "and the cycle carries on from there, not from the file");
	});

	it("survives a host whose notify throws, with the change still applied", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "One" });
		h.ctx.ui.notify = () => {
			throw new Error("no notification channel");
		};

		await h.press(DENSITY_SHORTCUT);
		assert.equal(h.widgetRows().length, 2, "the density changed even though nobody could be told");
		assert.match(h.widgetRows()[0]!, /1 task/);
	});
});

// ── /todos ───────────────────────────────────────────────────────────────────

describe("/todos", () => {
	it("answers a session with no panel in one message", async () => {
		const h = harness({ cwd: tempDir(), mode: "print", hasUI: false });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { content: "A" });

		await h.commands.get("todos")!.handler("" as never, h.ctx as never);
		assert.match(h.notes.at(-1)!.message, /\[pending\] \[medium\] #t1 A/);
		assert.equal(h.customCalls.length, 0, "a panel nobody can see is worse than a line of text");
	});

	it("says there is nothing to open", async () => {
		const h = harness({ cwd: tempDir(), mode: "print", hasUI: false });
		await h.fire("session_start", { reason: "new" });
		await h.commands.get("todos")!.handler("" as never, h.ctx as never);
		assert.match(h.notes.at(-1)!.message, /No tasks/);
	});

	it("opens the panel over the editor", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.commands.get("todos")!.handler("" as never, h.ctx as never);

		assert.equal(h.customCalls.length, 1);
		assert.deepEqual((h.customCalls[0]!.options as { overlay: boolean }).overlay, true);
	});

	it("tells the host the height the viewer budgets rows with", async () => {
		// The host cuts every line past maxHeight while the viewer sizes itself from a
		// constant of its own: two numbers that drift apart lose the footer keys. One
		// constant is exported and used in both places, and this pin keeps them equal.
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.commands.get("todos")!.handler("" as never, h.ctx as never);
		const options = h.customCalls[0]!.options as { overlayOptions: { maxHeight: string } };
		assert.deepEqual(options.overlayOptions.maxHeight, `${PANEL_HEIGHT_PERCENT}%`);
	});

	it("clears finished work on request", async () => {
		const h = harness({ cwd: tempDir(), mode: "print", hasUI: false });
		await h.fire("session_start", { reason: "new" });
		await h.runTool("TodoCreate", { tasks: [{ content: "A" }, { content: "B" }] });
		await h.runTool("TodoUpdate", { id: "t1", status: "completed" });

		await h.commands.get("todos")!.handler("clear" as never, h.ctx as never);
		assert.match(h.notes.at(-1)!.message, /Cleared 1 completed/);
		assert.equal((await h.runTool("TodoList")).details.tasks.length, 1, "the open task stayed");
	});

	it("says so for an argument it does not know, then still shows the list", async () => {
		const h = harness({ cwd: tempDir() });
		await h.fire("session_start", { reason: "new" });
		await h.commands.get("todos")!.handler("shrubberies" as never, h.ctx as never);

		assert.match(h.warnings().at(-1)!, /unknown argument "shrubberies"/);
		assert.equal(h.customCalls.length, 1);
	});

	it("says settings needs a panel when there is none", async () => {
		const h = harness({ cwd: tempDir(), mode: "print", hasUI: false });
		await h.fire("session_start", { reason: "new" });
		await h.commands.get("todos")!.handler("settings" as never, h.ctx as never);
		assert.match(h.warnings().at(-1)!, /interactive session/);
	});

	it("writes the settings the user picks, and nothing when they back out", async () => {
		const cwd = tempDir();
		const picked = harness({ cwd, answers: ["Task storage: session", "memory  — nothing on disk — the list is gone when the session ends", "Close"] });
		await picked.fire("session_start", { reason: "new" });
		await picked.commands.get("todos")!.handler("settings" as never, picked.ctx as never);

		const saved = JSON.parse(readFileSync(join(cwd, ".pi", "tasks-config.json"), "utf-8"));
		assert.equal(saved.taskScope, "memory");
		assert.ok(picked.notes.some((note) => note.message.includes('Task storage is now "memory"')));

		const backed = harness({ cwd, answers: [undefined] });
		await backed.fire("session_start", { reason: "new" });
		await backed.commands.get("todos")!.handler("settings" as never, backed.ctx as never);
		assert.equal(JSON.parse(readFileSync(join(cwd, ".pi", "tasks-config.json"), "utf-8")).taskScope, "memory");
	});

	it("offers the plan nudge and switches it off for this session too", async () => {
		const cwd = tempDir();
		const h = harness({
			cwd,
			answers: ["Plan nudge: on", (options) => options.find((option) => option.startsWith("off"))],
		});
		await h.fire("session_start", { reason: "new" });
		await h.commands.get("todos")!.handler("settings" as never, h.ctx as never);

		assert.ok(
			h.selectCalls[0]!.options.some((option) => option === "Plan nudge: on"),
			"the menu is where a flag is findable",
		);
		assert.equal(JSON.parse(readFileSync(join(cwd, ".pi", "tasks-config.json"), "utf-8")).planNudge, false);
		assert.ok(h.notes.some((note) => note.message === 'Plan nudge is now "off".'));

		for (const _ of Array.from({ length: PLAN_NUDGE_THRESHOLD * 2 })) {
			await h.turn();
			assert.equal(
				await h.fire("tool_result", { toolName: "edit", content: [{ type: "text", text: "patched" }] }),
				undefined,
				"storage waits for the next session; this rule does not",
			);
		}
	});
});
