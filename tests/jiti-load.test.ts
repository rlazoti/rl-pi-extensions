import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, statSync } from "node:fs";
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

test("memory registers its tools, its command and exactly two hooks under jiti", async () => {
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
	assert.deepEqual(registration.hooks.sort(), ["before_agent_start", "session_start"]);
});
