import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";

// Test that all extension entry points have valid import paths
// This catches file naming errors before they hit production
// Note: Only rl-extensions is listed in package.json; other extensions
// are discovered via symlinks in ~/.pi/agent/extensions/
test("extensions: all entry points have valid import paths", async () => {
	const extensionsDir = join(process.cwd(), "extensions");
	const entries = readdirSync(extensionsDir);

	// Check each extension's index.ts and implementation files
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;

		const extDir = join(extensionsDir, entry);

		// Skip non-directories (e.g., symlink-manager.ts)
		if (!statSync(extDir).isDirectory()) continue;

		const indexPath = join(extDir, "index.ts");

		// Check index.ts exists
		assert.ok(readFileSync(indexPath, "utf-8"), `index.ts exists for ${entry}`);

		// Check for import statements and verify they reference existing files
		const indexContent = readFileSync(indexPath, "utf-8");
		const importMatches = indexContent.match(/from\s+["'](\.[^"']+)["']/g) || [];

		for (const importStmt of importMatches) {
			// Extract the path from the import statement
			const pathMatch = importStmt.match(/from\s+["'](\.[^"']+)["']/);
			if (!pathMatch) continue;

			const importPath = pathMatch[1];
			// Replace .js with .ts to get the actual file path
			const actualPath = importPath.replace(/\.js$/, ".ts");
			const resolvedPath = join(extDir, actualPath);

			// Check if file exists in the same directory or in the parent extensions/ directory
			const fileExists =
				existsSync(resolvedPath) ||
				existsSync(join(extensionsDir, actualPath));

			assert.ok(
				fileExists,
				`${entry}: ${importPath} resolves to existing file (${resolvedPath} or ${join(extensionsDir, actualPath)})`,
			);
		}
	}
});

test("extensions: all sources import from @earendil-works scope, not @mariozechner (M7)", () => {
	// Pi's loader aliases both scopes, but the repo standardizes on
	// @earendil-works so a future Pi that drops the alias fails loudly here.
	const scan = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			if (entry.startsWith(".")) continue;
			const full = join(dir, entry);
			const stat = statSync(full);
			if (stat.isDirectory()) {
				scan(full);
				continue;
			}
			if (!entry.endsWith(".ts")) continue;
			// Dead vitest files (still named *.test.ts on this branch) are
			// replaced by the test-wiring port; only production sources are bound.
			if (entry.includes(".test.")) continue;
			const source = readFileSync(full, "utf-8");
			assert.ok(
				!source.includes("@mariozechner/"),
				`${relative(process.cwd(), full)} must import from @earendil-works/*, not @mariozechner/*`,
			);
		}
	};
	scan(join(process.cwd(), "extensions"));
});

test("extensions: entry points type the ExtensionAPI parameter, not `pi: any` (M5)", () => {
	for (const entry of readdirSync(join(process.cwd(), "extensions"))) {
		const indexPath = join(process.cwd(), "extensions", entry, "index.ts");
		if (!existsSync(indexPath)) continue;
		const source = readFileSync(indexPath, "utf-8");
		assert.ok(
			!/pi:\s*any\b/.test(source),
			"extensions/" + entry + "/index.ts must not type the extension API as any",
		);
	}
});
