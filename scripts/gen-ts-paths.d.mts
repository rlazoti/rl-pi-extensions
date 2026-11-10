// Type surface for the Pi type-paths generator (gen-ts-paths.mjs is plain JS so
// that npm's postinstall and the test bootstrap can run it without a build step).
// Mirrors test-support/hooks.d.mts: this exists only so tests and the type gate
// can read the helpers.
export declare const PI_SCOPE: string;
export declare const ALIAS_SCOPES: string[];
export declare const OUTPUT_RELATIVE: string;

export declare function listPiPackages(piNodeModulesDir: string): string[];
export declare function rootDeclarationFor(piNodeModulesDir: string, name: string): string;
export declare function exportedDeclarationsFor(
	piNodeModulesDir: string,
	name: string,
): Record<string, string> | null;
export declare function buildPiTypePaths(piNodeModulesDir: string): {
	paths: Record<string, string[]>;
	versions: Record<string, string>;
};
export declare function renderTypePathsConfig(paths: Record<string, string[]>): string;
export declare function main(options?: {
	argv?: string[];
	root?: string;
	installDir?: string | null;
}): number;
