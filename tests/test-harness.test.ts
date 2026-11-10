// Tests for the test harness itself (test-support/) and for the contract it
// shares with the type gate. They pin the rules every other suite silently
// depends on: Pi packages resolve to the packages the running Pi loads, the
// repo keeps no installable copy of them (that is what made installs depend on
// a Pi release a registry mirror happened not to have), and the declarations
// `npm run typecheck` reads come out of the same install. If any of those
// break, the suite would be checking a different Pi than production runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { findPiInstallNodeModulesDir, packageVersion, compareReleaseNames } from "../test-support/hooks.mjs";
import { OUTPUT_RELATIVE, buildPiTypePaths } from "../scripts/gen-ts-paths.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const piNodeModulesDir = findPiInstallNodeModulesDir();
const PI_PACKAGES = ["pi-coding-agent", "pi-tui", "pi-ai"];
const noPiInstall = !piNodeModulesDir;

/** Run `fn` with $HOME (and Windows' equivalent) pointing at `dir`. */
function withHome(dir: string, fn: () => void) {
	const savedHome = process.env.HOME;
	const savedProfile = process.env.USERPROFILE;
	process.env.HOME = dir;
	process.env.USERPROFILE = dir;
	try {
		fn();
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = savedProfile;
	}
}

/** Write a Pi-shaped release tree; returns the dir to point PI_CODING_AGENT_DIR at. */
function fakePiPackage(root: string, name: string, version: string): string {
	const pkg = path.join(root, "@earendil-works", name);
	mkdirSync(path.join(pkg, "dist"), { recursive: true });
	writeFileSync(
		path.join(pkg, "package.json"),
		JSON.stringify({ name: `@earendil-works/${name}`, version, type: "module" }),
	);
	writeFileSync(path.join(pkg, "dist", "index.js"), "export const __fake = true;\n");
	writeFileSync(path.join(pkg, "dist", "index.d.ts"), "export {};\n");
	return pkg;
}

