import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Test that the manager extension registers the correct command
// Behavioral harness: drive the registered /rl-extensions handler with a fake
// picker result and capture what it tells the user.
async function applyMessagesFor(result: unknown): Promise<string[]> {
	const { default: managerExtension } = await import("../extensions/rl-extensions/index.ts");
	const messages: string[] = [];
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const pi = {
		registerCommand: (_name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			handler = definition.handler;
		},
	};
	managerExtension(pi as never);
	assert.ok(handler, "manager should register a command handler");
	const ui = {
		custom: async () => result,
		notify: (message: string) => messages.push(message),
	};
	await handler("", { ui });
	return messages;
}

test("manager notification says what changed, not how many are enabled", async () => {
	// Disabling one of five used to print "4 extension(s) enabled", which read
	// like four had just been enabled.
	const disabledOne = await applyMessagesFor({ kind: "apply", enabledCount: 4, changedCount: 1, errors: [] });
	assert.match(disabledOne[0] ?? "", /1 change\(s\) applied/);
	assert.doesNotMatch(disabledOne[0] ?? "", /^4 extension\(s\) enabled/);

	// Enter with nothing toggled used to print "5 extension(s) enabled".
	const untouched = await applyMessagesFor({ kind: "apply", enabledCount: 5, changedCount: 0, errors: [] });
	assert.match(untouched[0] ?? "", /No changes/);
	assert.doesNotMatch(untouched[0] ?? "", /^5 extension\(s\) enabled/);

	const disabledAll = await applyMessagesFor({ kind: "apply", enabledCount: 0, changedCount: 5, errors: [] });
	assert.match(disabledAll[0] ?? "", /All extensions disabled/);
});

test("manager surfaces per-extension apply failures", async () => {
	const messages = await applyMessagesFor({
		kind: "apply",
		enabledCount: 1,
		changedCount: 1,
		errors: ["snippets: /x/snippets exists and not a symlink"],
	});
	assert.ok(
		messages.some((message) => message.includes("snippets: /x/snippets exists and not a symlink")),
		"apply failures must reach the user",
	);
});

test("manager cancel reports nothing", async () => {
	const messages = await applyMessagesFor({ kind: "cancel" });
	assert.deepEqual(messages, []);
});

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

	// Verify the handler calls openExtensionPicker
	assert.ok(
		managerSource.includes("handler: async (_args, ctx) =>") &&
		managerSource.includes("openExtensionPicker(ctx.ui)"),
		"manager handler should call openExtensionPicker",
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
	assert.ok(
		symlinkManagerSource.includes('"emacs-feedback"'),
		"symlink-manager should include emacs-feedback in registry",
	);
});
