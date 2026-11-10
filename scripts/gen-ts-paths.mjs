// Generate the TypeScript resolution for the Pi packages from the **installed
// Pi**, instead of pinning @earendil-works/* as a (dev)dependency.
//
// Why this exists: an exact pin in package.json is not inert. Pi uses pnpm on
// some machines, and `pnpm install --prod` resolves the *whole* graph —
// devDependencies included — before it prints "devDependencies: skipped". A
// registry mirror that has not synced the pinned Pi release therefore fails the
// install of an extension package with ERR_PNPM_NO_MATCHING_VERSION, over a
// package that is never linked and never loaded: Pi hands components its own
// modules at runtime (core/extensions/loader.js virtual modules). Removing the
// pins from the dependency graph is what makes "installs on any Pi" true.
//
// What replaces them: the type-check reads the declarations out of the same
// release the tests resolve against, so the type gate and the runtime cannot be
// different versions — the skew this script replaces could only be reported,
// never prevented.
//
// Entry rules mirror Pi's loader (dist/core/extensions/virtual-modules.js):
// the pi-ai ROOT is served as its compat entrypoint (a strict superset of the
// core entry — it exports the legacy `complete` global API), every other root
// is dist/index, and a subpath maps to dist/<subpath>.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findPiInstallNodeModulesDir, packageVersion } from "../test-support/hooks.mjs";

