import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Sources are loaded through jiti by Pi, which strips types without
		// checking them; vitest does the same, so this runs the real files.
		include: ["*.test.ts"],
		environment: "node",
		// bank.ts binds its paths at import, so the temp bank has to exist before
		// any test file is evaluated. setupFiles run first in each worker.
		setupFiles: ["./vitest.isolate-bank.ts"],
		// Isolate HOME/default-bank use (including subprocesses) and detect persistent
		// changes to original banks. Detection cannot prevent arbitrary absolute writes.
		globalSetup: ["./vitest.bank-guard.ts"],
		// config.test.ts replaces node:fs with a memfs volume; search.test.ts
		// reads real temp directories. Separate fork processes keep the two
		// filesystems from sharing a module registry.
		pool: "forks",
		testTimeout: 30_000,
	},
});
