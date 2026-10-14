// Tests for the test harness itself (test-support/). They pin the resolution
// rules every other suite silently depends on: if a Pi package stops resolving
// to the packages Pi actually loads, or this repo's type-only copy drifts from
// the runtime, these fail loudly instead of the suite quietly testing a
// different version than production runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findPiInstallNodeModulesDir, packageVersion } from "../test-support/hooks.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const piNodeModulesDir = findPiInstallNodeModulesDir();
const PI_PACKAGES = ["pi-coding-agent", "pi-tui", "pi-ai"];
const noPiInstall = !piNodeModulesDir;

test("test harness: Pi packages resolve to the packages the running Pi loads", (t) => {
	if (noPiInstall) return t.skip("no local Pi install (PI_CODING_AGENT_DIR overrides the layout)");
	for (const name of PI_PACKAGES) {
		const url = import.meta.resolve(`@earendil-works/${name}`);
		assert.ok(
			url.startsWith(`file://${piNodeModulesDir}`),
			`${name} resolved to ${url}, not the Pi install at ${piNodeModulesDir} — tests would run against this repo's type-only copy`,
		);
		assert.ok(
			!url.startsWith(`file://${path.join(repoRoot, "node_modules")}`),
			`${name} resolved into this repo's node_modules`,
		);
	}
});

test("test harness: the pi-ai ROOT resolves to the compat entrypoint, as in Pi's loader", async (t) => {
	if (noPiInstall) return t.skip("no local Pi install");
	// Pi serves the root as compat (virtual-modules.js). A test environment that
	// served the core entry instead would hide the missing-export failure this
	// repo actually hit with session-banner's complete() import.
	assert.ok(import.meta.resolve("@earendil-works/pi-ai").endsWith("/dist/compat.js"));
	const piAi = (await import("@earendil-works/pi-ai")) as { complete?: unknown };
	assert.equal(typeof piAi.complete, "function", "the resolved pi-ai root does not export complete()");
});

test("test harness: pi-ai subpaths resolve inside the same install", (t) => {
	if (noPiInstall) return t.skip("no local Pi install");
	const url = import.meta.resolve("@earendil-works/pi-ai/compat");
	assert.ok(url.startsWith(`file://${piNodeModulesDir}`), `resolved to ${url}`);
	assert.ok(url.endsWith("/dist/compat.js"), `unexpected entry for the compat subpath: ${url}`);
});

test("test harness: the type-check's pinned copy matches the runtime versions", (t) => {
	if (noPiInstall) return t.skip("no local Pi install");
	for (const name of PI_PACKAGES) {
		const runtime = packageVersion(path.join(piNodeModulesDir, "@earendil-works", name));
		const localCopy = path.join(repoRoot, "node_modules", "@earendil-works", name);
		const types = packageVersion(localCopy);
		if (!types) continue; // no local copy: `npm install` must provide it for tsc anyway
		assert.equal(
			types,
			runtime,
			`@earendil-works/${name}: npm run typecheck reads ${types} but tests run ${runtime} — bump package.json so the type gate checks the code Pi actually executes`,
		);
	}
});

test("test harness: a mismatched copy is reported on stderr instead of used silently", () => {
	// A fake "Pi install" whose version cannot match the repo's copy.
	const tmp = mkdtempSync(path.join(os.tmpdir(), "fake-pi-install-"));
	const pkg = path.join(tmp, "@earendil-works", "pi-coding-agent");
	mkdirSync(path.join(pkg, "dist"), { recursive: true });
	writeFileSync(
		path.join(pkg, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.0.1-fake", type: "module" }),
	);
	writeFileSync(path.join(pkg, "dist/index.js"), "export const __fake = true;\n");
	try {
		const result = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test-support/register.mjs",
				"-e",
				'import("@earendil-works/pi-coding-agent").then((m) => console.log("loaded:" + m.__fake))',
			],
			{
				cwd: repoRoot,
				encoding: "utf8",
				env: { ...process.env, PI_CODING_AGENT_DIR: pkg },
			},
		);
		const output = `${result.stdout}${result.stderr}`;
		assert.equal(result.status, 0, output);
		assert.match(output, /loaded:true/, "the fake install was not used as the resolution source");
		assert.match(output, /resolve to the Pi install \(0\.0\.1-fake at /, `child output:\n${output}`);
		assert.match(output, /bump package\.json/, `a stale type-only copy must be reported on stderr. Child output:\n${output}`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("test harness: jiti-style relative .js specifiers map to .ts inside the repo", () => {
	// Extension sources import "./implementation.js"; the hook resolves that to
	// the .ts file so bare `node --test` can load them.
	assert.ok(
		import.meta.resolve("../extensions/session-banner/implementation.js").endsWith("/implementation.ts"),
	);
});
