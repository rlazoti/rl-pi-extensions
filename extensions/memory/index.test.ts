import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import factory from "./index.ts";
import { MEMORY_SUBCOMMANDS, paletteDescription, setBankForTesting } from "./implementation.ts";
import { createBank } from "./bank.ts";
import { bankPaths, ensureBankDirs } from "./store.ts";
import { upsertClaim } from "./store.ts";
import { propose } from "./queue.ts";
import type { Claim } from "./grammar.ts";

/**
 * The component is driven through Pi's real surface — registerTool,
 * registerCommand, both hooks — against a scratch bank with an injected clock and
 * git probe. Nothing here reads or writes the live ~/.pi/memory.
 */

interface FakeTool {
	name: string;
	description: string;
	promptGuidelines?: string[];
	parameters: unknown;
	execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionToolContext) => Promise<{ content: { text: string }[]; details: unknown; isError?: boolean }>;
}

interface Harness {
	tools: Map<string, FakeTool>;
	commands: Map<string, {
		description: string;
		handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		getArgumentCompletions?: (prefix: string) => { value: string; label: string; description?: string }[] | null;
	}>;
	hooks: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	notifications: { message: string; level?: string }[];
}

function fakePi(): { pi: ExtensionAPI; harness: Harness } {
	const harness: Harness = { tools: new Map(), commands: new Map(), hooks: new Map(), notifications: [] };
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			harness.hooks.set(event, handler);
			return () => {};
		},
		registerTool: (tool: FakeTool) => harness.tools.set(tool.name, tool),
		registerCommand: (name: string, options: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>; getArgumentCompletions?: (prefix: string) => { value: string; label: string; description?: string }[] | null }) => harness.commands.set(name, options),
	} as unknown as ExtensionAPI;
	return { pi, harness };
}

interface FakeContext {
	ctx: ExtensionCommandContext;
	selects: { title: string; options: string[] }[];
}

function fakeContext(options: { mode?: "tui" | "print" | "rpc"; cwd?: string; select?: (title: string, choices: string[]) => Promise<string | undefined> } = {}): FakeContext {
	const selects: { title: string; options: string[] }[] = [];
	const notifications: { message: string; level?: string }[] = [];
	const ctx = {
		mode: options.mode ?? "print",
		hasUI: options.mode === "tui",
		cwd: options.cwd ?? "/repo/rl-pi-extensions",
		signal: undefined,
		notifications,
		sessionManager: { getSessionId: () => "session-abc", getSessionFile: () => "/tmp/session.jsonl" },
		ui: {
			notify: (message: string, level?: string) => notifications.push({ message, level }),
			select: async (title: string, choices: string[]) => {
				selects.push({ title, options: choices });
				return options.select ? options.select(title, choices) : undefined;
			},
			editor: async () => undefined,
			input: async () => undefined,
			confirm: async () => true,
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, selects };
}

const CLOCK = () => new Date(2026, 9, 16, 21, 30, 0);

function scratchBank(): { paths: ReturnType<typeof bankPaths>; cleanup: () => void } {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "memory-impl-")));
	const paths = bankPaths(dir);
	ensureBankDirs(paths);
	mkdirSync(join(paths.root, "knowledge"), { recursive: true });
	return { paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function claim(key: string, overrides: Partial<Claim> = {}): Claim {
	return {
		key,
		kind: "rule",
		scope: "global",
		asOf: "2026-01-01",
		source: "a test",
		body: `the rule about ${key}`,
		aliases: [],
		tags: [],
		links: [],
		origin: "agent",
		state: "approved",
		...overrides,
	};
}

function install(opts: { paths: ReturnType<typeof bankPaths>; mode?: "tui" | "print" | "rpc"; cwd?: string; select?: (title: string, choices: string[]) => Promise<string | undefined> } = { paths: undefined as never }): { harness: Harness; ctx: ExtensionCommandContext; selects: { title: string; options: string[] }[]; cleanup: () => void } {
	const { pi, harness } = fakePi();
	setBankForTesting(createBank({ paths: opts.paths, clock: CLOCK, git: async () => ({ root: "/repo/rl-pi-extensions", remote: "git@github.com:rlazoti/rl-pi-extensions.git" }) }));
	try {
		factory(pi);
	} finally {
		setBankForTesting(null);
	}
	const fake = fakeContext({ mode: opts.mode, cwd: opts.cwd, select: opts.select });
	return { harness, ctx: fake.ctx, selects: fake.selects, cleanup: () => {} };
}

/** Tools take a richer context than a command does; tests hand them this. */
function toolCtx(options: { mode?: "tui" | "print" | "rpc"; select?: (title: string, choices: string[]) => Promise<string | undefined> } = {}): ExtensionToolContext & { asks: { title: string; options: string[] }[] } {
	const fake = fakeContext(options);
	const ctx = fake.ctx as unknown as ExtensionToolContext & { asks: { title: string; options: string[] }[] };
	ctx.asks = fake.selects;
	return ctx;
}

function notificationsOf(ctx: ExtensionCommandContext): { message: string; level?: string }[] {
	// The fake context's notify closure pushes into an array the harness shares.
	return (ctx as unknown as { notifications: { message: string; level?: string }[] }).notifications ?? [];
}

test("component: a machine with no bank yet is silent, not broken", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "memory-nobank-")));
	const paths = bankPaths(join(dir, "absent"));
	try {
		const { harness, ctx } = install({ paths, mode: "tui" });
		await harness.hooks.get("session_start")!({ type: "session_start", reason: "new" }, ctx);
		assert.deepEqual(notificationsOf(ctx), [], "nothing waits, nothing is said");
		const injected = await harness.hooks.get("before_agent_start")!.call(undefined, { type: "before_agent_start", messageType: "user", prompt: "anything" }, ctx);
		assert.equal(injected, undefined, "no claims, no block");
		assert.deepEqual(readdirSync(paths.rules).concat(readdirSync(paths.facts)), [], "an empty bank gains no claims");
		assert.ok(existsSync(paths.daily), "the first user turn creates the bank skeleton");

		const notes: string[] = [];
		const cmdCtx = {
			...fakeContext({ mode: "print" }).ctx,
			ui: { notify: (message: string) => notes.push(message), select: async () => undefined, editor: async () => undefined, input: async () => undefined, confirm: async () => true },
			sessionManager: { getSessionId: () => "s" },
		} as unknown as ExtensionCommandContext;
		await harness.commands.get("memory")!.handler("status", cmdCtx);
		assert.match(notes[0]!, /claims: 0 approved, 0 pending/);
		await harness.commands.get("memory")!.handler("doctor", cmdCtx);
		assert.match(notes[1]!, /the bank is well formed/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("component: the tool names are exactly the spec's (R41)", () => {
	const { paths, cleanup } = scratchBank();
	try {
		const { harness } = install({ paths });
		assert.deepEqual(
			[...harness.tools.keys()].sort(),
			["memory_archive", "memory_list", "memory_log", "memory_propose", "memory_read", "memory_search"],
		);
		for (const retired of ["memory_write", "memory_append", "memory_update", "memory_show", "memory_doctor", "memory_pending", "memory_resolve"]) {
			assert.ok(!harness.tools.has(retired), `${retired} is not registered`);
		}
		assert.deepEqual([...harness.commands.keys()], ["memory"]);
	} finally {
		cleanup();
	}
});

test("component: rules are context only — no tool_call handler is registered (R34)", () => {
	const { paths, cleanup } = scratchBank();
	try {
		const { harness } = install({ paths });
		assert.deepEqual([...harness.hooks.keys()].sort(), ["before_agent_start", "session_start"]);
		assert.ok(!harness.hooks.has("tool_call"), "nothing blocks a tool call");
		assert.ok(!harness.hooks.has("tool_result"));
	} finally {
		cleanup();
	}
});

test("component: a new session opens with the review notice; a resume does not (R20)", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		propose(paths, claim("git.flow", { state: "pending", body: "Merge with --no-ff." }), "2026-10-15");
		propose(paths, claim("m.one", { state: "pending", origin: "migration", body: "migrated" }), "2026-10-14");
		const { harness, ctx } = install({ paths, mode: "tui" });
		const sessionStart = harness.hooks.get("session_start")!;
		await sessionStart({ type: "session_start", reason: "new" }, ctx);
		const notes = notificationsOf(ctx);
		assert.equal(notes.length, 1);
		assert.match(notes[0]!.message, /2 claims await review — 1 proposal from the agent; 1 migrated claim \(migration backlog\)/);

		const { harness: second, ctx: secondCtx } = install({ paths, mode: "tui" });
		await second.hooks.get("session_start")!({ type: "session_start", reason: "resume" }, secondCtx);
		assert.deepEqual(notificationsOf(secondCtx), []);
	} finally {
		cleanup();
	}
});

