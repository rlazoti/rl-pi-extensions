import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import factory from "./index.ts";

/**
 * The extension is driven through Pi's real surface — registerTool /
 * registerCommand / hooks — with a fake `pi` and a fake context, against a
 * scratch memory bank. Nothing here reads or writes the live ~/.pi/memory.
 */

interface FakeTool {
	name: string;
	description: string;
	promptGuidelines?: string[];
	parameters: unknown;
	execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionToolContext) => Promise<AgentToolResult<unknown>>;
}

interface Harness {
	tools: Map<string, FakeTool>;
	commands: Map<string, { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>;
	hooks: Map<string, (event: unknown, ctx: ExtensionToolContext) => unknown>;
	notifications: Array<{ message: string; level?: string }>;
}

function fakePi(): { pi: ExtensionAPI; harness: Harness } {
	const harness: Harness = { tools: new Map(), commands: new Map(), hooks: new Map(), notifications: [] };
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionToolContext) => unknown) => {
			harness.hooks.set(event, handler);
			return () => {};
		},
		registerTool: (tool: FakeTool) => {
			harness.tools.set(tool.name, tool);
		},
		registerCommand: (name: string, options: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
			harness.commands.set(name, options);
		},
	} as unknown as ExtensionAPI;
	return { pi, harness };
}

interface FakeContext {
	ctx: ExtensionToolContext;
	asked: string[];
	/** Every dialog's options object, in order: what the extension asked with. */
	dialogs: unknown[];
	answers: Map<string, string | undefined>;
}

function fakeContext(options: { hasUI?: boolean; cwd?: string; answers?: Record<string, string | undefined> } = {}): FakeContext {
	const asked: string[] = [];
	const dialogs: unknown[] = [];
	const answers = new Map(Object.entries(options.answers ?? {}));
	const ctx = {
		hasUI: options.hasUI ?? false,
		mode: options.hasUI ? "tui" : "print",
		cwd: options.cwd ?? "/repo/rl-pi-extensions",
		signal: undefined,
		ui: {
			select: async (title: string, choices: string[], opts?: unknown) => {
				asked.push(`select:${title}`);
				dialogs.push(opts);
				return answers.get(title) ?? answers.get(title.split(" — ")[0]!) ?? undefined;
			},
			input: async (title: string, placeholder?: string, opts?: unknown) => {
				asked.push(`input:${title}`);
				dialogs.push(opts);
				return answers.get(title) ?? answers.get(title.split(" — ")[0]!) ?? "";
			},
			confirm: async () => true,
			notify: () => {},
		},
	} as unknown as ExtensionToolContext;
	return { ctx, asked, dialogs, answers };
}

// ─── Scratch bank, every time ───────────────────────────────────────────────

interface Bank {
	root: string;
	agentDir: string;
	knowledge: string;
	cleanup: () => void;
	seed: (files: Record<string, string>) => void;
	seedAt: (relative: string, content: string) => void;
	read: (name: string) => string;
	readAt: (relative: string) => string;
	existsAt: (relative: string) => boolean;
	exists: (name: string) => boolean;
	listAt: (relativeDir: string) => string[];
	queue: () => string[];
}

