import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const PI_PACKAGE_RE = /^@(?:earendil-works|mariozechner)\/pi-[a-z0-9-]+$/;

// Find the @earendil-works/pi-coding-agent package dir inside a local Pi
// install. Override with PI_CODING_AGENT_DIR for non-default layouts.
function findPiCodingAgentDir() {
	const override = process.env.PI_CODING_AGENT_DIR;
	if (override) {
		return existsSync(override) ? override : null;
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
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

const piCodingAgentDir = findPiCodingAgentDir();
// piCodingAgentDir is <node_modules>/<scope>/<package>; two dirname() calls
// get us the node_modules dir we join new package paths against.
const piNodeModulesDir = piCodingAgentDir
	? path.dirname(path.dirname(piCodingAgentDir))
	: null;

export async function resolve(specifier, context, nextResolve) {
	// 1) Pi packages → the real packages from the local Pi install.
	//    @mariozechner/* is an alias scope that only exists inside Pi's own
	//    loader; map it to the physical @earendil-works scope.
	if (PI_PACKAGE_RE.test(specifier)) {
		let result;
		try {
			// Normal resolution first (works if the package is installed here).
			return await nextResolve(specifier, context);
		} catch (error) {
			result = error;
		}
		if (piNodeModulesDir) {
			const name = specifier.split("/")[1];
			const physicalScope = specifier.startsWith("@mariozechner")
				? "@earendil-works"
				: specifier.split("/")[0];
			const candidate = path.join(piNodeModulesDir, physicalScope, name);
			if (existsSync(candidate) && existsSync(path.join(candidate, "dist", "index.js"))) {
				const entry = pathToFileURL(path.join(candidate, "dist", "index.js")).href;
				return nextResolve(entry, context);
			}
		}
		throw result;
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