test("component: with nothing waiting, a new session says nothing at all", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		upsertClaim(paths, claim("git.flow"));
		const { harness, ctx } = install({ paths, mode: "tui" });
		await harness.hooks.get("session_start")!({ type: "session_start", reason: "new" }, ctx);
		assert.deepEqual(notificationsOf(ctx), []);
	} finally {
		cleanup();
	}
});

test("component: outside a TUI the notice goes to the log, once (R20)", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		propose(paths, claim("git.flow", { state: "pending" }), "2026-10-15");
		const { harness, ctx } = install({ paths, mode: "print" });
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (text: string) => warnings.push(String(text));
		try {
			await harness.hooks.get("session_start")!({ type: "session_start", reason: "new" }, ctx);
			await harness.hooks.get("session_start")!({ type: "session_start", reason: "fork" }, ctx);
		} finally {
			console.warn = original;
		}
		assert.equal(warnings.length, 1, "one log line, not one per session start");
		assert.match(warnings[0]!, /1 proposal from the agent/);
		assert.deepEqual(notificationsOf(ctx), []);
	} finally {
		cleanup();
	}
});

test("component: injection is a user-run thing (R25)", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		upsertClaim(paths, claim("git.flow", { tags: ["always"], body: "Never push to GitHub without confirmation." }));
		const { harness, ctx } = install({ paths, mode: "tui" });
		const before = harness.hooks.get("before_agent_start")!;

		const custom = await before({ type: "before_agent_start", messageType: "custom", message: { customType: "nudge", content: "x" } }, ctx);
		assert.equal(custom, undefined, "a run started by an extension message gets no injection");

		const user = (await before({ type: "before_agent_start", messageType: "user", prompt: "should I push?" }, ctx)) as { message: { customType: string; content: string; display: boolean } };
		assert.equal(user.message.customType, "memory");
		assert.equal(user.message.display, false);
		assert.match(user.message.content, /^## Memory — rules and facts for this context \(project: github\.com\/rlazoti\/rl-pi-extensions\)/);
		assert.match(user.message.content, /### Always-on rules\n- \[rule · global · 2026-01-01\] git\.flow: Never push to GitHub without confirmation\./);
	} finally {
		cleanup();
	}
});