async function withBank<T>(run: (bank: Bank) => T | Promise<T>, options: { collision?: boolean } = {}): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "memory-ext-"));
	const agentDir = join(root, "agent");
	const knowledge = join(root, "knowledge");
	mkdirSync(knowledge, { recursive: true });
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	if (options.collision) mkdirSync(join(agentDir, "extensions", "memory"));

	// The extension resolves these at load time, so pointing them here is what
	// keeps every test off the live ~/.pi/memory.
	const previous = { memory: process.env.PI_MEMORY_DIR, agent: process.env.PI_CODING_AGENT_DIR };
	process.env.PI_MEMORY_DIR = root;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const bank: Bank = {
		root,
		agentDir,
		knowledge,
		cleanup: () => {
			for (const [key, value] of [["PI_MEMORY_DIR", previous.memory], ["PI_CODING_AGENT_DIR", previous.agent]] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		},
		seed: (files) => {
			for (const [name, content] of Object.entries(files)) writeFileSync(join(knowledge, name), content, "utf8");
		},
		seedAt: (relative, content) => {
			const target = join(root, relative);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content, "utf8");
		},
		readAt: (relative) => readFileSync(join(root, relative), "utf8"),
		existsAt: (relative) => existsSync(join(root, relative)),
		listAt: (relativeDir) => {
			try {
				return readdirSync(join(root, relativeDir));
			} catch {
				return [];
			}
		},
		read: (name) => readFileSync(join(knowledge, name), "utf8"),
		exists: (name) => {
			try {
				readFileSync(join(knowledge, name));
				return true;
			} catch {
				return false;
			}
		},
		queue: () => {
			try {
				return readdirSync(join(root, ".pending"));
			} catch {
				return [];
			}
		},
	};

	// Cleaned up even when the test fails: a failing test must not leave a
	// bank-shaped directory behind for a later run to pick up.
	try {
		return await run(bank);
	} finally {
		bank.cleanup();
	}
}


const UI = `# ui

## ui.background
- kind: preference
- scope: global
- asOf: 2026-10-02
- source: design review
- status: active
Use dark grey for the UI background.

## git.push
- kind: rule
- scope: global
- asOf: 2026-10-12
- status: active
Never push without explicit confirmation.
`;

const WRITE_ARGS = {
	file: "knowledge/appearance.md",
	key: "ui.background",
	scope: "global",
	kind: "preference",
	body: "Charcoal.",
	asOf: "2026-11-01",
	revision: "2026-11-01",
};

// ─── Registration and the guard ─────────────────────────────────────────────

test("the extension registers its tools, its command and the injection hook", async () =>
	withBank(() => {
		const { pi, harness } = fakePi();
		factory(pi);
		assert.deepEqual([...harness.tools.keys()].sort(), ["memory_doctor", "memory_search", "memory_show", "memory_write"]);
		assert.deepEqual([...harness.commands.keys()], ["memory"]);
		assert.deepEqual([...harness.hooks.keys()], ["session_start", "before_agent_start"], "session_start owns the daily rollover");
	}));

test("it stands down when another memory extension is loaded, and says why", async () =>
	withBank((bank) => {
		assert.ok(bank.knowledge);
		const { pi, harness } = fakePi();
		factory(pi);
		assert.deepEqual([...harness.tools.keys()], [], "no tools: two injectors and two memory_* sets would make the prompt unreproducible");
		assert.deepEqual([...harness.commands.keys()], []);
		assert.deepEqual([...harness.hooks.keys()], ["session_start"]);

		const notices: Array<{ message: string; level?: string }> = [];
		const ctx = { hasUI: true, ui: { notify: (message: string, level?: string) => notices.push({ message, level }) } } as unknown as ExtensionToolContext;
		harness.hooks.get("session_start")!({ type: "session_start" }, ctx);
		assert.equal(notices.length, 1);
		assert.equal(notices[0]!.level, "warning");
		assert.match(notices[0]!.message, /standing down — another memory extension is loaded at .*extensions\/memory/);
	}, { collision: true }));

// ─── daily rollover ─────────────────────────────────────────────────────────

const TODAY_ISO = new Date().toISOString().slice(0, 10);
const STALE_DAILY = `- date: 2026-10-03

## In Progress
- verify the simulator build

## Completed
- wrote the spec
`;

function notifyingContext(): { ctx: ExtensionToolContext; notices: Array<{ message: string; level?: string }> } {
	const notices: Array<{ message: string; level?: string }> = [];
	const ctx = { hasUI: true, mode: "tui", cwd: "/repo/rl-pi-extensions", ui: { notify: (message: string, level?: string) => notices.push({ message, level }) } } as unknown as ExtensionToolContext;
	return { ctx, notices };
}

