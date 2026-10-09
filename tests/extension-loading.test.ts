import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";

// Test that all extension entry points have valid import paths
// This catches file naming errors before they hit production
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