test("component: every injected turn is measured, with no prompt text stored (R43)", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		upsertClaim(paths, claim("git.flow", { tags: ["always"] }));
		const { harness, ctx } = install({ paths });
		const before = harness.hooks.get("before_agent_start")!;
		await before({ type: "before_agent_start", messageType: "user", prompt: "the quick brown fox asks about git" }, ctx);
		const lines = readFileSync(join(paths.metrics, "turns.jsonl"), "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		const metric = JSON.parse(lines[0]!);
		assert.ok(metric.tokens.total > 0);
		assert.deepEqual(Object.keys(metric).sort(), ["at", "day", "dropped", "overrides", "session", "tokens"]);
		assert.ok(!readFileSync(join(paths.metrics, "turns.jsonl"), "utf8").includes("quick brown fox"));
	} finally {
		cleanup();
	}
});

test("component: damage inside the bank is reported, not swallowed, and a failed write fails the injection open (R30)", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		upsertClaim(paths, claim("git.flow", { tags: ["always"] }));
		// A directory where a store file belongs: the store reports it and still
		// injects what it can read.
		mkdirSync(join(paths.rules, "broken.md"));
		const { harness, ctx } = install({ paths, mode: "tui" });
		const before = harness.hooks.get("before_agent_start")!;
		const good = (await before({ type: "before_agent_start", messageType: "user", prompt: "git flow" }, ctx)) as { message: { content: string } };
		assert.match(good.message.content, /### Always-on rules/);

		// The metrics write failing must not take the turn down with it.
		chmodSync(paths.metrics, 0o000);
		try {
			const after = await before({ type: "before_agent_start", messageType: "user", prompt: "git flow" }, ctx);
			assert.equal(after, undefined, "the injection was skipped, not thrown");
			const searched = await harness.tools.get("memory_search")!.execute("t1", { query: "git.flow" }, undefined, undefined, toolCtx());
			assert.match(searched.content[0]!.text, /\[claim\] git\.flow @ global/, "the store is still readable");
			const again = await before({ type: "before_agent_start", messageType: "user", prompt: "git flow" }, ctx);
			assert.equal(again, undefined);
		} finally {
			chmodSync(paths.metrics, 0o755);
		}
		const warnings = notificationsOf(ctx).filter((note) => note.level === "warning");
		assert.equal(warnings.length, 1, "one warning, not one per turn");
		assert.match(warnings[0]!.message, /memory: injection skipped/);
	} finally {
		cleanup();
	}
});

test("component: memory_propose lands pending, and memory_log stamps the time (R15, R17)", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		const { harness, ctx } = install({ paths });
		const proposeTool = harness.tools.get("memory_propose")!;
		const refused = await proposeTool.execute("t1", { key: "git.flow", kind: "rule", scope: "global", asOf: "2026-10-16", source: "this session", body: "Merged 9fa1b7c on 2026-10-16 into main." }, undefined, undefined, toolCtx());
		assert.equal(refused.isError, true);
		assert.match(refused.content[0]!.text, /reads as project status/);
		assert.match(refused.content[0]!.text, /use memory_log/);

		const accepted = await proposeTool.execute("t2", { key: "git.flow", kind: "rule", scope: "global", asOf: "2026-10-16", source: "this session", body: "Never push without confirmation." }, undefined, undefined, toolCtx());
		assert.notEqual(accepted.isError, true);
		assert.match(accepted.content[0]!.text, /proposed git\.flow @ global \(pending, agent\)/);

		const logTool = harness.tools.get("memory_log")!;
		const logged = await logTool.execute("t3", { section: "in_progress", text: "Wire the injector." }, undefined, undefined, toolCtx());
		assert.match(logged.content[0]!.text, /logged in_progress at 2026-10-16 21:30/);
		const daily = readFileSync(join(paths.daily, "today.md"), "utf8");
		assert.equal(daily, "# Daily log — 2026-10-16\n\n## in_progress\n- (2026-10-16 21:30) Wire the injector.\n");
	} finally {
		cleanup();
	}
});

test("component: with the inline conflict dialog on, the ask happens at the tool call (R19)", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		writeFileSync(join(paths.root, "config.json"), JSON.stringify({ inlineConflictDialog: true }));
		upsertClaim(paths, claim("git.flow", { body: "Never push without confirmation." }));
		const proposeTool = () => {
			const { harness } = install({ paths, mode: "tui" });
			return harness.tools.get("memory_propose")!;
		};

		const replace = toolCtx({ mode: "tui", select: async () => "replace with: Never force-push." });
		const accepted = await proposeTool().execute("t1", { key: "git.flow", kind: "rule", scope: "global", asOf: "2026-10-16", source: "this session", body: "Never force-push." }, undefined, undefined, replace);
		assert.equal(replace.asks.length, 1);
		assert.match(replace.asks[0]!.title, /memory: git\.flow @ global — replace the approved claim\?/);
		assert.match(replace.asks[0]!.options[0]!, /keep: Never push without confirmation\./);
		assert.match(replace.asks[0]!.options[1]!, /replace with: Never force-push\./);
		assert.match(accepted.content[0]!.text, /decided now: approved git\.flow @ global — the previous version is in/);
		assert.equal(readFileSync(join(paths.rules, "git.md"), "utf8").includes("Never force-push."), true);
		assert.ok(existsSync(join(paths.history, "git.flow.md")), "the claim it replaced was kept");

		const keep = toolCtx({ mode: "tui", select: async () => "keep: Never force-push." });
		const kept = await proposeTool().execute("t2", { key: "git.flow", kind: "rule", scope: "global", asOf: "2026-10-16", source: "another session", body: "Squash merge instead." }, undefined, undefined, keep);
		assert.match(kept.content[0]!.text, /decided now: rejected git\.flow @ global/);
		assert.match(readFileSync(join(paths.rules, "git.md"), "utf8"), /Never force-push\./);

		const later = toolCtx({ mode: "tui", select: async () => undefined });
		const deferred = await proposeTool().execute("t3", { key: "git.flow", kind: "rule", scope: "global", asOf: "2026-10-16", source: "a third session", body: "Rebase then merge." }, undefined, undefined, later);
		assert.match(deferred.content[0]!.text, /left pending: it will show in \/memory review/);
	} finally {
		cleanup();
	}
});