test("session_start archives a stale daily file and carries open work into today", async () =>
	withBank((bank) => {
		bank.seedAt("core/dailyContext.md", STALE_DAILY);
		const { pi, harness } = fakePi();
		factory(pi);

		const { ctx, notices } = notifyingContext();
		harness.hooks.get("session_start")!({ type: "session_start" }, ctx);

		assert.ok(bank.existsAt("history/daily/2026-10/2026-10-03-dailyContext.md"), "yesterday's file is kept as a record");
		assert.equal(bank.readAt("history/daily/2026-10/2026-10-03-dailyContext.md"), STALE_DAILY, "archived verbatim");
		const fresh = bank.readAt("core/dailyContext.md");
		assert.match(fresh, /^- date: /m);
		assert.match(fresh, new RegExp(`# Daily Context — ${TODAY_ISO}`));
		assert.match(fresh, /verify the simulator build/);
		assert.equal(fresh.includes("wrote the spec"), false, "settled work is archived, not carried");
		assert.match(notices[0]!.message, /Rolled over daily context from 2026-10-03/);
		assert.match(notices.map((notice) => notice.message).join(" "), /archived without being carried/);
	}));

test("an undated daily file is reported rather than assumed current forever", async () =>
	withBank((bank) => {
		bank.seedAt("core/dailyContext.md", "# Daily Context - Some Project\n\n## Completed\n- old work\n");
		const { pi, harness } = fakePi();
		factory(pi);
		const { ctx, notices } = notifyingContext();
		harness.hooks.get("session_start")!({ type: "session_start" }, ctx);

		// A file with no date field that was *just* touched is almost certainly
		// today's, so it is not archived — it is reported, with the fix spelled out.
		assert.deepEqual(bank.listAt("history/daily"), []);
		assert.equal(notices.length, 1);
		assert.equal(notices[0]!.level, "warning");
		assert.match(notices[0]!.message, /has no `- date:` field/);
		assert.match(notices[0]!.message, /assumed .* from its modification time/);
	}));

test("an undated open item is dated so it can age, without touching the archive path", async () =>
	withBank((bank) => {
		bank.seedAt("core/dailyContext.md", `- date: ${TODAY_ISO}\n\n## Next Steps\n- verify the simulator build\n`);
		const { pi, harness } = fakePi();
		factory(pi);

		const { ctx, notices } = notifyingContext();
		harness.hooks.get("session_start")!({ type: "session_start" }, ctx);

		assert.match(bank.readAt("core/dailyContext.md"), /- \(2026-10-14\)|- \(\d{4}-\d{2}-\d{2}\) verify the simulator build/);
		assert.match(notices.map((notice) => notice.message).join(" "), /dated 1 open item/);
	}));

test("a stale daily file is surfaced in the prompt even when the store has nothing to say", async () =>
	withBank(async (bank) => {
		bank.seedAt("core/dailyContext.md", STALE_DAILY);
		const { pi, harness } = fakePi();
		factory(pi);

		const result = (await harness.hooks.get("before_agent_start")!({ type: "before_agent_start", prompt: "what should I work on?" }, fakeContext().ctx as never)) as { message: { content: string } };
		assert.match(result.message.content, /Daily context freshness/);
		assert.match(result.message.content, /2026-10-03/);
	}));

test("/memory daily reports the daily file and rolls it over on demand", async () =>
	withBank(async (bank) => {
		bank.seedAt("core/dailyContext.md", STALE_DAILY);
		const { pi, harness } = fakePi();
		factory(pi);

		const { ctx, notices } = notifyingContext();
		await harness.commands.get("memory")!.handler("daily", ctx as never);
		const messages = notices.map((notice) => notice.message).join(" ");
		assert.match(messages, new RegExp(`Daily context: ${TODAY_ISO}`), "after the rollover the file is current");
		assert.match(messages, /Rolled over daily context from 2026-10-03/);
		assert.ok(bank.existsAt("history/daily/2026-10/2026-10-03-dailyContext.md"));
	}));

// ─── memory_write ───────────────────────────────────────────────────────────

