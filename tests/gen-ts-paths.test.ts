// Tests for scripts/gen-ts-paths.mjs — the thing that decides which Pi's
// declarations `npm run typecheck` reads. A wrong entry rule here is invisible
// until production hits an API the type gate never saw, so the mapping rules
// (compat root, subpath wildcard, alias scope) are pinned individually, and the
// fake-install fixtures let them be pinned without a second Pi release.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { findPiInstallNodeModulesDir } from "../test-support/hooks.mjs";
import {
	ALIAS_SCOPES,
	OUTPUT_RELATIVE,
	PI_SCOPE,
	buildPiTypePaths,
	listPiPackages,
	main,
	renderTypePathsConfig,
	rootDeclarationFor,
} from "../scripts/gen-ts-paths.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** A minimal Pi-shaped install: <dir>/@earendil-works/<name>/dist/{index.js,index.d.ts}. */
type FakePackage = [name: string, version: string, extra?: { index?: boolean; files?: string[]; exports?: Record<string, unknown> }];

function fakePiInstall(t: TestContext, packages: FakePackage[]) {
	const root = mkdtempSync(path.join(os.tmpdir(), "fake-pi-types-"));
	for (const [name, version, extra] of packages) {
		const dist = path.join(root, PI_SCOPE, name, "dist");
		mkdirSync(dist, { recursive: true });
		writeFileSync(
			path.join(root, PI_SCOPE, name, "package.json"),
			JSON.stringify({
				name: `${PI_SCOPE}/${name}`,
				version,
				type: "module",
				...(extra?.exports ? { exports: extra.exports } : {}),
			}),
		);
		if (extra?.index !== false) {
			writeFileSync(path.join(dist, "index.d.ts"), "export {};\n");
			writeFileSync(path.join(dist, "index.js"), "export {};\n");
		}
		for (const file of extra?.files ?? []) writeFileSync(path.join(dist, file), "export {};\n");
	}
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function tempRepo(t: TestContext) {
	const root = mkdtempSync(path.join(os.tmpdir(), "gen-paths-repo-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

test("gen-ts-paths: the live install yields an existing declaration for every mapped root", (t) => {
	const install = findPiInstallNodeModulesDir();
	if (!install) return t.skip("no local Pi install");
	const names = listPiPackages(install);
	for (const required of ["pi-coding-agent", "pi-tui", "pi-ai"]) {
		assert.ok(names.includes(required), `${required} is not mapped — typecheck would fail to resolve it`);
	}
	const { paths } = buildPiTypePaths(install);
	for (const [specifier, targets] of Object.entries(paths)) {
		if (specifier.endsWith("/*")) continue;
		for (const target of targets) {
			assert.ok(existsSync(target), `${specifier} → ${target} does not exist`);
		}
	}
});

test("gen-ts-paths: the pi-ai ROOT maps to compat.d.ts, as Pi's loader serves it", (t) => {
	const install = fakePiInstall(t, [["pi-ai", "9.9.9", { files: ["compat.d.ts"] }]]);
	const expected = path.join(install, PI_SCOPE, "pi-ai", "dist", "compat.d.ts");
	assert.equal(rootDeclarationFor(install, "pi-ai"), expected);
});

test("gen-ts-paths: pi-ai falls back to index.d.ts when the release ships no compat entry", (t) => {
	// Not hypothetical: the mapping must not invent a file, or tsc reports a
	// missing module for a package that is installed and working.
	const install = fakePiInstall(t, [["pi-ai", "9.9.9", {}]]);
	const expected = path.join(install, PI_SCOPE, "pi-ai", "dist", "index.d.ts");
	assert.equal(rootDeclarationFor(install, "pi-ai"), expected);
});

test("gen-ts-paths: other packages keep their own root entry even when compat exists", (t) => {
	const install = fakePiInstall(t, [["pi-tui", "9.9.9", { files: ["compat.d.ts"] }]]);
	const expected = path.join(install, PI_SCOPE, "pi-tui", "dist", "index.d.ts");
	assert.equal(rootDeclarationFor(install, "pi-tui"), expected);
});

test("gen-ts-paths: both scopes and subpath wildcards are mapped, with absolute targets", (t) => {
	const install = fakePiInstall(t, [
		["pi-coding-agent", "1.2.3", {}],
		["pi-ai", "1.2.3", { files: ["compat.d.ts"] }],
	]);
	const { paths, versions } = buildPiTypePaths(install);
	for (const scope of [PI_SCOPE, ...ALIAS_SCOPES]) {
		const root = paths[`${scope}/pi-coding-agent`];
		assert.ok(root, `${scope}/pi-coding-agent root missing`);
		assert.deepEqual(paths[`${scope}/pi-coding-agent/*`], [path.join(install, PI_SCOPE, "pi-coding-agent", "dist", "*")]);
		// The alias scope must point at the physical package, never a directory of
		// its own — there are no @mariozechner packages to serve.
		assert.ok(root[0].includes(`${PI_SCOPE}/pi-coding-agent`));
		assert.ok(path.isAbsolute(root[0]));
	}
	// @mariozechner/* is what tests/extension-loading.test.ts imports.
	assert.ok(paths["@mariozechner/pi-coding-agent"], "the alias scope Pi answers for is not mapped");
	assert.deepEqual(versions, { "pi-ai": "1.2.3", "pi-coding-agent": "1.2.3" });
});

test("gen-ts-paths: a package without root declarations is skipped, not mapped to a phantom", (t) => {
	const install = fakePiInstall(t, [
		["pi-schema", "9.9.9", { index: false }],
		["pi-tui", "9.9.9", {}],
	]);
	assert.deepEqual(listPiPackages(install), ["pi-tui"]);
	assert.equal(buildPiTypePaths(install).paths[`${PI_SCOPE}/pi-schema`], undefined);
});

test("gen-ts-paths: main writes the config where the tsconfigs extend it", (t) => {
	const install = fakePiInstall(t, [["pi-tui", "9.9.9", {}]]);
	const root = tempRepo(t);
	assert.equal(main({ argv: [], root, installDir: install }), 0);
	const written = JSON.parse(readFileSync(path.join(root, OUTPUT_RELATIVE), "utf-8"));
	assert.deepEqual(Object.keys(written), ["compilerOptions"]);
	assert.ok(written.compilerOptions.paths[`${PI_SCOPE}/pi-tui`]);
});

test("gen-ts-paths: no install leaves a valid empty config and fails loudly", (t) => {
	const root = tempRepo(t);
	const errors: string[] = [];
	t.mock.method(process.stderr, "write", (s: unknown) => errors.push(String(s)));
	assert.equal(main({ argv: [], root, installDir: null }), 1);
	const text = errors.join("");
	assert.match(text, /no Pi install found/);
	assert.match(text, /PI_CODING_AGENT_DIR/, "the fix must name the override, not just the failure");
	// `extends` of a missing file would mask the reason with ENOENT.
	const written = JSON.parse(readFileSync(path.join(root, OUTPUT_RELATIVE), "utf-8"));
	assert.deepEqual(written.compilerOptions.paths, {});
});

test("gen-ts-paths: --allow-missing keeps an install alive (postinstall must never break it)", (t) => {
	const root = tempRepo(t);
	t.mock.method(process.stderr, "write", () => true);
	assert.equal(main({ argv: ["--allow-missing"], root, installDir: null }), 0);
});

test("gen-ts-paths: subpaths come from the package's own exports map, not a guessed dist/*", (t) => {
	// TS re-validates a paths target that lands inside a package with `exports`, so
	// a dist/* wildcard is rejected for exactly the subpaths that matter
	// (pi-ai/compat, session-banner's import). Deriving from exports is what makes
	// the mapping hold on a machine with no hoisted copy to fall back on.
	const install = fakePiInstall(t, [
		[
			"pi-ai",
			"1.0.0",
			{
				files: ["compat.d.ts", "models.d.ts"],
				exports: {
					".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
					"./compat": { types: "./dist/compat.d.ts", import: "./dist/compat.js" },
					"./models": { types: "./dist/models.d.ts", import: "./dist/models.js" },
					"./ghost": { types: "./dist/ghost.d.ts", import: "./dist/ghost.js" },
				},
			},
		],
	]);
	const { paths } = buildPiTypePaths(install);
	assert.ok(paths[`${PI_SCOPE}/pi-ai/compat`][0].endsWith("/dist/compat.d.ts"));
	assert.ok(paths[`${PI_SCOPE}/pi-ai/models`][0].endsWith("/dist/models.d.ts"));
	assert.ok(paths["@mariozechner/pi-ai/compat"], "the alias scope must get the subpaths too");
	// An exports entry pointing at a file the release does not ship must not be
	// mapped: tsc would report a missing module for a package that works fine.
	assert.equal(paths[`${PI_SCOPE}/pi-ai/ghost`], undefined);
	// And no wildcard remains to shadow the real ones.
	assert.equal(paths[`${PI_SCOPE}/pi-ai/*`], undefined);
});

test("gen-ts-paths: renderTypePathsConfig emits JSON tsc accepts", () => {
	const text = renderTypePathsConfig({ "@earendil-works/pi-tui": ["/abs/index.d.ts"] });
	assert.deepEqual(JSON.parse(text).compilerOptions.paths["@earendil-works/pi-tui"], ["/abs/index.d.ts"]);
});

test("gen-ts-paths: a generated config in this checkout matches the live install", (t) => {
	const install = findPiInstallNodeModulesDir();
	if (!install) return t.skip("no local Pi install");
	const file = path.join(repoRoot, OUTPUT_RELATIVE);
	if (!existsSync(file)) return t.skip("not generated yet (npm run types:gen)");
	const onDisk = JSON.parse(readFileSync(file, "utf-8"));
	const fresh = buildPiTypePaths(install).paths;
	// Stale here means the type gate reads a different Pi than the tests run.
	assert.deepEqual(onDisk.compilerOptions.paths, fresh, "run: node scripts/gen-ts-paths.mjs");
});