test("component: the inline conflict dialog is off by default (R19, D3 defaults)", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		upsertClaim(paths, claim("git.flow", { body: "Never push without confirmation." }));
		const { harness } = install({ paths, mode: "tui" });
		const ctx = toolCtx({ mode: "tui", select: async () => "replace with: Never force-push." });
		const outcome = await harness.tools.get("memory_propose")!.execute("t1", { key: "git.flow", kind: "rule", scope: "global", asOf: "2026-10-16", source: "this session", body: "Never force-push." }, undefined, undefined, ctx);
		assert.equal(ctx.asks.length, 0, "no dialog: the default is the review queue");
		assert.match(outcome.content[0]!.text, /It waits against the approved claim/);
		assert.match(readFileSync(join(paths.rules, "git.md"), "utf8"), /Never push without confirmation\./);
	} finally {
		cleanup();
	}
});

test("component: /memory migrate draft names the next file, a named file, or a batch (R38)", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		writeFileSync(
			join(paths.root, "knowledge", "git-standards.md"),
			"# Git standards\n\n## git-standards.push\n- kind: rule\n- scope: global\n- asOf: 2026-01-01\n- source: repo wiki\n\nNever push without confirmation.\n",
		);
		const { harness } = install({ paths });
		const notes: string[] = [];
		const ctx = { ...fakeContext({ mode: "print" }).ctx, ui: { notify: (message: string) => notes.push(message) }, sessionManager: { getSessionId: () => "s" } } as unknown as ExtensionCommandContext;
		const command = harness.commands.get("memory")!;

		await command.handler("migrate plan", ctx);
		assert.match(notes[notes.length - 1]!, /planned 1 source files in waves: rules/);
		await command.handler("migrate draft", ctx);
		assert.match(notes[notes.length - 1]!, /no verified backup/);

		await command.handler("migrate backup", ctx);
		assert.match(notes[notes.length - 1]!, /backup written and listed back/);

		await command.handler("migrate draft", ctx);
		assert.match(notes[notes.length - 1]!, /Source: knowledge\/git-standards\.md \(wave rules, 1 claim to draft\)/);
		assert.match(notes[notes.length - 1]!, /## git-standards\.push/);
		await command.handler("migrate draft --batch 3", ctx);
		assert.match(notes[notes.length - 1]!, /batch of 1 file\(s\), in wave order:\n  knowledge\/git-standards\.md/);
		await command.handler("migrate draft --file git-standards", ctx);
		assert.match(notes[notes.length - 1]!, /Source: knowledge\/git-standards\.md/);
		await command.handler("migrate draft --file nope", ctx);
		assert.match(notes[notes.length - 1]!, /not a file waiting to be drafted/);
		await command.handler("migrate drafted knowledge/git-standards.md 1", ctx);
		assert.match(notes[notes.length - 1]!, /drafted knowledge\/git-standards\.md \(1 proposals\)/);
		await command.handler("migrate draft", ctx);
		assert.match(notes[notes.length - 1]!, /every source file has been drafted/);
	} finally {
		cleanup();
	}
});

test("component: a migrated proposal is told it never injects, and a sloppy origin is refused", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		const { harness, ctx } = install({ paths });
		const propose = harness.tools.get("memory_propose")!;
		const sloppy = await propose.execute("t1", { key: "ledger.format", kind: "fact", scope: "global", asOf: "2026-09-01", source: "migrated from knowledge/ledger.md", body: "Ledgers are plain text files under ~/Documents/ledger." }, undefined, undefined, toolCtx());
		assert.equal(sloppy.isError, true);
		assert.match(sloppy.content[0]!.text, /origin is "agent"/);

		const migrated = await propose.execute("t2", { key: "ledger.format", kind: "fact", scope: "global", asOf: "2026-09-01", source: "migrated from knowledge/ledger.md", origin: "migration", body: "Ledgers are plain text files under ~/Documents/ledger." }, undefined, undefined, toolCtx());
		assert.notEqual(migrated.isError, true);
		assert.match(migrated.content[0]!.text, /part of the migration backlog: it never injects until you approve it/);

		// And the injection really leaves it out.
		const { result } = await (await import("./bank.ts")).createBank({ paths, clock: CLOCK, git: async () => ({}) }).injection("ledger format", "/repo/rl-pi-extensions", "s");
		assert.equal(result.text, "", "a pending migration claim is not injected (R28)");
	} finally {
		cleanup();
	}
});