test("memory_write writes an uncontested entry to disk", async () =>
	withBank(async (bank) => {
		bank.seed({ "ui.md": UI });
		const { pi, harness } = fakePi();
		factory(pi);
		const tool = harness.tools.get("memory_write")!;
		const { ctx } = fakeContext();

		const result = await tool.execute("t1", { ...WRITE_ARGS, key: "ui.foreground", body: "Off-white." }, undefined, undefined, ctx);
		assert.equal(result.isError, false);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /Created knowledge\/appearance\.md with ui\.foreground@2026-11-01\. Written: knowledge\/appearance\.md\./);
		assert.match(bank.read("appearance.md"), /- asOf: 2026-11-01/);
	}));

test("memory_write refuses a rival, writes nothing, and hands back a conflictId to answer", async () =>
	withBank(async (bank) => {
		bank.seed({ "ui.md": UI });
		const { pi, harness } = fakePi();
		factory(pi);
		const tool = harness.tools.get("memory_write")!;
		const { ctx } = fakeContext();

		const refused = await tool.execute("t1", WRITE_ARGS, undefined, undefined, ctx);
		const text = (refused.content[0] as { text: string }).text;
		assert.equal((refused.details as { kind: string }).kind, "refused");
		assert.match(text, /^CONFLICT ui\.background in scope global — nothing was written\./);
		assert.match(text, /resolve: supersede \| merge \| withdraw \| keep-both-flagged \| discard and conflictId: [0-9a-f]{8}/);
		assert.equal(bank.exists("appearance.md"), false);
		assert.equal(bank.queue().length, 1, "the refusal is parked, not dropped");
	}));

test("the same write asked of a session with a UI goes to the human, in the call", async () =>
	withBank(async (bank) => {
		bank.seed({ "ui.md": UI });
		const { pi, harness } = fakePi();
		factory(pi);
		const tool = harness.tools.get("memory_write")!;

		// Headless first: parked, and the caller is told how to answer.
		const headless = await tool.execute("t1", WRITE_ARGS, undefined, undefined, fakeContext().ctx);
		const conflictId = (headless.details as { conflictId: string }).conflictId;
		assert.equal((headless.details as { kind: string }).kind, "refused");

		// Same write, same store, UI available: the human decides instead.
		const chosen = "discard — drop the new claim, the existing one stands";
		const human = fakeContext({ hasUI: true, answers: { "Memory conflict": chosen, "Why (discard)?": "user prefers the reviewed grey" } });
		const accepted = await tool.execute("t2", WRITE_ARGS, undefined, undefined, human.ctx);

		assert.match((accepted.content[0] as { text: string }).text, /Incoming claim not written; ui\.background \(knowledge\/ui\.md\) remains the authority\./);
		assert.deepEqual(bank.queue(), [], "answering through the dialog clears the record the headless attempt parked");
		assert.equal(bank.exists("appearance.md"), false);
		assert.ok(human.asked.some((entry) => entry.startsWith("select:Memory conflict")));
		assert.ok(human.asked.some((entry) => entry.startsWith("input:Why (discard)?")));
		assert.equal(conflictId.length, 8);
	}));

test("the conflict dialog shows both claims and the rule that refused the write", async () =>
	withBank(async (bank) => {
		bank.seed({ "ui.md": UI });
		const { pi, harness } = fakePi();
		factory(pi);
		const tool = harness.tools.get("memory_write")!;
		const human = fakeContext({ hasUI: true, answers: { "Memory conflict": undefined } });

		await tool.execute("t1", WRITE_ARGS, undefined, undefined, human.ctx);
		const title = human.asked.find((entry) => entry.startsWith("select:"))!.slice("select:".length);

		// Options alone are not something a person can choose between.
		assert.match(title, /Use dark grey for the UI background\./, "the claim in the bank");
		assert.match(title, /Charcoal\./, "the claim being written");
		assert.match(title, /In the bank now:/);
		assert.match(title, /Being written:/);
		assert.match(title, /Why this is refused:/);
		assert.match(title, /competes with/, "the reason, not just a refusal");
		assert.match(title, /\/memory resolve [0-9a-f]{8}/, "how to answer later");
		assert.match(title, /Nothing is written until you choose/);
	}));

