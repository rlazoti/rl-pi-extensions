// Every bare specifier an extension imports must be declared somewhere.
//
// Why this exists: `typebox` was imported at runtime by three components and
// declared by none of them — it resolved because the Pi packages that depended
// on it were hoisted into this repo's node_modules (and, in production, because
// jiti walks up into Pi's own install). Nothing tested it, and the moment the
// hoisted copy went away three suites failed and `ask`, `todos` and `memory`
// would have failed to load on a clean install. Undeclared dependencies are
// invisible until the tree they were riding on changes shape, which is exactly
// when a package is being installed for the first time on someone else's
// machine.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
const memoryManifest = JSON.parse(
	readFileSync(path.join(repoRoot, "extensions/memory/package.json"), "utf-8"),
);

// Line-anchored on purpose: a bare `from "…"` regex also matches prose, and one
// test comment read a package named `it did not` out of a sentence.
const SIDE_EFFECT = /^\s*import\s+["']([^"']+)["']/;
const DYNAMIC = /\b(?:import|require)\s*\(\s*["']([^"']+)["']/g;

/** Every module specifier a source file imports, statically or dynamically. */
export function specifiersIn(text: string): string[] {
	const found: string[] = [];
	for (const line of text.split("\n")) {
		const closing = /^\s*\}\s*(from|assert)\s*["']([^"']+)["']/.exec(line);
		if (closing) found.push(closing[2]);
		else if (/^\s*(import|export)\b/.test(line)) {
			const staticImport = /^\s*(?:import|export)\b.*?\bfrom\s+["']([^"']+)["']/.exec(line);
			if (staticImport) found.push(staticImport[1]);
			else {
				const sideEffect = SIDE_EFFECT.exec(line);
				if (sideEffect) found.push(sideEffect[1]);
			}
		}
		for (const match of line.matchAll(DYNAMIC)) found.push(match[1]);
	}
	return found;
}

function sources(dir: string, found: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) sources(full, found);
		else if (entry.name.endsWith(".ts")) found.push(full);
	}
	return found;
}

/** The package a specifier belongs to ("@scope/name/sub" → "@scope/name"). */
function packageNameOf(specifier: string) {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function declaredFor(file: string) {
	const inMemory = file.startsWith(path.join(repoRoot, "extensions", "memory", ""));
	const names = new Set([
		...Object.keys(rootManifest.dependencies ?? {}),
		...Object.keys(rootManifest.devDependencies ?? {}),
	]);
	if (inMemory) {
		for (const field of ["dependencies", "devDependencies"]) {
			for (const name of Object.keys(memoryManifest[field] ?? {})) names.add(name);
		}
	}
	return names;
}

test("deps: the scanner reads imports and ignores prose", () => {
	// The gate above is only as good as this: a scanner that matched nothing would
	// report a perfectly clean dependency graph.
	assert.deepEqual(
		specifiersIn(
			[
				'import { Type } from "typebox";',
				'import { complete } from "@earendil-works/pi-ai/compat";',
				'import {',
				"  one,",
				'} from "@earendil-works/pi-coding-agent";',
				'import "node:test";',
				'const m = await import("minisearch");',
				'// the verdict differs from "it did not" when the model stops',
				'export type { Task } from "./types.js";',
			].join("\n"),
		),
		[
			"typebox",
			"@earendil-works/pi-ai/compat",
			"@earendil-works/pi-coding-agent",
			"node:test",
			"minisearch",
			"./types.js",
		],
	);
});

test("deps: every imported package is declared in a manifest", () => {
	const undeclared = new Map();
	for (const file of sources(path.join(repoRoot, "extensions"))) {
		for (const specifier of specifiersIn(readFileSync(file, "utf-8"))) {
			if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
			if (isBuiltin(specifier) || specifier.startsWith("node:")) continue;
			const name = packageNameOf(specifier);
			if (name.startsWith("@earendil-works/") || name.startsWith("@mariozechner/")) continue;
			if (declaredFor(file).has(name)) continue;
			if (!undeclared.has(name)) undeclared.set(name, path.relative(repoRoot, file));
		}
	}
	assert.deepEqual(
		[...undeclared].map(([name, file]) => `${name} (first imported by ${file})`),
		[],
		"runtime imports resolved only because something else hoisted them — add them to package.json",
	);
});

test("deps: the Pi packages the sources import are exactly the declared peers", () => {
	// Peers are the contract with the host: they must name everything the sources
	// import, and only what the sources import, or a component reads an API the
	// host never promised it.
	const imported = new Set();
	for (const file of sources(path.join(repoRoot, "extensions"))) {
		for (const specifier of specifiersIn(readFileSync(file, "utf-8"))) {
			const name = packageNameOf(specifier);
			if (name.startsWith("@earendil-works/")) imported.add(name);
		}
	}
	assert.ok(imported.size > 0, "the scanner found no Pi imports — the regex stopped matching");
	const peers = new Set(Object.keys(rootManifest.peerDependencies ?? {}));
	assert.deepEqual([...imported].sort(), [...peers].sort());
	for (const [name, range] of Object.entries(rootManifest.peerDependencies ?? {})) {
		assert.equal(range, "*", `${name} must stay at * — a pinned peer makes installs need one Pi release`);
		assert.equal(
			rootManifest.peerDependenciesMeta?.[name]?.optional,
			true,
			`${name} must stay optional, or package managers auto-install a copy of the host`,
		);
	}
});

test("deps: the runtime dependencies a component needs are installable without Pi", () => {
	// Pi installs with --omit=dev, so a runtime import satisfied only by a
	// devDependency is a component that loads on a developer machine and nowhere
	// else.
	const dev = new Set(Object.keys(rootManifest.devDependencies ?? {}));
	const deps = new Set(Object.keys(rootManifest.dependencies ?? {}));
	for (const name of deps) assert.ok(!dev.has(name), `${name} is both a dependency and a devDependency`);
	for (const needed of ["minisearch", "typebox"]) {
		assert.ok(deps.has(needed), `${needed} is imported at runtime and must be a dependency, not a dev one`);
	}
	// Declared must also mean resolvable from the repo root right now.
	for (const name of deps) {
		assert.ok(
			existsSync(path.join(repoRoot, "node_modules", name, "package.json")),
			`${name} is declared but not installed — run npm install`,
		);
	}
});

test("deps: no manifest names a Pi package as something to install", () => {
	// The install failure this guards: pnpm resolves devDependencies even under
	// `--prod`, so a Pi version in a manifest becomes a registry requirement.
	for (const [label, manifest] of [
		["package.json", rootManifest],
		["extensions/memory/package.json", memoryManifest],
	]) {
		for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
			const pinned = Object.keys(manifest[field] ?? {}).filter((n) => n.startsWith("@earendil-works/"));
			assert.deepEqual(pinned, [], `${label} ${field} must not carry Pi packages: ${pinned.join(", ")}`);
		}
	}
});

test("deps: nothing is left importing a package this repo no longer installs", () => {
	// A guard on the guard: if node_modules silently gains a Pi copy again, the
	// hoisting hazard this file exists to catch is back.
	const scope = path.join(repoRoot, "node_modules", "@earendil-works");
	const copies = existsSync(scope) ? readdirSync(scope) : [];
	assert.deepEqual(
		copies,
		[],
		"@earendil-works copies are installed here; the type gate and the tests read the Pi install instead",
	);
});