test("test harness: Pi packages resolve to the packages the running Pi loads", (t) => {
	if (noPiInstall) return t.skip("no local Pi install (PI_CODING_AGENT_DIR overrides the layout)");
	for (const name of PI_PACKAGES) {
		const url = import.meta.resolve(`@earendil-works/${name}`);
		assert.ok(
			url.startsWith(`file://${piNodeModulesDir}`),
			`${name} resolved to ${url}, not the Pi install at ${piNodeModulesDir} — tests would run against some other copy`,
		);
		assert.ok(
			!url.startsWith(`file://${path.join(repoRoot, "node_modules")}`),
			`${name} resolved into this repo's node_modules; a peer copy must never be the code under test`,
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

test("test harness: the tests run the release current-version names, not just the newest dir", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-releases-"));
	try {
		const install = path.join(tmp, ".pi", "agent", "install");
		for (const version of ["1.4.9", "1.5.10", "1.5.2"]) {
			fakePiPackage(path.join(install, "releases", version, "node_modules"), "pi-coding-agent", version);
		}
		// Pi keeps the previous release after an update so a session can roll back,
		// and names the live one in current-version. A directory listing would run
		// the suite against a Pi nobody is using.
		writeFileSync(path.join(install, "current-version"), "1.5.2\n");
		withHome(tmp, () => {
			assert.equal(findPiInstallNodeModulesDir(), path.join(install, "releases", "1.5.2", "node_modules"));
		});
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("test harness: without current-version the highest release wins, numerically", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-releases-"));
	try {
		const install = path.join(tmp, ".pi", "agent", "install");
		for (const version of ["1.5.2", "1.5.10", "1.4.9"]) {
			fakePiPackage(path.join(install, "releases", version, "node_modules"), "pi-coding-agent", version);
		}
		// A lexicographic sort puts 1.5.2 above 1.5.10 and would test a stale release.
		withHome(tmp, () => {
			assert.equal(findPiInstallNodeModulesDir(), path.join(install, "releases", "1.5.10", "node_modules"));
			// A current-version naming a pruned release must not strand the suite.
			writeFileSync(path.join(install, "current-version"), "9.9.9\n");
			assert.equal(findPiInstallNodeModulesDir(), path.join(install, "releases", "1.5.10", "node_modules"));
			// Releases Pi keeps for other reasons (staging, junk dirs) are not installs.
			mkdirSync(path.join(install, "releases", "staging"), { recursive: true });
			assert.equal(findPiInstallNodeModulesDir(), path.join(install, "releases", "1.5.10", "node_modules"));
		});
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("test harness: compareReleaseNames orders releases the way Pi means it", () => {
	const sorted = ["1.5.2", "1.5.10", "1.10.0", "1.4.9"].sort(compareReleaseNames);
	assert.deepEqual(sorted, ["1.4.9", "1.5.2", "1.5.10", "1.10.0"]);
	assert.equal(compareReleaseNames("1.5.1", "1.5.1"), 0);
});

test("test harness: no Pi install is refused with the fix, not with ERR_MODULE_NOT_FOUND", () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "no-pi-home-"));
	try {
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp, USERPROFILE: tmp };
		delete env.PI_CODING_AGENT_DIR;
		const result = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test-support/register.mjs",
				"-e",
				'import("@earendil-works/pi-coding-agent").then(() => console.log("loaded?!"))',
			],
			{ cwd: repoRoot, encoding: "utf8", env },
		);
		const output = `${result.stdout}${result.stderr}`;
		assert.notEqual(result.status, 0, "resolving a Pi package without a Pi install must not succeed");
		assert.doesNotMatch(output, /loaded\?!/);
		assert.match(output, /no Pi install found/, `child output:\n${output}`);
		assert.match(output, /PI_CODING_AGENT_DIR/, `the error must name the override. Child output:\n${output}`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("test harness: PI_CODING_AGENT_DIR is honoured by both the runtime hook and the type generator", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "fake-pi-install-"));
	try {
		const pkg = fakePiPackage(tmp, "pi-coding-agent", "0.0.1-fake");
		const result = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test-support/register.mjs",
				"-e",
				'import("@earendil-works/pi-coding-agent").then((m) => console.log("loaded:" + m.__fake))',
			],
			{ cwd: repoRoot, encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: pkg } },
		);
		const output = `${result.stdout}${result.stderr}`;
		assert.equal(result.status, 0, output);
		assert.match(output, /loaded:true/, "the override was not used as the resolution source");
		// The same dir must be what the declarations come from, or the type gate
		// checks one Pi while the tests run another.
		const { versions } = buildPiTypePaths(path.dirname(path.dirname(pkg)));
		assert.equal(versions["pi-coding-agent"], "0.0.1-fake");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("test harness: this repo installs no copy of Pi, at any version", () => {
	// The regression this guards is an install failure, not a test failure: pnpm
	// resolves devDependencies even under `--prod`, so an exact pin here made
	// `pi install` need a Pi release the internal mirror had not synced
	// (ERR_PNPM_NO_MATCHING_VERSION) for code Pi provides at runtime anyway.
	const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
	for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
		const deps = manifest[field] ?? {};
		const pinned = Object.keys(deps).filter((name) => name.startsWith("@earendil-works/"));
		assert.deepEqual(pinned, [], `${field} must not carry @earendil-works/*: ${pinned.join(", ")}`);
	}
	// Peers document the host requirement. They are only safe while they can
	// never name a version that may be missing from a mirror.
	for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
		assert.equal(range, "*", `${name} is pinned to "${range}"; keep peers at * or installs inherit Pi's release schedule`);
	}
});

test("test harness: the type-check reads the same install the tests run", (t) => {
	if (noPiInstall) return t.skip("no local Pi install");
	const file = path.join(repoRoot, OUTPUT_RELATIVE);
	if (!existsSync(file)) {
		assert.fail(`${OUTPUT_RELATIVE} is missing — run \`npm run types:gen\` (npm install, test and typecheck generate it)`);
	}
	const { paths } = JSON.parse(readFileSync(file, "utf-8")).compilerOptions;
	for (const name of PI_PACKAGES) {
		const target = paths[`@earendil-works/${name}`]?.[0];
		assert.ok(target, `no type entry for @earendil-works/${name} — tsc cannot resolve what the sources import`);
		assert.ok(
			target.startsWith(`${piNodeModulesDir}${path.sep}`),
			`@earendil-works/${name} types come from ${target}, outside the install under test (${piNodeModulesDir})`,
		);
		// A declaration with no sibling implementation would type-check a module
		// that does not exist at runtime.
		assert.ok(existsSync(target.replace(/\.d\.ts$/, ".js")), `${target} has no sibling .js`);
	}
	assert.ok(paths["@earendil-works/pi-ai"][0].endsWith("/dist/compat.d.ts"), "pi-ai types must come from compat, as Pi serves the root");
	assert.equal(
		packageVersion(path.join(piNodeModulesDir, "@earendil-works", "pi-coding-agent")),
		packageVersion(path.dirname(path.dirname(paths["@earendil-works/pi-coding-agent"][0]))),
		"the type gate and the runtime are different Pi versions",
	);
});

test("test harness: both tsconfigs extend the generated mapping", () => {
	// Without the extends the generator would be dead code and every Pi import
	// would resolve into a peer copy — the exact drift this replaced.
	for (const config of ["tsconfig.json", "extensions/memory/tsconfig.json"]) {
		const text = readFileSync(path.join(repoRoot, config), "utf-8");
		assert.match(text, /"extends":\s*"[^"]*tsconfig\.pi-types\.json"/, `${config} does not extend the generated Pi type paths`);
	}
});

test("test harness: jiti-style relative .js specifiers map to .ts inside the repo", () => {
	// Extension sources import "./implementation.js"; the hook resolves that to
	// the .ts file so bare `node --test` can load them.
	assert.ok(
		import.meta.resolve("../extensions/session-banner/implementation.js").endsWith("/implementation.ts"),
	);
});