test("no conflict dialog is on a timer", async () =>
	withBank(async (bank) => {
		bank.seed({ "ui.md": UI });
		const { pi, harness } = fakePi();
		factory(pi);
		const tool = harness.tools.get("memory_write")!;
		const human = fakeContext({ hasUI: true, answers: { "Memory conflict": "merge — one claim replaces both, you supply the merged text", "Merge ui.background": "Charcoal, with dark grey kept as history." } });

		const outcome = await tool.execute("t1", WRITE_ARGS, undefined, undefined, human.ctx);
		assert.equal((outcome.details as { kind: string }).kind, "written", "the merge path completes: select, then the merged claim, then the reason");
		assert.ok(human.asked.some((entry) => entry.startsWith("input:Merge ui.background")), "the merge question previews both sides");
		assert.equal(human.dialogs.length, 3, "select + merged claim + why");
		for (const dialog of human.dialogs) {
			assert.equal((dialog as { timeout?: number })?.timeout, undefined, "a timer outranks the human: the dialog waits until they answer or cancel");
		}
		assert.match(bank.read("appearance.md"), /Charcoal, with dark grey kept as history\./);
	}));

test("two conflicting writes in one turn ask once and park the other", async () =>
	withBank(async (bank) => {
		bank.seed({ "ui.md": UI });
		const { pi, harness } = fakePi();
		factory(pi);
		const tool = harness.tools.get("memory_write")!;
		const human = fakeContext({ hasUI: true, answers: { "Memory conflict": undefined } });
		const rivalPush = { file: "knowledge/appearance.md", key: "git.push", scope: "global", kind: "rule", body: "Push freely after review.", asOf: "2026-11-02", revision: "2026-11-02" };

		// Pi gives extensions one dialog slot. A second ui.select replaces the first,
		// and the write that asked the first question is then waiting on a dialog
		// nobody can see — a session stuck with no visible reason.
		const [first, second] = await Promise.all([tool.execute("t1", WRITE_ARGS, undefined, undefined, human.ctx), tool.execute("t2", rivalPush, undefined, undefined, human.ctx)]);

		assert.equal(human.asked.filter((entry) => entry.startsWith("select:")).length, 1, "one question at a time");
		assert.equal((first.details as { kind: string }).kind, "refused");
		assert.equal((second.details as { kind: string }).kind, "refused");
		assert.match((second.content[0] as { text: string }).text, /another conflict is already on screen/);
		assert.equal(bank.queue().length, 2, "both contests are parked: neither is lost while one is on screen");
		assert.equal(bank.exists("appearance.md"), false);
	}));

test("a write whose tool call is already cancelled never opens a dialog", async () =>
	withBank(async (bank) => {
		bank.seed({ "ui.md": UI });
		const { pi, harness } = fakePi();
		factory(pi);
		const tool = harness.tools.get("memory_write")!;
		const human = fakeContext({ hasUI: true, answers: { "Memory conflict": "discard — drop the new claim, the existing one stands" } });
		const cancelled = new AbortController();
		cancelled.abort();

		const outcome = await tool.execute("t1", WRITE_ARGS, cancelled.signal, undefined, human.ctx);
		assert.deepEqual(human.asked, [], "nobody is waiting for an answer; opening a dialog here strands it");
		assert.equal((outcome.details as { kind: string }).kind, "refused");
		assert.equal(bank.queue().length, 1, "the contest is still parked, and the next turn says so");
	}));