test("component: an edit made outside the extension is seen by the next turn", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		const bank = createBank({ paths, clock: CLOCK, git: async () => ({ root: "/repo/rl-pi-extensions", remote: "git@github.com:rlazoti/rl-pi-extensions.git" }) });
		upsertClaim(paths, claim("git.flow", { tags: ["always"], body: "Never push without confirmation." }));
		assert.match((await bank.injection("push", "/repo/rl-pi-extensions", "s")).result.text, /Never push without confirmation\./);

		// Rodrigo edits the store in his editor: the claim is what it says now.
		writeFileSync(join(paths.rules, "git.md"), readFileSync(join(paths.rules, "git.md"), "utf8").replace("Never push without confirmation.", "Never push to a shared remote without confirmation."));
		const after = (await bank.injection("push", "/repo/rl-pi-extensions", "s")).result;
		assert.match(after.text, /Never push to a shared remote without confirmation\./);
		assert.ok(!after.text.includes("Never push without confirmation."), "the old wording is gone");

		// And a claim approved in another session shows up here.
		const other = createBank({ paths, clock: CLOCK, git: async () => ({}) });
		other.proposeClaim({ key: "ledger.format", kind: "fact", scope: "global", asOf: "2026-09-01", source: "another session", body: "Ledgers are plain files." });
		const seen = (await bank.injection("ledger", "/repo/rl-pi-extensions", "s")).result;
		assert.match(seen.text, /\[fact · global · 2026-09-01\] \[unapproved\] ledger\.format: Ledgers are plain files/);
	} finally {
		cleanup();
	}
});

test("component: migrate everything, then decide the batch once — and it injects (R38, R18, R28)", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		writeFileSync(
			join(paths.root, "knowledge", "git-standards.md"),
			"# Git standards\n\n## git-standards.push\n- kind: rule\n- scope: global\n- asOf: 2026-01-01\n- source: repo wiki\n- tags: always\n\nNever push without confirmation.\n",
		);
		writeFileSync(
			join(paths.root, "knowledge", "macos.md"),
			"# macOS\n\n## macos.widget\n- kind: fact\n- scope: global\n- asOf: 2026-09-01\n- source: this session\n\nThe memory pressure widget lives in the menu bar.\n",
		);
		const { harness } = install({ paths });
		const notes: string[] = [];
		const ctx = { ...fakeContext({ mode: "print" }).ctx, ui: { notify: (message: string) => notes.push(message) }, sessionManager: { getSessionId: () => "s" } } as unknown as ExtensionCommandContext;
		const command = harness.commands.get("memory")!;

		for (const step of ["migrate backup", "migrate plan", "migrate apply --all"]) await command.handler(step, ctx);
		assert.match(notes[2]!, /wave rules: 2 claim\(s\) proposed from 2 file\(s\)/);

		// Nothing injects while the batch waits, however well it matches the prompt (D9).
		const bank = createBank({ paths, clock: CLOCK, git: async () => ({ root: "/repo/rl-pi-extensions", remote: "git@github.com:rlazoti/rl-pi-extensions.git" }) });
		assert.equal((await bank.injection("push without confirmation", "/repo/rl-pi-extensions", "s")).result.text, "");

		await command.handler("approve --wave migration", ctx);
		assert.match(notes[3]!, /approved 2 pending claim\(s\) in the migration batch/);

		const injected = (await bank.injection("push without confirmation", "/repo/rl-pi-extensions", "s")).result;
		assert.match(injected.text, /### Always-on rules\n- \[rule · global · 2026-01-01\] git-standards\.push: Never push without confirmation\./);
		assert.match(injected.text, /git-standards\.push: Never push without confirmation\./);
	} finally {
		cleanup();
	}
});

test("component: /memory review in the TUI shows the claim text and decides from keys", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		const bank = createBank({ paths, clock: CLOCK, git: async () => ({ root: "/repo/rl-pi-extensions", remote: "git@github.com:rlazoti/rl-pi-extensions.git" }) });
		bank.proposeClaim({ key: "git.flow", kind: "rule", scope: "global", asOf: "2026-01-01", source: "a test", body: "Never push without confirmation." });
		bank.proposeClaim({ key: "ledger.format", kind: "fact", scope: "global", asOf: "2026-09-01", source: "a test", body: "Ledgers are plain text files." });

		const rendered: string[] = [];
		const theme = { fg: (_style: string, text: string) => text, bg: (_style: string, text: string) => text, getBgAnsi: () => "" } as never;
		const fakeTui = { terminal: { rows: 30, cols: 80 }, requestRender() {} };
		const notes: string[] = [];
		const ctx = {
			...fakeContext({ mode: "tui" }).ctx,
			ui: {
				notify: (message: string) => notes.push(message),
				select: async () => undefined,
				editor: async () => undefined,
				input: async () => undefined,
				confirm: async () => true,
				custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { handleInput(data: string): void; render(width: number): string[] }) => {
					const card = factory(fakeTui, theme, undefined, () => {});
					// Read the card the way the user does, then decide the first claim.
					rendered.push(...card.render(80));
					card.handleInput("a");
					card.handleInput("\u001b");
					return { acted: [{ key: "git.flow", action: "approved" }], stopped: true, at: 1 };
				},
			},
			sessionManager: { getSessionId: () => "s" },
		} as unknown as ExtensionCommandContext;

		await harness0();
		async function harness0() {
			const { harness } = install({ paths, mode: "tui" });
			await harness.commands.get("memory")!.handler("review", ctx);
		}

		const screen = rendered.join("\n");
		assert.match(screen, /Review 1\/2 — git\.flow @ global/);
		assert.match(screen, /Never push without confirmation\./);
		assert.match(screen, /new claim: nothing to replace|a approve · x reject/);
		assert.match(notes[0]!, /git\.flow: approved/);
		assert.equal(bank.queueCounts().total, 1, "one approved, one still waiting");
	} finally {
		cleanup();
	}
});

