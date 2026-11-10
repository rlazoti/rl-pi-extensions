// Hand-written types for scripts/require-memory-deps.mjs (see gen-ts-paths.d.mts
// for why the generator itself does not write declarations).
export declare const REQUIRED_TOOLS: string[];
export declare function missingMemoryTools(memoryDir: string, required?: string[]): string[];
export declare function formatMissingInstall(missing: string[]): string;
