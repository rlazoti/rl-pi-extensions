import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const PI_PACKAGE_RE = /^@(?:earendil-works|mariozechner)\/pi-[a-z0-9-]+(\/.*)?$/;
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** Does this directory hold the Pi packages (that is, is it a node_modules)? */
function isPiNodeModules(dir) {
	return existsSync(path.join(dir, "@earendil-works", "pi-coding-agent"));
}

/**
 * The node_modules directory behind any path that points into a Pi install: a
 * node_modules itself, the pi-coding-agent package directory, or any directory
 * that contains one (a release dir, a checkout, a vendored tree).
 */
function nodeModulesFor(dir) {
	if (!dir) return null;
	const abs = path.resolve(dir);
	if (isPiNodeModules(abs)) return abs;
	const nested = path.join(abs, "node_modules");
	if (isPiNodeModules(nested)) return nested;
	// .../<node_modules>/@earendil-works/pi-coding-agent[/...]
	const marker = `${path.sep}@earendil-works${path.sep}pi-coding-agent`;
	const at = abs.lastIndexOf(marker);
	if (at >= 0) {
		const candidate = abs.slice(0, at);
		if (isPiNodeModules(candidate)) return candidate;
	}
	return null;
}

/**
 * Find the node_modules dir of a local Pi install (the packages Pi itself
 * runs), or null when Pi is not installed here.
 *
 * The order is the order of trust, because "the Pi on this machine" is not one
 * question when a machine holds several installs:
 *  1. `PI_CODING_AGENT_DIR` — an explicit `.../@earendil-works/pi-coding-agent`.
 *  2. `PI_PACKAGE_DIR` — an explicit directory in any of the shapes above, for a
 *     Pi built from source or vendored outside the managed install.
 *  3. `$PI_MANAGED_INSTALL_ROOT` (else `~/.pi/agent/install`), and inside it the
 *     release named by `current-version` — the same file the `pi` launcher reads,
 *     so the tests resolve what `pi` runs and not the newest directory lying
 *     around.
 *  4. `~/.pi/pkg/pi-<version>`, newest first, for a packaged install.
 *  5. the managed releases directory, newest first, when there is no
 *     `current-version` to read.
 *
 * An override that points at nothing is reported, not ignored silently: a test
 * run that quietly falls back to this repo's pinned copy is a test run against
 * the wrong version.
 */
export function findPiInstallNodeModulesDir(env = process.env, homedir = os.homedir()) {
	const notes = [];
	const found = pickPiInstall(env, homedir, notes);
	if (notes.length > 0) process.stderr.write(`[test-support] ${notes.join("; ")}\n`);
	return found;
}

function pickPiInstall(env, homedir, notes) {
	const named = [
		["PI_CODING_AGENT_DIR", env.PI_CODING_AGENT_DIR],
		["PI_PACKAGE_DIR", env.PI_PACKAGE_DIR],
	];
	for (const [name, value] of named) {
		if (!value) continue;
		const found = nodeModulesFor(value);
		if (found) return found;
		notes.push(`${name} is set to ${value}, which holds no ${PI_PACKAGE_NAME}`);
	}

	const managedRoot = env.PI_MANAGED_INSTALL_ROOT || path.join(homedir, ".pi", "agent", "install");
	const current = currentVersionOf(managedRoot);
	if (current) {
		const found = nodeModulesFor(path.join(managedRoot, "releases", current));
		if (found) return found;
		notes.push(`${managedRoot}/current-version says ${current}, which is not installed`);
	}

	for (const dir of newestFirst(path.join(homedir, ".pi", "pkg"), /^pi-(\d.*)$/)) {
		const found = nodeModulesFor(dir);
		if (found) return found;
	}
	for (const dir of newestFirst(path.join(managedRoot, "releases"), /^(\d.*)$/)) {
		const found = nodeModulesFor(dir);
		if (found) return found;
	}
	if (notes.length > 0) notes.push("falling back to this repo's node_modules, so the suite tests that version and not the running Pi");
	return null;
}

