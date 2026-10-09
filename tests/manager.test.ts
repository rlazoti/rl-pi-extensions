import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Test that the manager extension registers the correct command
test("manager registers /rl-extensions command with correct description", async () => {
	const { readFileSync } = await import("node:fs");
	const managerSource = readFileSync(
		new URL("../extensions/rl-extensions/index.ts", import.meta.url),
		"utf-8",
	);

	// Verify the command name is registered correctly
	assert.ok(
		managerSource.includes('registerCommand("rl-extensions"'),
		"manager should register /rl-extensions command",
	);
	assert.ok(
		managerSource.includes('description: "Manage rl-pi-extensions (enable/disable via symlinks)"'),
		"manager should have correct description",
	);
});

test("manager command handler is registered", async () => {
	const { readFileSync } = await import("node:fs");
	const managerSource = readFileSync(
		new URL("../extensions/rl-extensions/index.ts", import.meta.url),
		"utf-8",
	);

	// Verify the handler calls showExtensionManager
	assert.ok(
		managerSource.includes("handler: async (_args, ctx) =>") &&
		managerSource.includes("await showExtensionManager(ctx)"),
		"manager handler should call showExtensionManager",
	);
});

test("manager includes all registered extensions in registry", async () => {
	const { readFileSync } = await import("node:fs");
	const symlinkManagerSource = readFileSync(
		new URL("../extensions/symlink-manager.ts", import.meta.url),
		"utf-8",
	);

	// Verify tmux-feedback is in the registry
	assert.ok(
		symlinkManagerSource.includes('"tmux-feedback"'),
		"symlink-manager should include tmux-feedback in registry",
	);
	assert.ok(
		symlinkManagerSource.includes('"session-banner"'),
		"symlink-manager should include session-banner in registry",
	);
});
