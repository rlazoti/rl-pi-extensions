import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const PI_PACKAGE_RE = /^@(?:earendil-works|mariozechner)\/pi-[a-z0-9-]+(\/.*)?$/;

/**
 * Find the node_modules dir of a local Pi install (the packages Pi itself
 * runs), or null when Pi is not installed here. Override the layout with
 * PI_CODING_AGENT_DIR pointing at a .../@earendil-works/pi-coding-agent dir.
 *
 * Pi runs the release named in <install>/current-version, so the tests must run
 * against that one: a machine can hold several releases (Pi keeps the previous
 * one after an update for rollback), and reading a directory listing would test
 * a Pi the user is not running. Fall back to the highest release when that file
 * is missing or names a release no longer on disk, comparing releases
 * numerically — a lexicographic sort puts 1.5.2 above 1.5.10.
 */
export function findPiInstallNodeModulesDir() {
	const override = process.env.PI_CODING_AGENT_DIR;
	if (override) {
		if (!existsSync(override)) return null;
		return path.dirname(path.dirname(override));
	}
	const managedRoot = path.join(os.homedir(), ".pi", "agent", "install");
	const releases = path.join(managedRoot, "releases");
	if (!existsSync(releases)) return null;
	const present = readdirSync(releases).filter((entry) =>
		existsSync(path.join(releases, entry, "node_modules", "@earendil-works", "pi-coding-agent")),
	);
	const active = readCurrentVersion(path.join(managedRoot, "current-version"));
	if (active && present.includes(active)) return path.join(releases, active, "node_modules");
	const highest = [...present].sort(compareReleaseNames).reverse()[0];
	return highest ? path.join(releases, highest, "node_modules") : null;
}

function readCurrentVersion(file) {
	try {
		return readFileSync(file, "utf-8").trim() || null;
	} catch {
		return null;
	}
}

/** "1.5.10" > "1.5.2" > "1.5.1"; a missing segment sorts first, text compares as text. */
export function compareReleaseNames(a, b) {
	const left = String(a).split(".");
	const right = String(b).split(".");
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const l = left[i];
		const r = right[i];
		if (l === undefined) return -1;
		if (r === undefined) return 1;
		const ln = Number(l);
		const rn = Number(r);
		if (Number.isFinite(ln) && Number.isFinite(rn) && ln !== rn) return ln - rn;
		if (l !== r) return l < r ? -1 : 1;
	}
	return 0;
}

export function packageVersion(packageDir) {
	try {
		return JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf-8")).version;
	} catch {
		return null;
	}
}

const piNodeModulesDir = findPiInstallNodeModulesDir();

// The Pi packages are not dependencies of this repo in any form that gets
// installed: an exact pin in package.json is resolved by pnpm even under
// `--prod`, so a registry mirror that has not synced that release blocks
// installing this package over a copy it never links or loads. Pi serves its own
// modules to components at runtime (core/extensions/loader.js virtual modules)
// and `npm run typecheck` reads the declarations out of that same install
// (.pi/tsconfig.pi-types.json, scripts/gen-ts-paths.mjs), so the type gate and
// the runtime cannot be different versions — the skew this replaces could only
// ever be reported, never prevented.
//
// Consequence: with no Pi install there is nothing correct to resolve against.
// Say so plainly instead of failing with ERR_MODULE_NOT_FOUND on a specifier the
// reader can do nothing about.
function noPiInstallError(specifier) {
	return new Error(
		`[test-support] cannot resolve ${specifier}: no Pi install found.\n` +
			"  These tests run against the packages the running Pi loads, and this repo keeps no copy.\n" +
			"  Install Pi, or set PI_CODING_AGENT_DIR to <release>/node_modules/@earendil-works/pi-coding-agent.\n",
	);
}

export async function resolve(specifier, context, nextResolve) {
	// 1) Pi packages → the real packages from the local Pi install, mirroring
	//    what the extension loader does at runtime.
	//    @mariozechner/* is an alias scope that only exists inside Pi's own
	//    loader; map it to the physical @earendil-works scope.
	if (PI_PACKAGE_RE.test(specifier)) {
		if (!piNodeModulesDir) throw noPiInstallError(specifier);
		const parts = specifier.split("/");
		const name = parts[1];
		const subpath = parts.slice(2);
		const physicalScope = specifier.startsWith("@mariozechner") ? "@earendil-works" : parts[0];
		const candidate = path.join(piNodeModulesDir, physicalScope, name);
		// Mirror Pi's own extension loader (virtual-modules.js): the pi-ai ROOT
		// resolves to the compat entrypoint (a strict superset of the core entry —
		// it exports the legacy `complete` global API); subpaths map to
		// dist/<subpath>.js; everything else uses dist/index.js.
		let entryFile;
		if (name === "pi-ai" && subpath.length === 0) {
			entryFile = path.join(candidate, "dist", "compat.js");
		} else if (subpath.length > 0) {
			entryFile = path.join(candidate, "dist", ...subpath, "index.js");
			if (!existsSync(entryFile)) {
				entryFile = path.join(candidate, "dist", subpath.join("/") + ".js");
			}
		} else {
			entryFile = path.join(candidate, "dist", "index.js");
		}
		if (existsSync(candidate) && existsSync(entryFile)) {
			return nextResolve(pathToFileURL(entryFile).href, context);
		}
		// The install exists but does not ship that entry: that is a real answer
		// about that release, so let normal resolution report it rather than
		// inventing a path.
		return nextResolve(specifier, context);
	}

	// 2) Relative `.js` → `.ts` remap for files inside this repo.
	//    Only fires when the `.js` file does not exist but a `.ts` sibling
	//    does, so real JS packages are never touched.
	if (
		(specifier.startsWith("./") || specifier.startsWith("../")) &&
		specifier.endsWith(".js") &&
		context.parentURL &&
		context.parentURL.startsWith("file://")
	) {
		const parentPath = fileURLToPath(context.parentURL);
		if (parentPath.startsWith(repoRoot)) {
			const target = path.resolve(path.dirname(parentPath), specifier);
			const tsTarget = target.replace(/\.js$/, ".ts");
			if (!existsSync(target) && existsSync(tsTarget)) {
				return { url: pathToFileURL(tsTarget).href, shortCircuit: true };
			}
		}
	}

	return nextResolve(specifier, context);
}
