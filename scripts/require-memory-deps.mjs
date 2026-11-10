#!/usr/bin/env node
/**
 * Fail with instructions when memory's own test tools were never installed.
 *
 * `memory` keeps a private manifest (extensions/memory/package.json) so its
 * dev tools — vitest, its tsc — stay out of the root graph and out of Pi's
 * install, which uses `--omit=dev` and would otherwise fetch them for every
 * user of the package. The cost is that a fresh clone has them: `npm test` used
 * to reach `npm --prefix extensions/memory test` and die with
 * `sh: vitest: command not found`, which reads like a broken test suite rather
 * than a missing setup step. This names the step instead.
 *
 * It checks and says nothing more; it deliberately never installs anything,
 * because a test command that quietly reaches the network is its own trap.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_TOOLS = ["vitest", "tsc"];

/**
 * The tools missing from `node_modules/.bin` under `memoryDir`.
 *
 * `@earendil-works/*` is absent from that manifest on purpose — Pi provides
 * those, and a manifest that named one turned every install of the package into
 * a registry request for a specific Pi release.
 */
export function missingMemoryTools(memoryDir, required = REQUIRED_TOOLS) {
	const binDir = path.join(memoryDir, "node_modules", ".bin");
	return required.filter((tool) => !existsSync(path.join(binDir, tool)));
}

export function formatMissingInstall(missing) {
	return [
		`memory's test tools are not installed (missing: ${missing.join(", ")}).`,
		"They are kept in extensions/memory/package.json so Pi never installs them.",
		"Run: npm run setup:memory",
	].join(" ");
}

async function main(argv) {
	const root = fileURLToPath(new URL("..", import.meta.url));
	const missing = missingMemoryTools(path.join(root, "extensions", "memory"));
	if (missing.length === 0) return 0;
	console.error(formatMissingInstall(missing));
	return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main(process.argv.slice(2));
}
