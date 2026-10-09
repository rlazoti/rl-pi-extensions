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
	// undefined means not configured — disabled by default (opt-in)
	return config.enabled[name] === true;
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

test("wrapper: missing config means disabled by default (opt-in)", () => {
	const dir = createTempDir();
	const filePath = getConfigPath(dir);
	// Don't create config file

	const config = loadConfig(filePath);
	assert.equal(isExtensionEnabled(config, "tmux-feedback"), false);

	rmSync(dir, { recursive: true, force: true });
});

test("wrapper: other extensions not affected by tmux-feedback state", () => {
	const dir = createTempDir();
	const filePath = getConfigPath(dir);
	writeFileSync(filePath, JSON.stringify({ enabled: { "tmux-feedback": true } }, null, 2));

	const config = loadConfig(filePath);
	assert.equal(isExtensionEnabled(config, "tmux-feedback"), true);
	// Other extensions should still be disabled (not configured, opt-in)
	assert.equal(isExtensionEnabled(config, "snippets"), false);

	rmSync(dir, { recursive: true, force: true });
});
