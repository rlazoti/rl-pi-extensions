// Type surface for the resolve hook (hooks.mjs is plain JS — it runs inside
// Node's module loader before any type stripping happens, so it cannot itself
// be TypeScript). This file only exists so tests can import the helpers that
// the harness exposes for its own self-checks.
export declare function findPiInstallNodeModulesDir(): string | null;
export declare function packageVersion(packageDir: string): string | null;