export const PI_SCOPE = "@earendil-works";
/** Alias scope Pi's loader answers for; sources occasionally import it. */
export const ALIAS_SCOPES = ["@mariozechner"];
/** Where the generated config lives, relative to the repo root. */
export const OUTPUT_RELATIVE = ".pi/tsconfig.pi-types.json";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Every `pi-*` package in an install that ships declarations for its root entry. */
export function listPiPackages(piNodeModulesDir) {
	const scopeDir = path.join(piNodeModulesDir, PI_SCOPE);
	if (!existsSync(scopeDir)) return [];
	return readdirSync(scopeDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-"))
		.map((entry) => entry.name)
		.filter((name) => existsSync(path.join(scopeDir, name, "dist", "index.d.ts")))
		.sort();
}

/** The declaration file a bare `@scope/<name>` import should read. */
export function rootDeclarationFor(piNodeModulesDir, name) {
	const dir = path.join(piNodeModulesDir, PI_SCOPE, name);
	const compat = path.join(dir, "dist", "compat.d.ts");
	// Only pi-ai is served through compat, matching Pi's loader exactly.
	if (name === "pi-ai" && existsSync(compat)) return compat;
	return path.join(dir, "dist", "index.d.ts");
}

/**
 * The subpaths a package actually declares, from its own `exports` map.
 *
 * This matters: TypeScript re-validates a `paths` target that lands inside a
 * package with `exports`, so a `dist/*` wildcard is rejected for pi-ai's
 * `./compat` even though the file is right there — which is how session-banner's
 * `import { complete } from "@earendil-works/pi-ai/compat"` came to type-check
 * against a hoisted copy and nobody noticed until that copy was deleted. Only a
 * package with no `exports` map gets the raw `dist/*` fallback.
 */
export function exportedDeclarationsFor(piNodeModulesDir, name) {
	const dir = path.join(piNodeModulesDir, PI_SCOPE, name);
	/** @type {Record<string, string>} subpath (".", "models", "providers/*") → declaration */
	const found = {};
	let exportsField = null;
	try {
		exportsField = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8")).exports ?? null;
	} catch {
		exportsField = null;
	}
	if (!exportsField || typeof exportsField !== "object") return null;
	for (const [key, value] of Object.entries(exportsField)) {
		const subpath = key === "." ? "." : key.replace(/^\.\//, "");
		// Honour the same condition order Node does for a `types`-aware resolver:
		// the declaration the package itself points at, never a guessed path.
		const target = pickTypesTarget(value);
		if (!target) continue;
		const declaration = target.replace(/\.js$/, ".d.ts");
		if (subpath.includes("*")) {
			// A wildcard export can name any file; check the directory it walks exists.
			if (existsSync(path.join(dir, declaration.split("*")[0]))) found[subpath] = declaration;
			continue;
		}
		if (existsSync(path.join(dir, declaration))) found[subpath] = declaration;
	}
	return found;
}

function pickTypesTarget(value) {
	if (typeof value === "string") return value.replace(/^\.\//, "");
	if (!value || typeof value !== "object") return null;
	for (const condition of ["types", "import", "require", "default"]) {
		const candidate = value[condition];
		if (typeof candidate === "string") return candidate.replace(/^\.\//, "");
	}
	return null;
}

/**
 * The `compilerOptions.paths` map for an install: root entries plus a `*`
 * wildcard per package for subpaths (`@earendil-works/pi-ai/models`), for both
 * the physical scope and Pi's alias scope. Targets are absolute so an
 * `extends`-ing config cannot resolve them differently by location.
 */
export function buildPiTypePaths(piNodeModulesDir) {
	/** @type {Record<string, string[]>} */
	const paths = {};
	/** @type {Record<string, string>} */
	const versions = {};
	for (const name of listPiPackages(piNodeModulesDir)) {
		const pkgDir = path.join(piNodeModulesDir, PI_SCOPE, name);
		versions[name] = packageVersion(pkgDir) ?? "unknown";
		const exported = exportedDeclarationsFor(piNodeModulesDir, name);
		for (const scope of [PI_SCOPE, ...ALIAS_SCOPES]) {
			paths[`${scope}/${name}`] = [rootDeclarationFor(piNodeModulesDir, name)];
			if (exported) {
				for (const [subpath, declaration] of Object.entries(exported)) {
					if (subpath === ".") continue;
					paths[`${scope}/${name}/${subpath}`] = [path.join(pkgDir, declaration)];
				}
			} else {
				// No exports map: nothing forbids pointing at dist/, so keep the wildcard.
				paths[`${scope}/${name}/*`] = [path.join(pkgDir, "dist", "*")];
			}
		}
	}
	return { paths, versions };
}

/** Config text written to OUTPUT_RELATIVE. Empty paths keep `extends` valid. */
export function renderTypePathsConfig(paths) {
	return `${JSON.stringify({ compilerOptions: { paths } }, null, "\t")}\n`;
}

function missingInstallMessage() {
	return (
		"[gen-ts-paths] no Pi install found — the type-check and the tests read Pi's\n" +
		"  declarations from the running Pi, so neither can resolve @earendil-works/*\n" +
		"  without one. Install Pi, or point PI_CODING_AGENT_DIR at\n" +
		"  <release>/node_modules/@earendil-works/pi-coding-agent.\n"
	);
}

/** Write the config. Returns the process exit code (1 = nothing to check against). */
export function main({
	argv = process.argv.slice(2),
	root = repoRoot,
	installDir = findPiInstallNodeModulesDir(),
} = {}) {
	const allowMissing = argv.includes("--allow-missing");
	const out = path.join(root, OUTPUT_RELATIVE);
	mkdirSync(path.dirname(out), { recursive: true });
	if (!installDir) {
		// A valid, empty config: `extends` must not be what fails, or the reader
		// sees "file not found" instead of the reason below.
		writeFileSync(out, renderTypePathsConfig({}), "utf-8");
		process.stderr.write(missingInstallMessage());
		return allowMissing ? 0 : 1;
	}
	const { paths, versions } = buildPiTypePaths(installDir);
	writeFileSync(out, renderTypePathsConfig(paths), "utf-8");
	const summary = Object.entries(versions)
		.map(([name, version]) => `${name}@${version}`)
		.join(" ");
	console.log(
		`[gen-ts-paths] ${Object.keys(versions).length} Pi type entries from ${installDir}\n[gen-ts-paths] ${summary}`,
	);
	return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	process.exitCode = main();
}
