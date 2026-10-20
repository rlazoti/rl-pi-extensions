import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, readdirSync, mkdtempSync, rmSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJiti } from "jiti";

import { getMonorepoRoot } from "../extensions/symlink-manager.ts";

/**
 * Pi loads extensions through jiti, which strips types without checking them and
 * compiles ESM to CommonJS. A module can pass `npm test` (bare node with
 * `--experimental-strip-types`) and still fail to load in Pi — a specifier that
 * only resolves in Pi's virtual-module loader, a transform-only syntax node, a
 * top-level await. This loads every component the way Pi does, and pins the
 * surface `memory` registers, because that one is the largest.
 */

interface Registration {
	tools: string[];
	commands: string[];
	shortcuts: string[];
	hooks: string[];
}

function stubPi(): { pi: unknown; registration: Registration } {
	const registration: Registration = { tools: [], commands: [], shortcuts: [], hooks: [] };
	const events = { on: () => () => {}, emit: () => {}, off: () => {} };
	const pi = {
		on: (event: string) => {
			registration.hooks.push(event);
			return () => {};
		},
		events,
		registerTool: (tool: { name: string }) => registration.tools.push(tool.name),
		registerCommand: (name: string) => registration.commands.push(name),
		registerShortcut: (shortcut: string) => registration.shortcuts.push(shortcut),
		registerMessageRenderer: () => {},
		registerFlag: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		getSessionName: () => undefined,
		setSessionName: () => {},
	};
	return { pi, registration };
}

function componentDirs(root: string): string[] {
	return readdirSync(join(root, "extensions"))
		.filter((entry) => {
			const dir = join(root, "extensions", entry);
			return statSync(dir).isDirectory() && readdirSync(dir).includes("index.ts");
		})
		.sort();
}

test("every component loads under Pi's jiti transform and exports a factory", async () => {
	const root = getMonorepoRoot();
	const jiti = createJiti(join(root, "tests", "jiti-load.ts"), { moduleCache: false });
	const dirs = componentDirs(root);
	assert.ok(dirs.includes("memory"), "the sweep covers the memory component");
	for (const dir of dirs) {
		const module = (await jiti.import(`../extensions/${dir}/index.ts`)) as { default?: unknown };
		const factory = module.default ?? module;
		assert.equal(typeof factory, "function", `${dir}: default export is the extension factory`);
		const { pi, registration } = stubPi();
		(factory as (pi: unknown) => void)(pi);
		assert.ok(
			registration.tools.length + registration.commands.length + registration.shortcuts.length + registration.hooks.length > 0,
			`${dir}: registering nothing means Pi shows nothing`,
		);
	}
});

test("memory registers its tools, its command and its three hooks under jiti", async () => {
	const jiti = createJiti(join(getMonorepoRoot(), "tests", "jiti-load.ts"), { moduleCache: false });
	const module = (await jiti.import("../extensions/memory/index.ts")) as { default: (pi: unknown) => void };
	const { pi, registration } = stubPi();
	module.default(pi);
	assert.deepEqual(registration.tools.sort(), [
		"memory_archive",
		"memory_list",
		"memory_log",
		"memory_propose",
		"memory_read",
		"memory_search",
	]);
	assert.deepEqual(registration.commands, ["memory"]);
	assert.deepEqual(registration.hooks.sort(), ["before_agent_start", "context", "session_start"]);
});

/**
 * The reason this file exists, exercised instead of asserted: a handler that only
 * fails under jiti's transform is invisible to `npm test`, and before F5 a corrupt
 * claim store was invisible in every mode — `StoreUnreadable` was a string inside a
 * caught `Outcome`.
 */
test("memory reports a corrupt claim store through Pi's jiti transform", async () => {
	const root = getMonorepoRoot();
	const jiti = createJiti(join(root, "tests", "jiti-load.ts"), { moduleCache: false });
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "memory-jiti-")));
	const bank = join(dir, "bank");
	const previous = process.env.PI_MEMORY_DIR;
	process.env.PI_MEMORY_DIR = bank;
	try {
		mkdirSync(join(bank, "claims", "rules"), { recursive: true });
		// One real claim, and one heading the grammar cannot read: the writer refuses
		// this file until it is fixed, and that is worth saying out loud.
		writeFileSync(
			join(bank, "claims", "rules", "git.md"),
			"# rule claims about git\n\n## git.flow\nkind: rule\nscope: global\nasOf: 2026-01-01\nsource: a probe\n\nNever push without confirmation.\n\n## Notes — not a key\nJust prose under a heading nobody approved.\n",
			"utf8",
		);

		const handlers = new Map<string, (event: never, ctx: unknown) => Promise<unknown>>();
		const notes: { message: string; level?: string }[] = [];
		const pi = {
			on: (event: string, handler: (event: never, ctx: unknown) => Promise<unknown>) => {
				handlers.set(event, handler);
				return () => {};
			},
			events: { on: () => () => {}, emit: () => {}, off: () => {} },
			registerTool: () => {},
			registerCommand: () => {},
			registerShortcut: () => {},
			registerMessageRenderer: () => {},
			registerFlag: () => {},
			appendEntry: () => {},
			sendMessage: () => {},
			sendUserMessage: () => {},
			exec: async () => ({ stdout: "", stderr: "", code: 0 }),
			getSessionName: () => undefined,
			setSessionName: () => {},
		};
		const module = (await jiti.import("../extensions/memory/index.ts")) as { default: (pi: unknown) => void };
		module.default(pi);
		const ctx = {
			mode: "tui",
			hasUI: true,
			cwd: dir,
			ui: { notify: (message: string, level?: string) => notes.push({ message, level }), select: async () => undefined, editor: async () => undefined, input: async () => undefined, confirm: async () => true },
			sessionManager: { getSessionId: () => "jiti-session" },
		};

		await handlers.get("session_start")!({ type: "session_start", reason: "startup" } as never, ctx);
		const warnings = notes.filter((note) => note.level === "warning");
		assert.equal(warnings.length, 1, `one warning about the store, got: ${notes.map((note) => note.message).join(" | ")}`);
		assert.match(warnings[0]!.message, /no writer can reproduce/);
		assert.match(warnings[0]!.message, /Notes — not a key/);
		assert.match(readFileSync(join(bank, "metrics", "errors.jsonl"), "utf8"), /"where":"claim store"/);

		// The context hook still works on a damaged bank: it prunes, and it does not
		// take the model call down with it.
		const block = { role: "custom", customType: "memory", display: false, timestamp: 1, content: "## Memory — rules and facts for this context\n- Never push without confirmation." };
		const first = { role: "custom", customType: "memory", display: false, timestamp: 2, content: "## Memory — rules and facts for this context (later)\n- Never push without confirmation." };
		const result = (await handlers.get("context")!({ type: "context", messages: [block, first] } as never, ctx)) as { messages: unknown[] } | undefined;
		assert.equal(result?.messages.length, 1, "the older block is not sent again");
		assert.equal(result?.messages[0], first);
		// The good claim still injects: damage is reported, not fatal (R30).
		const injected = (await handlers.get("before_agent_start")!({ type: "before_agent_start", messageType: "user", prompt: "git flow" } as never, ctx)) as { message: { content: string } } | undefined;
		assert.match(injected?.message.content ?? "", /Never push without confirmation\./);
	} finally {
		if (previous === undefined) delete process.env.PI_MEMORY_DIR;
		else process.env.PI_MEMORY_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