test("component: one command decides a whole wave, and a long queue becomes a file to read (R18)", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		const bank = createBank({ paths, clock: CLOCK, git: async () => ({ root: "/repo/rl-pi-extensions", remote: "git@github.com:rlazoti/rl-pi-extensions.git" }) });
		for (let i = 1; i <= 13; i++) {
			bank.proposeClaim({ key: `mig.key${i}`, kind: "fact", scope: "global", asOf: "2026-01-01", source: "a test", body: `migrated fact number ${i}`, origin: "migration" });
		}
		const { harness } = install({ paths });
		const notes: string[] = [];
		const ctx = { ...fakeContext({ mode: "print" }).ctx, ui: { notify: (message: string) => notes.push(message) }, sessionManager: { getSessionId: () => "s" } } as unknown as ExtensionCommandContext;
		const command = harness.commands.get("memory")!;

		await command.handler("review --wave migration", ctx);
		assert.match(notes[0]!, /13 claims waiting/);
		assert.match(notes[0]!, /full listing written to .*migration\/review-migration-2026-10-16\.md/);
		const digest = readFileSync(join(paths.migration, "review-migration-2026-10-16.md"), "utf8");
		for (let i = 1; i <= 13; i++) assert.ok(digest.includes(`mig.key${i}`), `the digest lists mig.key${i}`);

		await command.handler("approve --wave migration", ctx);
		assert.match(notes[1]!, /approved 13 pending claim\(s\) in the migration batch/);
		const counts = bank.queueCounts();
		assert.equal(counts.total, 0, "nothing waits any more");
		assert.equal(bank.snapshot().claims.filter((claim) => claim.state === "approved").length, 13);
	} finally {
		cleanup();
	}
});

test("component: /memory migrate daily carries the working state with its dates (R15)", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		mkdirSync(join(paths.root, "core"), { recursive: true });
		writeFileSync(
			join(paths.root, "core", "dailyContext.md"),
			"# Daily Context\n\n## In Progress\n\n- (2026-10-14) verify the simulator build\n- (2026-10-16) tune the ageing defaults\n\n## Completed\n\n- (2026-10-15) wrote the design doc\n",
		);
		const { harness } = install({ paths });
		const notes: string[] = [];
		const ctx = { ...fakeContext({ mode: "print" }).ctx, ui: { notify: (message: string) => notes.push(message) }, sessionManager: { getSessionId: () => "s" } } as unknown as ExtensionCommandContext;
		const command = harness.commands.get("memory")!;
		await command.handler("migrate backup", ctx);
		await command.handler("migrate plan", ctx);
		await command.handler("migrate daily", ctx);
		assert.match(notes[notes.length - 1]!, /carried 3 open item\(s\) into .*daily\/today\.md/);
		assert.match(readFileSync(join(paths.daily, "today.md"), "utf8"), /- \(2026-10-14\) verify the simulator build/);
		await command.handler("migrate daily", ctx);
		assert.match(notes[notes.length - 1]!, /core\/dailyContext\.md: 0 added, 3 already there/);
	} finally {
		cleanup();
	}
});

test("component: the read tools work over the new layout (R41)", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		upsertClaim(paths, claim("git.flow", { body: "Never push without confirmation." }));
		propose(paths, claim("m.one", { state: "pending", origin: "migration", body: "a migrated fact about push policy" }), "2026-10-14");
		const { harness, ctx } = install({ paths });

		const list = await harness.tools.get("memory_list")!.execute("t1", {}, undefined, undefined, toolCtx());
		assert.match(list.content[0]!.text, /  claims\/rules\/git\.md \(1 approved, 0 pending, \d+ bytes\)/);
		assert.match(list.content[0]!.text, /  claims\/rules\/m\.md \(0 approved, 1 pending, \d+ bytes\)/);

		const read = await harness.tools.get("memory_read")!.execute("t2", { path: "claims/rules/git.md" }, undefined, undefined, toolCtx());
		assert.match(read.content[0]!.text, /## git\.flow/);
		const escape = await harness.tools.get("memory_read")!.execute("t3", { path: "../../../etc/passwd" }, undefined, undefined, toolCtx());
		assert.equal(escape.isError, true);
		assert.match(escape.content[0]!.text, /outside the bank/);

		const search = await harness.tools.get("memory_search")!.execute("t4", { query: "push policy" }, undefined, undefined, toolCtx());
		assert.match(search.content[0]!.text, /\[claim\] git\.flow @ global/);
		assert.match(search.content[0]!.text, /\[pending:migration\] m\.one @ global/);
	} finally {
		cleanup();
	}
});

test("component: /memory status, review and the migration gate", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		upsertClaim(paths, claim("git.flow", { body: "Never push without confirmation." }));
		propose(paths, claim("git.flow", { state: "pending", body: "Never force-push." }), "2026-10-15");
		const { harness } = install({ paths, mode: "print", cwd: "/repo/rl-pi-extensions" });
		const command = harness.commands.get("memory")!;
		const notes: string[] = [];
		const ctx = {
			...(fakeContext({ mode: "print", cwd: "/repo/rl-pi-extensions" }).ctx as object),
			ui: { notify: (message: string) => notes.push(message), select: async () => undefined, editor: async () => undefined, input: async () => undefined, confirm: async () => true },
			mode: "print",
			hasUI: false,
			signal: undefined,
			cwd: "/repo/rl-pi-extensions",
			sessionManager: { getSessionId: () => "s1" },
		} as unknown as ExtensionCommandContext;

		await command.handler("status", ctx);
		assert.match(notes[0]!, /project: github\.com\/rlazoti\/rl-pi-extensions/);
		assert.match(notes[0]!, /claims: 1 approved, 1 pending/);

		await command.handler("review", ctx);
		const review = notes[notes.length - 1]!;
		assert.match(review, /1 claim waiting/);
		assert.match(review, /replaces: Never push without confirmation\./);
		assert.match(review, /No dialog UI here: act with \/memory approve\|reject\|defer <key> \[scope\], or --wave/);

		await command.handler("approve git.flow global", ctx);
		assert.match(notes[notes.length - 1]!, /approved git\.flow @ global — the previous version is in/);

		await command.handler("migrate plan", ctx);
		assert.match(notes[notes.length - 1]!, /planned 0 source files/);

		await command.handler("migrate next", ctx);
		assert.match(notes[notes.length - 1]!, /no verified backup/);

		await command.handler("nonsense", ctx);
		assert.match(notes[notes.length - 1]!, /unknown \/memory subcommand "nonsense"/);
	} finally {
		cleanup();
	}
});

