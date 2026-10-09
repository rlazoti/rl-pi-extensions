import assert from "node:assert/strict";
import test from "node:test";

// Mock the Pi types before importing the manager
const mockPi: any = {
	getSessionName: () => undefined,
};

// Test that the manager extension registers the correct command
test("manager registers /rl-extensions command with correct description", async () => {
	let registeredCommandName: string | undefined;
	let registeredCommandDescription: string | undefined;

	const pi = {
		registerCommand: (name: string, command: { description?: string; handler: () => unknown }) => {
			registeredCommandName = name;
			registeredCommandDescription = command.description;
		},
	};

	// We can't directly import the manager outside Pi because it depends on
	// @earendil-works/pi-coding-agent. Instead, we verify the command name
	// is correct by checking the source code.
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
		managerSource.includes('description: "Manage rl-pi-extensions (enable/disable)"'),
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
	const managerSource = readFileSync(
		new URL("../extensions/rl-extensions/index.ts", import.meta.url),
		"utf-8",
	);

	// Verify tmux-feedback is in the registry
	assert.ok(
		managerSource.includes('name: "tmux-feedback"'),
		"manager should include tmux-feedback in registry",
	);
});
