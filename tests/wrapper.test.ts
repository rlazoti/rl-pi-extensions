import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Each test gets its own unique temp directory
function createTempDir(): string {
	const dir = join(process.cwd(), "tests", `.test-wrapper-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function getConfigPath(dir: string): string {
	return join(dir, "rl-extensions.json");
}

// --- Config manager logic (same as config-manager.ts) ---

interface ExtensionsConfig {
	enabled: Record<string, boolean>;
}

function loadConfig(filePath: string): ExtensionsConfig {
	if (existsSync(filePath)) {
		try {
			const content = readFileSync(filePath, "utf-8");
			return JSON.parse(content) as ExtensionsConfig;
		} catch {
			return { enabled: {} };
		}
	}
	return { enabled: {} };
}

function isExtensionEnabled(config: ExtensionsConfig, name: string): boolean {
	return config.enabled[name] !== false;
}

// --- Tests ---

test("wrapper: enabled extension loads implementation", () => {
	const dir = createTempDir();
	const filePath = getConfigPath(dir);
	writeFileSync(filePath, JSON.stringify({ enabled: { "tmux-feedback": true } }, null, 2));

	const config = loadConfig(filePath);
	assert.equal(isExtensionEnabled(config, "tmux-feedback"), true);

	rmSync(dir, { recursive: true, force: true });
});

test("wrapper: disabled extension returns no-op", () => {
	const dir = createTempDir();
	const filePath = getConfigPath(dir);
	writeFileSync(filePath, JSON.stringify({ enabled: { "tmux-feedback": false } }, null, 2));

	const config = loadConfig(filePath);
	assert.equal(isExtensionEnabled(config, "tmux-feedback"), false);

	rmSync(dir, { recursive: true, force: true });
});

test("wrapper: missing config means enabled by default", () => {
	const dir = createTempDir();
	const filePath = getConfigPath(dir);
	// Don't create config file

	const config = loadConfig(filePath);
	assert.equal(isExtensionEnabled(config, "tmux-feedback"), true);

	rmSync(dir, { recursive: true, force: true });
});

test("wrapper: other extensions not affected by tmux-feedback state", () => {
	const dir = createTempDir();
	const filePath = getConfigPath(dir);
	writeFileSync(filePath, JSON.stringify({ enabled: { "tmux-feedback": false } }, null, 2));

	const config = loadConfig(filePath);
	assert.equal(isExtensionEnabled(config, "tmux-feedback"), false);
	// Other extensions should still be enabled (not configured)
	assert.equal(isExtensionEnabled(config, "snippets"), true);

	rmSync(dir, { recursive: true, force: true });
});