test("component: /memory review opens ONE card for the batch, not one dialog per claim", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		upsertClaim(paths, claim("git.flow", { body: "Never push without confirmation." }));
		propose(paths, claim("git.flow", { state: "pending", body: "Never force-push." }), "2026-10-15");
		const { harness } = install({ paths, mode: "tui" });
		const opened: string[] = [];
		const theme = { fg: (_style: string, text: string) => text, bg: (_style: string, text: string) => text, getBgAnsi: () => "" } as never;
		const fakeTui = { terminal: { rows: 30, cols: 80 }, requestRender() {} };
		const ctx = {
			...fakeContext({ mode: "tui" }).ctx,
			ui: {
				...fakeContext({ mode: "tui" }).ctx.ui,
				custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { handleInput(data: string): void; render(width: number): string[] }) => {
					opened.push("card");
					const card = factory(fakeTui, theme, undefined, () => {});
					card.handleInput("a"); // approve the one claim in the queue
					return { acted: [{ key: "git.flow", action: "approved" }], stopped: false, at: 0 };
				},
			},
			sessionManager: { getSessionId: () => "s" },
		} as unknown as ExtensionCommandContext;

		await harness.commands.get("memory")!.handler("review", ctx);
		assert.equal(opened.length, 1, "the batch is one dialog, and the card ends when the queue is empty");
		assert.ok(existsSync(join(paths.history, "git.flow.md")), "the approved claim it replaced is in history");
	} finally {
		cleanup();
	}
});

test("component: /memory preview shows the block and its cost", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		upsertClaim(paths, claim("git.flow", { tags: ["always"], body: "Never push without confirmation." }));
		const { harness } = install({ paths });
		const notes: string[] = [];
		const ctx = { ...fakeContext({ mode: "print" }).ctx, ui: { notify: (message: string) => notes.push(message) }, sessionManager: { getSessionId: () => "s" } } as unknown as ExtensionCommandContext;
		await harness.commands.get("memory")!.handler("preview should I push", ctx);
		assert.match(notes[0]!, /^Injection — \d+ of 2000 tokens/);
		assert.match(notes[0]!, /Always-on rules: \d+ tokens, 1 shown, 0 dropped/);
	} finally {
		cleanup();
	}
});

test("component: Pi really exports the token estimator the budget and the baseline share", async () => {
	const pi = await import("@earendil-works/pi-coding-agent");
	assert.equal(typeof pi.estimateTokens, "function", "estimateTokens must exist in the Pi install the tests run against");
	assert.equal(pi.estimateTokens({ role: "user", content: "abcdefgh" } as never), 2);
});

test("component: /memory settings lists every knob, and /memory config is its old name (R48)", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		const { harness } = install({ paths });
		const notes: string[] = [];
		const ctx = {
			...fakeContext({ mode: "print" }).ctx,
			ui: { notify: (message: string) => notes.push(message) },
			sessionManager: { getSessionId: () => "s" },
		} as unknown as ExtensionCommandContext;
		const command = harness.commands.get("memory")!;

		await command.handler("settings", ctx);
		assert.match(notes[0]!, /config\.json — not present, so every value below is a default/);
		assert.match(notes[0]!, /"maxRetrievedClaims": 6/, "a paste-ready template, not just a table");
		assert.ok(!existsSync(join(paths.root, "config.json")), "the listing writes nothing");
		assert.match(notes[0]!, /setting\s+current\s+default\s+allowed\s+in use\s+what it decides/);
		assert.match(notes[0]!, /maxRetrievedClaims\s+6\s+6\s+0\.\.200\s+default/);
		assert.match(notes[0]!, /retrieved\s+900\s+900\s+—\s+derived/);

		notes.length = 0;
		writeFileSync(join(paths.root, "config.json"), JSON.stringify({ maxRetrievedClaims: 2, budgetTokens: 1200, coreTokens: 400, dailyTokens: 300 }));
		await command.handler("config", ctx);
		const shown = notes[0]!;
		assert.ok(shown.includes(`config file: ${join(paths.root, "config.json")}`), "the old name still names the file");
		assert.match(shown, /maxRetrievedClaims\s+2\s+6\s+0\.\.200\s+file/);
		assert.match(shown, /retrieved\s+500\s+900\s+—\s+derived/);

		notes.length = 0;
		writeFileSync(join(paths.root, "config.json"), JSON.stringify({ budgetTokens: "wide" }));
		await command.handler("settings", ctx);
		assert.match(notes[0]!, /warning: .*budgetTokens must be a whole number — using 2000/);
	} finally {
		cleanup();
	}
});

