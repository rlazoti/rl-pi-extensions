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
 * The highest installed version wins, matching how Pi picks a release.
 */
export function findPiInstallNodeModulesDir() {
	const override = process.env.PI_CODING_AGENT_DIR;
	if (override) {
		if (!existsSync(override)) return null;
		return path.dirname(path.dirname(override));
	}
	const releases = path.join(os.homedir(), ".pi", "agent", "install", "releases");
	if (!existsSync(releases)) return null;
	for (const version of readdirSync(releases).sort().reverse()) {
		const candidate = path.join(
			releases,
			version,
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
		);
		if (existsSync(candidate)) return path.join(releases, version, "node_modules");
	}
	return null;
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
