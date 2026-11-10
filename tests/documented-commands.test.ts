import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * A command line in a README is an API surface: someone types it. A name that
 * only exists in prose fails with `Missing script` in front of them, and a
 * `npm run gen:ts-paths` that greps for its own output hides the error even from
 * the person who wrote it (this repo documented a generator command by the wrong
 * name for a whole release: the script was `types:gen`, and the docs' name was
 * never run without a filter on it).
 *
 * Scope follows the reader: a command written in a component's README may be one
 * of that package's scripts, because that is the directory they are standing in.
 */
const COMMAND = /\bnpm run ([A-Za-z0-9:_.-]+)/g;

const NAMED_BY_READERS = /\.(md|ts|mjs|cjs|js)$/;

/** Prose and source alike: a test failure telling someone to run a command is documentation. */
function filesWithAdvice(dir: string, found: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		// Vendored and generated trees are not this repo's advice.
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) filesWithAdvice(full, found);
		else if (NAMED_BY_READERS.test(entry.name)) found.push(full);
	}
	return found;
}

/** Every script runnable from `dir`: its own package, then each ancestor's. */
function scriptsVisibleFrom(dir: string): Set<string> {
	const names = new Set<string>();
	let current = dir;
	while (true) {
		const manifest = path.join(current, "package.json");
		if (existsSync(manifest)) {
			for (const name of Object.keys(JSON.parse(readFileSync(manifest, "utf-8")).scripts ?? {})) {
				names.add(name);
			}
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return names;
}

test("the repo only names npm scripts that exist where the reader would run them", () => {
	const docs = filesWithAdvice(repoRoot);
	const offenders: string[] = [];
	const seen = new Set<string>();
	for (const file of docs) {
		const visible = scriptsVisibleFrom(path.dirname(file));
		const text = readFileSync(file, "utf-8");
		for (const match of text.matchAll(COMMAND)) {
			const name = match[1];
			seen.add(name);
			if (!visible.has(name)) {
				offenders.push(`${path.relative(repoRoot, file)}: npm run ${name}`);
			}
		}
	}
	// A guard that matches nothing is itself a bug: the docs do name commands.
	assert.ok(seen.size >= 6, `expected the repo to name npm scripts, found: ${[...seen].join(", ")}`);
	assert.deepEqual(offenders, [], "docs name commands that do not exist as scripts");
});
