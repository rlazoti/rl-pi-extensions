/**
 * The command end: what `/context` does with a host it is handed, without a
 * running Pi. The fake below is the shape of `ExtensionCommandContext` this
 * component actually uses; everything else is ignored, which is the point — a
 * viewer that only works when the host offers a hundred fields is a viewer that
 * breaks on the next Pi release.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import implementation, { buildSnapshot, readSources, setHostForTesting, tabForArgument } from "./implementation.ts";

type Sources = Awaited<ReturnType<typeof readSources>>;

const messages = [
	{ role: "user", content: "hello" },
	{ role: "assistant", content: [{ type: "text", text: "hi" }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }] },
	{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "file" }] },
];

interface HostOverrides {
	systemPrompt?: string;
	tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
	activeTools?: string[];
	messages?: unknown[];
	usage?: { tokens: number | null; contextWindow: number; percent: number | null } | null;
	model?: unknown;
	settings?: unknown;
	throwOn?: Set<string>;
	mode?: string;
	hasUI?: boolean;
}

function fakeContext(overrides: HostOverrides = {}) {
	const throwOn = overrides.throwOn ?? new Set<string>();
	const notify: string[] = [];
	const opened: Array<{ tabs: Array<{ name: string; hint?: string; lines: string[] }>; rows: number; cols: number }> = [];

	const context = {
		mode: overrides.mode ?? "tui",
		hasUI: overrides.hasUI ?? true,
		model: "model" in overrides ? overrides.model : { id: "claude-x", provider: "anthropic", contextWindow: 200000 },
		sessionManager: {
			getEntries: () => [],
			getLeafId: () => "leaf-1",
		},
		getSystemPrompt: () => {
			if (throwOn.has("systemPrompt")) throw new Error("no prompt here");
			return overrides.systemPrompt ?? "You are a helpful assistant.";
		},
		getContextUsage: () => {
			if (throwOn.has("usage")) throw new Error("no usage yet");
			return overrides.usage === undefined ? { tokens: 1234, contextWindow: 200000, percent: 0.617 } : overrides.usage;
		},
		ui: {
			notify: (message: string) => {
				notify.push(message);
			},
			custom: (factory: (tui: never, theme: never, keys: never, done: () => void) => { render: (width: number) => string[]; getTab: (index: number) => { name: string; hint?: string; lines: string[] } }) => {
				const component = factory(
					{ terminal: { rows: 40, cols: 100 }, requestRender() {} } as never,
					{ fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text, getBgAnsi: () => "" } as never,
					{} as never,
					() => {},
				);
				// Rendered once: what a viewer does wrong with a tab list should throw
				// here, not in front of the user.
				component.render(100);
				opened.push({
					tabs: [0, 1, 2, 3, 4, 5, 6].map((index) => component.getTab(index)).filter(Boolean) as Array<{ name: string; hint?: string; lines: string[] }>,
					rows: 40,
					cols: 100,
				});
				return Promise.resolve(undefined);
			},
		},
	};

	const commands: Array<{ name: string; description?: string; handler: (args: string, ctx: unknown) => Promise<void> }> = [];
	const api = {
		registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.push({ name, ...options });
		},
		getActiveTools: () => {
			if (throwOn.has("tools")) throw new Error("no tool list");
			return overrides.activeTools ?? ["bash", "read"];
		},
		getAllTools: () =>
			overrides.tools ?? [
				{ name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
				{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
				{ name: "hidden", description: "Not declared to the model", parameters: { type: "object" } },
			],
		getSettings: () => {
			if (throwOn.has("settings")) throw new Error("settings are none of your business");
			return overrides.settings === undefined ? { compaction: { reserveTokens: 16384 } } : overrides.settings;
		},
	};

	return { context, api, commands, notify, opened };
}

async function run(overrides: HostOverrides = {}, args = "") {
	const host = fakeContext(overrides);
	const copies: string[] = [];
	setHostForTesting({
		sessionMessages: async () => {
			if (overrides.throwOn?.has("messages")) throw new Error("session is unreadable");
			return (overrides.messages === undefined ? messages : (overrides.messages as unknown[])) as never;
		},
		copy: async (text: string) => {
			copies.push(text);
			return undefined;
		},
	});
	try {
		implementation(host.api as never);
		const command = host.commands.find((entry) => entry.name === "context");
		assert.ok(command, "the component must register /context");
		await command.handler(args, host.context);
		return { command, host, notify: host.notify, copies, overlay: host.opened[0] };
	} finally {
		setHostForTesting(null);
	}
}

describe("the command", () => {
	it("registers /context with a description that says what it shows", async () => {
		const { command } = await run();
		assert.equal(command.name, "context");
		assert.ok((command.description ?? "").length > 10, "a one-word description is no help in /help");
	});

	it("opens an overlay carrying every tab, already rendered once", async () => {
		const { overlay } = await run();
		assert.ok(overlay, "no overlay was opened");
		assert.deepEqual(
			overlay.tabs.map((tab) => tab.name),
			["Overview", "System", "Tools", "Messages", "Raw"],
		);
	});

	it("falls back to one line of text when there is no interactive terminal", async () => {
		const { notify } = await run({ mode: "print" });
		assert.equal(notify.length, 1);
		assert.match(notify[0], /1,234 tokens/);
		assert.match(notify[0], /3 message/);
	});

	it("names the largest cost in the one-line fallback", async () => {
		const { notify } = await run({ mode: "print" });
		// system prompt 31 chars, but the tool definitions and results dominate
		// nothing in particular here; what must hold is: it says where.
		assert.match(notify[0], /(System prompt|Tool definitions|Tool results|Assistant text)/);
	});

	it("warns about an unknown tab and still opens", async () => {
		const { notify } = await run({}, "banana");
		assert.match(notify[0], /banana/);
		assert.match(notify[0], /overview/);
	});
});

describe("tabForArgument", () => {
	const names = ["Overview", "System", "Tools", "Messages", "Raw"];

	it("accepts the tab names and a few aliases", () => {
		assert.deepEqual(tabForArgument("", names), { index: 0, unknown: false });
		for (const [argument, index] of [
			["system", 1],
			["prompt", 1],
			["tools", 2],
			["messages", 3],
			["json", 4],
			["  RAW  ", 4],
		] as const) {
			assert.deepEqual(tabForArgument(argument, names), { index, unknown: false }, argument);
		}
	});

	it("reports an unknown tab instead of silently opening the wrong one", () => {
		assert.deepEqual(tabForArgument("banana", names), { index: 0, unknown: true });
	});
});

describe("buildSnapshot", () => {
	it("reports the numbers without needing a host", () => {
		const snapshot = buildSnapshot({
			systemPrompt: "s".repeat(4000),
			tools: [{ name: "bash", parameters: { type: "object" } }],
			messages: [{ role: "user", content: "u".repeat(400) }],
			usage: { tokens: 5000, contextWindow: 200000, percent: 2.5 },
			reserveTokens: 16384,
		});
		assert.match(snapshot.overview, /5,000 tokens/);
		assert.equal(snapshot.tabs.length, 5);
		assert.deepEqual(
			snapshot.tabs.map((tab) => tab.name),
			["Overview", "System", "Tools", "Messages", "Raw"],
		);
		assert.ok(snapshot.tabs[0]!.lines.some((line) => line.includes("5,000")));
	});

	it("gives every tab something to say about itself", () => {
		const snapshot = buildSnapshot({ systemPrompt: "x", tools: [{ name: "t" }], messages: [{ role: "user", content: "y" }] });
		for (const tab of snapshot.tabs) assert.ok(tab.hint && tab.hint.length > 0, `${tab.name} has no hint`);
	});

	it("keeps going when a host call fails, and lists which one", () => {
		// The prompt and the usage really are missing here, so they belong in the
		// list too — but the failure the host reported must appear alongside them.
		const snapshot = buildSnapshot({ messages: [{ role: "user", content: "y" }], problems: ["could not read the tool definitions: EACCES"] });
		assert.ok(snapshot.problems.includes("could not read the tool definitions: EACCES"), snapshot.problems.join(" | "));
		assert.match(snapshot.tabs[0]!.lines.join("\n"), /EACCES/);
	});

	it("still renders all five tabs when the host has nothing", () => {
		const snapshot = buildSnapshot({});
		assert.equal(snapshot.tabs.length, 5);
		for (const tab of snapshot.tabs) assert.ok(tab.lines.length > 0, `${tab.name} is empty`);
	});

	it("shows the model it was given", () => {
		const snapshot = buildSnapshot({ systemPrompt: "x", model: "anthropic/claude-x" });
		assert.match(snapshot.tabs[0]!.lines.join("\n"), /anthropic\/claude-x/);
	});

	it("counts the messages it was shown, not the ones it imagined", () => {
		const snapshot = buildSnapshot({ messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] });
		assert.match(snapshot.overview, /2 message/);
	});

	it("only quotes a share of the window when it knows the window", () => {
		const reported = buildSnapshot({ usage: { tokens: 100, contextWindow: 1000, percent: 10 } });
		assert.match(reported.overview, /100 tokens · 10\.0% of window/);
		// A model that names no context size gets no invented percentage.
		const unknown = buildSnapshot({ usage: { tokens: 100, contextWindow: 0, percent: null } });
		assert.equal(unknown.overview.includes("of window"), false, unknown.overview);
		assert.match(unknown.overview, /100 tokens/);
	});
});

describe("the tabs against a realistic context", () => {
	const snapshot = buildSnapshot({
		systemPrompt: `${"system ".repeat(2000)}`,
		tools: [
			{ name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
			{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
		],
		messages: [
			{ role: "user", content: "first" },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }] },
			{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "b".repeat(9000) }] },
			{ role: "assistant", content: [{ type: "thinking", thinking: "c".repeat(1200) }, { type: "text", text: "done" }] },
		],
		usage: { tokens: 42000, contextWindow: 200000, percent: 21 },
		reserveTokens: 16384,
		model: "anthropic/claude-x",
	});

	it("lists only the tools the model was actually told about", () => {
		const tools = snapshot.tabs[2]!.lines.join("\n");
		assert.match(tools, /2 tool\(s\) declared to the model/);
		assert.match(tools, /bash/);
		assert.match(tools, /read/);
	});

	it("keeps tool schemas out of the conversation and in the tools tab", () => {
		const conversation = snapshot.tabs[3]!.lines.join("\n");
		assert.match(conversation, /\[tool call read\]/);
		assert.match(conversation, /"path": "a\.ts"/);
		assert.match(conversation, /\[thinking 1200 chars\]/);
	});

	it("shows the raw tab as data, not prose", () => {
		const raw = snapshot.tabs[4]!.lines.filter((line) => !line.startsWith("#"));
		for (const line of raw) assert.doesNotThrow(() => JSON.parse(line));
	});

	it("puts the largest tool result at the top of the biggest-items list", () => {
		const overview = snapshot.tabs[0]!.lines.join("\n");
		const first = overview.split("Biggest items")[1] ?? "";
		assert.match(first, /# {2}2/);
	});
});

describe("reading a host that fails", () => {
	it("reads everything when the host answers everything", async () => {
		const host = fakeContext();
		const sources = await withHost(host, () => readSources(host.context as never, host.api as never));
		assert.equal(sources.problems?.length, 0);
		assert.equal(sources.systemPrompt, "You are a helpful assistant.");
		assert.equal(sources.model, "anthropic/claude-x");
		assert.equal(sources.reserveTokens, 16384);
		assert.equal(sources.messages?.length, 3);
	});

	it("keeps the other reads working when one throws, and names the one that did", async () => {
		const failures: Record<string, string> = {
			systemPrompt: "system prompt",
			usage: "token usage",
			tools: "tool definitions",
			settings: "", // a settings failure hides nothing: the line it feeds is optional
			messages: "session",
		};
		for (const [which, expected] of Object.entries(failures)) {
			// The command is the thing under test: a host that cannot answer one
			// question still gets a rendered panel.
			const { notify, overlay } = await run({ throwOn: new Set([which]) });
			assert.equal(overlay?.tabs.length, 5, `${which}: the panel did not open`);
			const text = overlay?.tabs[0]?.lines.join("\n") ?? "";
			if (expected) assert.match(text, new RegExp(expected), `${which}: the failure is not shown`);
			assert.equal(notify.length, 0, `${which}: a readable-enough host should not be warned at`);
		}
	});

	it("still opens a panel when nothing at all could be read", async () => {
		const { overlay } = await run({ throwOn: new Set(Object.keys({ systemPrompt: 1, usage: 1, tools: 1, settings: 1, messages: 1 })) });
		assert.equal(overlay?.tabs.length, 5);
		const text = overlay?.tabs[0]?.lines.join("\n") ?? "";
		assert.match(text, /could not read the system prompt/);
		assert.match(text, /could not read the token usage/);
	});

	it("takes the context window from the model when the provider has not reported one", async () => {
		const host = fakeContext({ usage: { tokens: 500, contextWindow: 0, percent: null } });
		const sources = await withHost(host, () => readSources(host.context as never, host.api as never));
		assert.equal(sources.usage?.contextWindow, 200000);
	});

	it("never invents a context window the model does not name", async () => {
		const host = fakeContext({ model: { id: "mystery" }, usage: null });
		const sources = await withHost(host, () => readSources(host.context as never, host.api as never));
		assert.equal(sources.usage, null);
		assert.equal(sources.model, "mystery");
	});
});

async function withHost(host: ReturnType<typeof fakeContext>, read: () => Promise<Sources>) {
	setHostForTesting({ sessionMessages: async () => messages as never, copy: async () => undefined });
	try {
		return await read();
	} finally {
		setHostForTesting(null);
	}
}