/** The version the `pi` launcher runs, or null when this is not a managed install. */
function currentVersionOf(managedRoot) {
	try {
		return readFileSync(path.join(managedRoot, "current-version"), "utf8").trim() || null;
	} catch {
		return null;
	}
}

/** Subdirectories of `dir` matching `pattern`, highest version first, as paths. */
function newestFirst(dir, pattern) {
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((name) => pattern.test(name) && statSync(path.join(dir, name), { throwIfNoEntry: false })?.isDirectory())
		.sort((a, b) => {
			const byNumber = compareVersions(matchOf(b, pattern), matchOf(a, pattern));
			return byNumber !== 0 ? byNumber : matchOf(b, pattern).localeCompare(matchOf(a, pattern));
		})
		.map((name) => path.join(dir, name));
}

function matchOf(name, pattern) {
	return name.match(pattern)[1];
}

function compareVersions(a, b) {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const delta = (left[index] ?? 0) - (right[index] ?? 0);
		if (delta !== 0) return delta;
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

// The Pi packages are also declared as peer dependencies, so `npm install`
// drops a copy in this repo's node_modules — that copy exists so
// `npm run typecheck` can resolve types, and tests must NOT silently use it
// instead of the Pi install (it lags whenever Pi upgrades). When both exist at
// different versions, say so once: the runtime is the Pi install, the types
// are the pinned copy, and the gap is a bug in this repo's pins, not in the
// code under test.
let skewReported = false;
function reportSkew(runtimeDir, specifier, runtimeVersion, typesVersion) {
	if (skewReported || !runtimeVersion || !typesVersion || runtimeVersion === typesVersion) return;
	skewReported = true;
	process.stderr.write(
		`[test-support] @earendil-works/* resolve to the Pi install (${runtimeVersion} at ${runtimeDir}); ` +
			`this repo's node_modules has ${typesVersion} — bump package.json so the type-check matches the runtime\n`,
	);
}

export async function resolve(specifier, context, nextResolve) {
	// 1) Pi packages → the real packages from the local Pi install, mirroring
	//    what the extension loader does at runtime.
	//    @mariozechner/* is an alias scope that only exists inside Pi's own
	//    loader; map it to the physical @earendil-works scope.
	if (PI_PACKAGE_RE.test(specifier)) {
		if (piNodeModulesDir) {
			const parts = specifier.split("/");
			const name = parts[1];
			const subpath = parts.slice(2);
			const physicalScope = specifier.startsWith("@mariozechner")
				? "@earendil-works"
				: parts[0];
			const candidate = path.join(piNodeModulesDir, physicalScope, name);
			// Mirror Pi's own extension loader (virtual-modules.js): the pi-ai
			// ROOT resolves to the compat entrypoint (a strict superset of the
			// core entry — it exports the legacy `complete` global API); subpaths
			// map to dist/<subpath>.js; everything else uses dist/index.js.
			let entryFile;
			if (name === "pi-ai" && subpath.length === 0) {
				entryFile = path.join(candidate, "dist", "compat.js");
			} else if (name === "pi-ai") {
				entryFile = path.join(candidate, "dist", ...subpath, "index.js");
				if (!existsSync(entryFile)) {
					entryFile = path.join(candidate, "dist", subpath.join("/") + ".js");
				}
			} else {
				entryFile = path.join(candidate, "dist", "index.js");
			}
			if (existsSync(candidate) && existsSync(entryFile)) {
				const localCopy = path.join(repoRoot, "node_modules", "@earendil-works", name);
				reportSkew(
					piNodeModulesDir,
					specifier,
					packageVersion(candidate),
					existsSync(localCopy) ? packageVersion(localCopy) : null,
				);
				return nextResolve(pathToFileURL(entryFile).href, context);
			}
		}
		// No Pi install (or an entry it does not ship): fall back to the copy
		// installed in this repo, so the suite still runs without Pi.
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
