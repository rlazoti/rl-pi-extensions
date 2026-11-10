// The guard that names the setup step instead of leaving `sh: vitest: command
// not found` — see scripts/require-memory-deps.mjs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { REQUIRED_TOOLS, formatMissingInstall, missingMemoryTools } from "../scripts/require-memory-deps.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function tempMemoryDir(t: TestContext, { bins = [] }: { bins?: string[] } = {}) {
	const root = mkdtempSync(path.join(os.tmpdir(), "memory-deps-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const memoryDir = path.join(root, "extensions", "memory");
	if (bins.length > 0) {
		mkdirSync(path.join(memoryDir, "node_modules", ".bin"), { recursive: true });
		for (const bin of bins) writeFileSync(path.join(memoryDir, "node_modules", ".bin", bin), "#!/bin/sh\n");
	}
	return memoryDir;
}

test("memory deps: a manifest without the tools reports every one of them", (t) => {
	const missing = missingMemoryTools(tempMemoryDir(t));
	assert.deepEqual(missing, REQUIRED_TOOLS);
	assert.ok(missing.includes("vitest"), "the tool whose absence used to read as a broken suite");
});

test("memory deps: an installed toolchain passes silently", (t) => {
	const memoryDir = tempMemoryDir(t, { bins: REQUIRED_TOOLS });
	assert.deepEqual(missingMemoryTools(memoryDir), []);
});

test("memory deps: a half-installed tree names only what is absent", (t) => {
	const memoryDir = tempMemoryDir(t, { bins: ["vitest"] });
	assert.deepEqual(missingMemoryTools(memoryDir), ["tsc"]);
});

test("memory deps: the message gives the command to run", () => {
	const message = formatMissingInstall(["vitest", "tsc"]);
	assert.match(message, /npm run setup:memory/);
	assert.match(message, /vitest, tsc/);
	// The reason belongs in the message too, or the next reader removes the guard
	// to make the failure go away.
	assert.match(message, /Pi never installs them/);
});

test("memory deps: the guard runs as the gate the scripts call", async () => {
	// It is wired into test:memory and typecheck, so a fresh clone stops at a
	// named step rather than deep inside a nested npm run.
	const scripts = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf-8")).scripts;
	for (const key of ["test:memory", "typecheck"]) {
		assert.match(
			scripts[key],
			/node scripts\/require-memory-deps\.mjs/,
			`${key} must run the guard before memory's own scripts`,
		);
	}
	assert.match(scripts["setup:memory"], /extensions\/memory/, "setup:memory must install where the manifest is");
});
