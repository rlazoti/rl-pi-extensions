// Type surface for the resolve hook (hooks.mjs is plain JS — it runs inside
// Node's module loader before any type stripping happens, so it cannot itself
// be TypeScript). This file only exists so tests can import the helpers that
// the harness exposes for its own self-checks.
/**
 * Where the Pi packages live. Both parameters exist so a test can point the
 * finder at a fake filesystem instead of the machine running the suite.
 *
 * @param env defaults to `process.env`
 * @param homedir defaults to `os.homedir()`
 */
export declare function findPiInstallNodeModulesDir(
	env?: Record<string, string | undefined>,
	homedir?: string,
): string | null;
export declare function packageVersion(packageDir: string): string | null;