test("a write that already carries a resolution is applied without another dialog", async () =>
	withBank(async (bank) => {
		bank.seed({ "ui.md": UI });
		const { pi, harness } = fakePi();
		factory(pi);
		const tool = harness.tools.get("memory_write")!;

		const refused = await tool.execute("t1", WRITE_ARGS, undefined, undefined, fakeContext().ctx);
		const conflictId = (refused.details as { conflictId: string }).conflictId;

		const human = fakeContext({ hasUI: true, answers: { "Memory conflict": "supersede — the new claim wins, the old one becomes history" } });
		const accepted = await tool.execute("t2", { ...WRITE_ARGS, resolve: "supersede", conflictId }, undefined, undefined, human.ctx);

		assert.equal((accepted.details as { kind: string }).kind, "written");
		assert.deepEqual(human.asked, [], "the decision was already made; asking twice invites a different answer");
		assert.deepEqual(bank.queue(), []);
		assert.match(bank.read("appearance.md"), /- supersedes: knowledge\/ui\.md#ui\.background/);
	}));

test("a dismissed dialog parks the refusal instead of writing", async () =>
	withBank(async (bank) => {
		bank.seed({ "ui.md": UI });
		const { pi, harness } = fakePi();
		factory(pi);
		const tool = harness.tools.get("memory_write")!;
		const human = fakeContext({ hasUI: true, answers: { "Memory conflict": undefined } });

		const outcome = await tool.execute("t1", WRITE_ARGS, undefined, undefined, human.ctx);
		assert.match((outcome.content[0] as { text: string }).text, /^CONFLICT/);
		assert.equal(bank.queue().length, 1);
		assert.equal(bank.exists("appearance.md"), false);
	}));

test("memory_write refuses a malformed entry with the parser's own reasons", () =>
	withBank(async (bank) => {
		bank.seed({ "ui.md": UI });
		const { pi, harness } = fakePi();
		factory(pi);
		const tool = harness.tools.get("memory_write")!;
		const { ctx } = fakeContext();

		const bad = await tool.execute("t1", { ...WRITE_ARGS, scope: "host:work" }, undefined, undefined, ctx);
		assert.equal(bad.isError, true);
		assert.match((bad.content[0] as { text: string }).text, /error \[bad-scope\]/);
		assert.equal(bank.exists("appearance.md"), false);

		const noDate = await tool.execute("t2", { ...WRITE_ARGS, asOf: "last tuesday" }, undefined, undefined, ctx);
		assert.match((noDate.content[0] as { text: string }).text, /bad-asOf/);
	}));

test("the tool teaches the protocol rather than hoping the model guesses it", async () =>
	withBank(() => {
		const { pi, harness } = fakePi();
		factory(pi);
		const tool = harness.tools.get("memory_write")!;
		assert.ok(tool.promptGuidelines?.some((line) => /never default it to today/i.test(line)));
		assert.ok(tool.promptGuidelines?.some((line) => /do not pick a winner yourself/i.test(line)));
		assert.match(tool.description, /refused — nothing is written/);
	}));

// ─── Reading ────────────────────────────────────────────────────────────────

test("memory_show names the authority, the retired claims and the shadowing", async () =>
	withBank(async (bank) => {
		bank.seed({
			"ui.md": `# ui\n\n## ui.background\n- kind: preference\n- scope: global\n- asOf: 2026-01-01\n- status: active\nDark grey.\n\n## ui.background@2025-06-14\n- kind: preference\n- scope: global\n- asOf: 2025-06-14\n- status: superseded\n- supersededBy: knowledge/ui.md#ui.background\nNavy.\n`,
			"finance.md": `# finance\n\n## ui.background\n- kind: preference\n- scope: project:money-manager\n- asOf: 2026-02-01\n- status: active\nNavy for legibility.\n`,
		});
		const { pi, harness } = fakePi();
		factory(pi);
		const tool = harness.tools.get("memory_show")!;

		const here = await tool.execute("t1", { key: "ui.background" }, undefined, undefined, fakeContext({ cwd: "/repos/money-manager" }).ctx);
		const hereText = (here.content[0] as { text: string }).text;
		assert.match(hereText, /Authority for "ui\.background": knowledge\/finance\.md#ui\.background/);
		assert.match(hereText, /ui\.background@2025-06-14 \[superseded\]/);
		assert.match(hereText, /Shadowed for this context:\n- knowledge\/ui\.md#ui\.background: shadowed-by-scope \(by knowledge\/finance\.md#ui\.background\)/, "a global default and a project override must not both reach the model, and the reason is recorded");
	}));

test("memory_show reports a contested key as an error, not as an answer", async () =>
	withBank(async (bank) => {
		bank.seed({
			"ui.md": `# ui\n\n## ui.background\n- kind: preference\n- scope: global\n- asOf: 2026-10-02\n- status: active\nDark grey.\n`,
			"settings.md": `# settings\n\n## ui.background\n- kind: preference\n- scope: global\n- asOf: 2026-09-01\n- status: active\nNavy.\n`,
		});
		const { pi, harness } = fakePi();
		factory(pi);
		const outcome = await harness.tools.get("memory_show")!.execute("t1", { key: "ui.background" }, undefined, undefined, fakeContext().ctx);
		assert.equal(outcome.isError, true);
		assert.match((outcome.content[0] as { text: string }).text, /CONTESTED: "ui\.background" has no authority/);
	}));

test("memory_search is explicit that a candidate is not an answer", async () =>
	withBank(async (bank) => {
		bank.seed({ "ui.md": UI });
		const { pi, harness } = fakePi();
		factory(pi);
		const outcome = await harness.tools.get("memory_search")!.execute("t1", { query: "push confirmation" }, undefined, undefined, fakeContext().ctx);
		const text = (outcome.content[0] as { text: string }).text;
		assert.match(text, /Candidates are not answers/);
		assert.match(text, /knowledge\/ui\.md#git\.push \[active\] rule · global · 2026-10-12 — matched: push, confirmation/);
	}));

test("memory_doctor reports the problems, and only reports clean when it is clean", async () =>
	withBank(async (bank) => {
		bank.seed({ "ui.md": UI, "notes.md": "# notes\n\n## A prose heading\n- kind: fact\n- scope: global\n- asOf: 2026-01-01\nLegacy.\n" });
		const { pi, harness } = fakePi();
		factory(pi);
		const doctor = harness.tools.get("memory_doctor")!;

		const dirty = await doctor.execute("t1", {}, undefined, undefined, fakeContext().ctx);
		assert.equal(dirty.isError, true);
		const text = (dirty.content[0] as { text: string }).text;
		assert.match(text, /Headings that are not assertion keys:\n- knowledge\/notes\.md#A prose heading/);
		assert.match(text, /Pending conflicts: none\./);

		rmSync(join(bank.knowledge, "notes.md"));
		const clean = await doctor.execute("t2", {}, undefined, undefined, fakeContext().ctx);
		assert.equal(clean.isError, false);
		assert.match((clean.content[0] as { text: string }).text, /No structural problems found\./);
	}));

// ─── The /memory command ────────────────────────────────────────────────────

test("/memory pending and /memory doctor reach the user as notifications", async () =>
	withBank(async (bank) => {
		bank.seed({ "ui.md": UI });
		const { pi, harness } = fakePi();
		factory(pi);
		const command = harness.commands.get("memory")!;

		const notices: Array<{ message: string; level?: string }> = [];
		const ctx = { hasUI: true, ui: { notify: (message: string, level?: string) => notices.push({ message, level }), select: async () => undefined, input: async () => "", confirm: async () => true } } as unknown as ExtensionCommandContext;

		await command.handler("pending", ctx);
		assert.match(notices[0]!.message, /Pending conflicts: none\./);

		await harness.tools.get("memory_write")!.execute("t1", WRITE_ARGS, undefined, undefined, fakeContext().ctx);
		await command.handler("pending", ctx);
		assert.match(notices[1]!.message, /Pending conflicts: 1/);
		assert.match(notices[1]!.message, /Suggested: supersede/);

		await command.handler("doctor", ctx);
		assert.equal(notices[2]!.level, "info", "a structurally clean store is informational");
		await command.handler("resolve", ctx);
		assert.match(notices[3]!.message, /memory resolve <conflictId>/);
		await command.handler("nonsense", ctx);
		assert.match(notices[4]!.message, /Unknown subcommand "nonsense"/);
	}));

test("/memory resolve <id> asks the human and applies their answer", async () =>
	withBank(async (bank) => {
		bank.seed({ "ui.md": UI });
		const { pi, harness } = fakePi();
		factory(pi);

		const refused = await harness.tools.get("memory_write")!.execute("t1", WRITE_ARGS, undefined, undefined, fakeContext().ctx);
		const id = (refused.details as { conflictId: string }).conflictId;

		const notices: string[] = [];
		const human = fakeContext({ hasUI: true, answers: { [`Resolve ${id}`]: "withdraw — stop asserting either; nothing new is claimed", "Why (withdraw)?": "nobody owns this claim any more" } });
		const ctx = { ...human.ctx, ui: { ...human.ctx.ui, notify: (message: string) => notices.push(message) } } as unknown as ExtensionCommandContext;

		await harness.commands.get("memory")!.handler(`resolve ${id}`, ctx);
		assert.match(notices[0]!, /Withdrew ui\.background \(knowledge\/ui\.md\)\. Nothing new was claimed\. Written: knowledge\/ui\.md\./);
		assert.match(bank.read("ui.md"), /- status: withdrawn\n- withdrawnOn: 2026-11-01/);
		assert.deepEqual(bank.queue(), []);
	}));

test("/memory resolve without a UI needs an explicit --resolve, and guesses nothing", async () =>
	withBank(async (bank) => {
		bank.seed({ "ui.md": UI });
		const { pi, harness } = fakePi();
		factory(pi);
		const refused = await harness.tools.get("memory_write")!.execute("t1", WRITE_ARGS, undefined, undefined, fakeContext().ctx);
		const id = (refused.details as { conflictId: string }).conflictId;

		const notices: string[] = [];
		const ctx = { hasUI: false, cwd: "/repo/x", ui: { notify: (message: string) => notices.push(message), select: async () => undefined, input: async () => "", confirm: async () => true } } as unknown as ExtensionCommandContext;

		await harness.commands.get("memory")!.handler(`resolve ${id}`, ctx);
		assert.match(notices[0]!, /[Pp]ass --resolve=<supersede\|merge\|withdraw\|keep-both-flagged\|discard> \(suggested: supersede\)/);
		assert.equal(bank.queue().length, 1, "still pending: a suggestion is not an answer");

		await harness.commands.get("memory")!.handler(`resolve ${id} --resolve=discard`, ctx);
		assert.match(notices[1]!, /remains the authority/);
		assert.deepEqual(bank.queue(), []);
	}));

// ─── Per-turn injection ─────────────────────────────────────────────────────

test("the hook injects authorities, never candidates, and stays silent when there is nothing to say", async () =>
	withBank(async (bank) => {
		bank.seed({ "ui.md": UI });
		const { pi, harness } = fakePi();
		factory(pi);
		const hook = harness.hooks.get("before_agent_start")!;

		const quiet = await hook({ type: "before_agent_start", messageType: "user", prompt: "what is the weather" }, fakeContext().ctx as never);
		assert.equal(quiet, undefined, "no injection, no header, no tokens spent");

		const result = (await hook({ type: "before_agent_start", messageType: "user", prompt: "may I push to github" }, fakeContext().ctx as never)) as { message: { content: string; display: boolean; customType: string } };
		assert.equal(result.message.customType, "memory");
		assert.equal(result.message.display, false);
		assert.match(result.message.content, /\[rule · global · 2026-10-12\] git\.push: Never push without explicit confirmation\./);
	}));

test("the hook surfaces unanswered conflicts on every turn until they are answered", async () =>
	withBank(async (bank) => {
		bank.seed({ "ui.md": UI });
		const { pi, harness } = fakePi();
		factory(pi);
		await harness.tools.get("memory_write")!.execute("t1", WRITE_ARGS, undefined, undefined, fakeContext().ctx);

		const result = (await harness.hooks.get("before_agent_start")!({ type: "before_agent_start", messageType: "user", prompt: "unrelated question about the weather" }, fakeContext().ctx as never)) as { message: { content: string } };
		assert.match(result.message.content, /## Memory conflicts awaiting a decision/);
		assert.match(result.message.content, /\/memory resolve [0-9a-f]{8}/);
	}));