test("component: an edit to config.json reaches the running session's next turn, no restart (R48)", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		for (const key of ["git.flow", "git.push", "git.merge"]) {
			upsertClaim(paths, claim(key, { body: `the git flow rule about ${key}` }));
		}
		const { harness, ctx } = install({ paths });
		const before = harness.hooks.get("before_agent_start")!;
		const turn = () => before({ type: "before_agent_start", messageType: "user", prompt: "the git flow rule" }, ctx) as Promise<{ message: { content: string } }>;

		const first = await turn();
		assert.equal((first.message.content.match(/\[rule ·/g) ?? []).length, 3, "three related claims at the default cap");

		writeFileSync(join(paths.root, "config.json"), JSON.stringify({ maxRetrievedClaims: 1 }));
		const second = await turn();
		assert.equal((second.message.content.match(/\[rule ·/g) ?? []).length, 1, "the same session honours the new cap on its next turn");
		assert.match(second.message.content, /Not shown: 2 claims \(2 rules, 0 facts\) — past the 1-claim recall cap/);

		writeFileSync(join(paths.root, "config.json"), JSON.stringify({ maxRetrievedClaims: 1, budgetTokens: 5 }));
		const third = await turn();
		assert.equal((third.message.content.match(/\[rule ·/g) ?? []).length, 1, "a bad value falls back to its default; it does not stop the turn");
	} finally {
		cleanup();
	}
});

test("component: the command list, /memory help and the completions all come from one table (R50)", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		const { harness } = install({ paths });
		const command = harness.commands.get("memory")!;
		const names = MEMORY_SUBCOMMANDS.flatMap((entry) => [entry.name, ...(entry.also ?? [])]);

		// The line Pi lists: the setting he went looking for is in it.
		for (const headline of ["status", "preview", "review", "doctor", "settings", "trial", "migrate"]) {
			assert.ok(command.description.includes(headline), `the listed description names /memory ${headline}`);
		}
		for (const entry of MEMORY_SUBCOMMANDS) {
			assert.ok(command.description.includes(entry.name), `the listed description names /memory ${entry.name}`);
		}
		assert.match(paletteDescription(60), /· … — \/memory help$/, "a list cut short says it is cut short, never looks complete");

		// Completions carry the whole table, aliases included, in the reader's words.
		const all = command.getArgumentCompletions!("");
		assert.deepEqual(all!.map((item) => item.value), names, "the completion list is the table");
		for (const item of all!) {
			assert.ok(item.description && !/\(R\d/.test(item.description), `${item.value} explains itself with no requirement ID`);
		}
		assert.deepEqual(command.getArgumentCompletions!("se")!.map((item) => item.value), ["settings"]);
		assert.deepEqual(command.getArgumentCompletions!("co")!.map((item) => item.value), ["config"], "the old name completes too");
		assert.equal(command.getArgumentCompletions!("approve git."), null, "after the first word the words are keys and scopes, not a fixed list");

		// The help text is the same table.
		const notes: string[] = [];
		const ctx = {
			...fakeContext({ mode: "print" }).ctx,
			ui: { notify: (message: string) => notes.push(message) },
			sessionManager: { getSessionId: () => "s" },
		} as unknown as ExtensionCommandContext;
		await command.handler("help", ctx);
		for (const entry of MEMORY_SUBCOMMANDS) {
			assert.match(notes[0]!, new RegExp(`^ {2}${entry.name}(\\s|$)`, "m"), `/memory help lists ${entry.name}`);
			for (const alias of entry.also ?? []) {
				assert.match(notes[0]!, new RegExp(`\(also: ${alias}\)`), `/memory help names ${alias} as the old name of ${entry.name}`);
			}
		}
		assert.ok(!/\(R\d/.test(notes[0]!), "the help text carries no requirement IDs (R49.2)");
	} finally {
		cleanup();
	}
});

test("component: every subcommand the list shows is handled; an unlisted name says so", async () => {
	const { paths, cleanup } = scratchBank();
	try {
		const { harness } = install({ paths });
		const command = harness.commands.get("memory")!;
		const notes: string[] = [];
		const ctx = {
			...fakeContext({ mode: "print" }).ctx,
			ui: { notify: (message: string) => notes.push(message) },
			sessionManager: { getSessionId: () => "s" },
		} as unknown as ExtensionCommandContext;

		for (const entry of MEMORY_SUBCOMMANDS) {
			for (const name of [entry.name, ...(entry.also ?? [])]) {
				notes.length = 0;
				await command.handler(name, ctx);
				const joined = notes.join("\n");
				assert.ok(!/but nothing handles it/.test(joined), `/memory ${name} is listed and not implemented`);
				assert.ok(!new RegExp(`unknown \\/memory subcommand "${name}"`).test(joined), `/memory ${name} is listed but dispatch does not know it`);
			}
		}

		notes.length = 0;
		await command.handler("nonsense", ctx);
		assert.match(notes[0]!, /unknown \/memory subcommand "nonsense"/);
	} finally {
		cleanup();
	}
});

test("README: it documents no /memory subcommand that does not exist, and omits none that does", () => {
	const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
	const line = readme.split("\n").find((row) => row.startsWith("| Command | `/memory"))!;
	const cell = line.match(/`([^`]+)`/g)!.map((part) => part.slice(1, -1)).find((part) => part.includes("·"))!;
	const documented = cell.split("·").map((part) => part.trim()).filter((part) => part !== "");
	const handled = MEMORY_SUBCOMMANDS.map((entry) => entry.name);

	for (const name of documented) {
		assert.ok(handled.includes(name), `the README documents /memory ${name}, which the command does not answer`);
	}
	for (const name of handled) {
		assert.ok(documented.includes(name) || name === "help", `the command answers /memory ${name} and the README never lists it`);
	}
	assert.match(line, /`config` still works as the old name/, "the README says the alias still answers");
});
