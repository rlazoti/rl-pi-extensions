import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Each test gets its own unique temp directory
function createTempDir(): string {
	const dir = join(process.cwd(), "tests", `.test-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function getConfigPath(dir: string): string {
	return join(dir, "rl-extensions.json");
}

// --- Config manager logic (same as config-manager.ts but self-contained for testing) ---

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

function saveConfig(filePath: string, config: ExtensionsConfig): void {
	writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}

function isExtensionEnabled(config: ExtensionsConfig, name: string): boolean {
	// undefined means not configured — disabled by default (opt-in)
	return config.enabled[name] === true;
}

// --- Tests ---

test("loadConfig returns empty config when file does not exist", () => {
	const dir = createTempDir();
	const filePath = getConfigPath(dir);
	const config = loadConfig(filePath);
	assert.deepEqual(config, { enabled: {} });
	rmSync(dir, { recursive: true, force: true });
});

test("loadConfig parses valid JSON config", () => {
	const dir = createTempDir();
	const filePath = getConfigPath(dir);
	writeFileSync(filePath, JSON.stringify({ enabled: { "tmux-feedback": true } }, null, 2));
	const config = loadConfig(filePath);
	assert.deepEqual(config, { enabled: { "tmux-feedback": true } });
	rmSync(dir, { recursive: true, force: true });
});

test("loadConfig returns empty config on invalid JSON", () => {
	const dir = createTempDir();
	const filePath = getConfigPath(dir);
	writeFileSync(filePath, "{ invalid json }");
	const config = loadConfig(filePath);
	assert.deepEqual(config, { enabled: {} });
	rmSync(dir, { recursive: true, force: true });
});

test("saveConfig writes and reloads correctly", () => {
	const dir = createTempDir();
	const filePath = getConfigPath(dir);
	const config = { enabled: { "tmux-feedback": false, "snippets": true } };
	saveConfig(filePath, config);
	const loaded = loadConfig(filePath);
	assert.deepEqual(loaded, config);
	rmSync(dir, { recursive: true, force: true });
});

test("isExtensionEnabled returns false when not configured (opt-in by default)", () => {
	const config = { enabled: {} };
	assert.equal(isExtensionEnabled(config, "tmux-feedback"), false);
});

test("isExtensionEnabled returns true when explicitly enabled", () => {
	const config = { enabled: { "tmux-feedback": true } };
	assert.equal(isExtensionEnabled(config, "tmux-feedback"), true);
});

test("isExtensionEnabled returns false when explicitly disabled", () => {
	const config = { enabled: { "tmux-feedback": false } };
	assert.equal(isExtensionEnabled(config, "tmux-feedback"), false);
});

test("isExtensionEnabled only checks the specified extension", () => {
	const config = { enabled: { "tmux-feedback": false, "snippets": true } };
	assert.equal(isExtensionEnabled(config, "tmux-feedback"), false);
	assert.equal(isExtensionEnabled(config, "snippets"), true);
	assert.equal(isExtensionEnabled(config, "retitle"), false); // not configured = disabled
});

test("toggle: enable then disable extension", () => {
	const dir = createTempDir();
	const filePath = getConfigPath(dir);

	// Start: disabled (default, opt-in)
	let config = loadConfig(filePath);
	assert.equal(isExtensionEnabled(config, "tmux-feedback"), false);

	// Enable
	config = { ...config, enabled: { ...config.enabled, "tmux-feedback": true } };
	saveConfig(filePath, config);

	config = loadConfig(filePath);
	assert.equal(isExtensionEnabled(config, "tmux-feedback"), true);

	// Disable
	config = { ...config, enabled: { ...config.enabled, "tmux-feedback": false } };
	saveConfig(filePath, config);

	config = loadConfig(filePath);
	assert.equal(isExtensionEnabled(config, "tmux-feedback"), false);

	rmSync(dir, { recursive: true, force: true });
});
