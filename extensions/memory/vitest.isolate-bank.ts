/**
 * Loaded by vitest as `setupFiles`, so it runs in each test file's process
 * before that file's module (and therefore before any of its imports) is
 * evaluated. Its only job: make the default bank a temp directory.
 *
 * Without it, any test file that statically imports something reaching
 * bank.ts — directly, or through index.ts — evaluates bank.ts with no
 * PI_MEMORY_DIR and bakes the operator's real bank into MEMORY_ROOT. The
 * module registry caches it, so a later `process.env.PI_MEMORY_DIR = tmp`
 * plus dynamic import does not help: the constants are already set. On
 * 2026-11-08 a handler suite did exactly that and wrote its fixtures into
 * ~/.pi/memory3. globalSetup now isolates HOME as well, and checks original
 * banks for persistent additions, overwrites and deletions at teardown.
 * bank.ts also refuses an unset PI_MEMORY_DIR under VITEST.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
fs.mkdirSync(path.join(dir, "core"), { recursive: true });
fs.mkdirSync(path.join(dir, "knowledge"), { recursive: true });
process.env.PI_MEMORY_DIR = dir;
process.env.PI_MEMORY_TEST_DIR = dir;

if (process.env.PI_MEMORY_TEST_KEEP !== "1") {
	process.on("exit", () => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* the temp dir outlives us; the OS eventually reclaims it */
		}
	});
}
