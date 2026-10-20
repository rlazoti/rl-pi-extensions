// Tests for the test harness itself (test-support/). They pin the resolution
// rules every other suite silently depends on: if a Pi package stops resolving
// to the packages Pi actually loads, or this repo's type-only copy drifts from
// the runtime, these fail loudly instead of the suite quietly testing a
// different version than production runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

/** A directory that looks like a Pi install root holding one release. */
function fakeInstall(root: string, version: string): string {
	const pkg = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(path.join(pkg, "dist"), { recursive: true });
	writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
	writeFileSync(path.join(pkg, "dist", "index.js"), "export const __fake = true;\n");
	return root;
}

function captureStderr(run: () => unknown): { result: unknown; output: string } {
	const write = process.stderr.write.bind(process.stderr);
	let output = "";
	try {
		process.stderr.write = (chunk: string) => {
			output += chunk;
			return true;
		};
		return { result: run(), output };
	} finally {
		process.stderr.write = write;
	}
}

test("test harness: the Pi the launcher runs wins over the newest directory on disk", () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "fake-home-"));
	const managed = path.join(home, ".pi", "agent", "install");
	try {
		fakeInstall(path.join(managed, "releases", "1.2.0"), "1.2.0");
		fakeInstall(path.join(managed, "releases", "1.3.0"), "1.3.0");
		// `pi` is a shell script that reads this file; the tests read it too, so a
		// machine holding two releases runs the suite against the one `pi` runs.
		writeFileSync(path.join(managed, "current-version"), "1.2.0\n");
		assert.equal(findPiInstallNodeModulesDir({}, home), path.join(managed, "releases", "1.2.0", "node_modules"));

		// With nothing to read, the newest release is the best answer, version-sorted
		// so 1.10.0 beats 1.9.0 (a text sort gets that backwards).
		rmSync(path.join(managed, "current-version"));
		fakeInstall(path.join(managed, "releases", "1.10.0"), "1.10.0");
		assert.equal(findPiInstallNodeModulesDir({}, home), path.join(managed, "releases", "1.10.0", "node_modules"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("test harness: PI_PACKAGE_DIR finds a Pi built from source or vendored elsewhere", () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "vendored-pi-"));
	try {
		const release = fakeInstall(path.join(tmp, "checkout"), "1.1.0");
		const nodeModules = path.join(release, "node_modules");
		const pkg = path.join(nodeModules, "@earendil-works", "pi-coding-agent");
		for (const [shape, value] of [
			["the node_modules itself", nodeModules],
			["the package directory", pkg],
			["a directory holding node_modules", release],
		] as const) {
			assert.equal(findPiInstallNodeModulesDir({ PI_PACKAGE_DIR: value }, path.join(tmp, "empty-home")), nodeModules, shape);
		}
		// PI_MANAGED_INSTALL_ROOT moves the whole layout, which is how a CI box with
		// no ~/.pi at all still tests against a real Pi.
		const managed = path.join(tmp, "managed");
		fakeInstall(path.join(managed, "releases", "2.0.0"), "2.0.0");
		writeFileSync(path.join(managed, "current-version"), "2.0.0\n");
		assert.equal(
			findPiInstallNodeModulesDir({ PI_MANAGED_INSTALL_ROOT: managed }, path.join(tmp, "empty-home")),
			path.join(managed, "releases", "2.0.0", "node_modules"),
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("test harness: ~/.pi/pkg/pi-<version> is searched newest first", () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "pkg-home-"));
	try {
		fakeInstall(path.join(home, ".pi", "pkg", "pi-1.2.0"), "1.2.0");
		fakeInstall(path.join(home, ".pi", "pkg", "pi-1.10.0"), "1.10.0");
		assert.equal(findPiInstallNodeModulesDir({}, home), path.join(home, ".pi", "pkg", "pi-1.10.0", "node_modules"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("test harness: an override that points at nothing says so instead of choosing quietly", () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "bogus-override-"));
	const managed = path.join(home, ".pi", "agent", "install");
	try {
		fakeInstall(path.join(managed, "releases", "1.3.0"), "1.3.0");
		writeFileSync(path.join(managed, "current-version"), "1.3.0\n");
		const { result, output } = captureStderr(() => findPiInstallNodeModulesDir({ PI_PACKAGE_DIR: path.join(home, "nowhere") }, home));
		assert.equal(result, path.join(managed, "releases", "1.3.0", "node_modules"), "the live install is still found");
		assert.match(output, /PI_PACKAGE_DIR is set to .*nowhere, which holds no @earendil-works\/pi-coding-agent/);

		// And when nothing at all resolves, the fallback is the repo's copy — which is
		// the wrong version the moment Pi moves, so it is said out loud.
		const { result: none, output: said } = captureStderr(() => findPiInstallNodeModulesDir({ PI_CODING_AGENT_DIR: path.join(home, "also-nowhere") }, path.join(home, "empty")));
		assert.equal(none, null);
		assert.match(said, /PI_CODING_AGENT_DIR is set to/);
		assert.match(said, /falling back to this repo's node_modules/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("test harness: the repo says which Node it needs, because the suite needs it (F5)", () => {
	// `--experimental-strip-types` (npm test) and the mock-timer behaviour the
	// session-banner tests rely on are both Node 26 things; on an older Node the
	// suite does not fail, it does not run.
	const engines = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).engines;
	assert.deepEqual(engines, { node: ">=26" });
	const [major] = process.versions.node.split(".").map(Number);
	assert.ok(major >= 26, `the suite is running on Node ${process.versions.node}, below what package.json declares`);
});
