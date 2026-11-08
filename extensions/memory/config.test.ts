import { describe, it, expect, beforeEach, vi } from "vitest";
import { vol } from "memfs";
import * as os from "node:os";

import {
	loadConfig,
	saveConfig,
	shouldInject,
	DEFAULT_CONFIG,
	type InjectionConfig,
} from "./index.js";
import { CONFIG_PATH } from "./bank.js";
import { dayString } from "./calendar.js";

// ── shouldInject ─────────────────────────────────────────────────

// ── Memory bank location ───────────────────────────────────────

// index.ts resolves the bank root once, at import time, so this can only speak
// for the default; with PI_MEMORY_DIR set the override wins by design.
const dirOverride = process.env.PI_MEMORY_DIR;

it.skipIf(dirOverride !== undefined)("bank defaults to ~/.pi/memory3", () => {
	expect(CONFIG_PATH).toBe(`${os.homedir()}/.pi/memory3/config.json`);
});

// ── Calendar ───────────────────────────────────────────────────

describe("dayString", () => {
	it("matches the machine's own calendar across a whole local day", () => {
		// No offset in these strings, so Date parses them as local time.
		for (const iso of ["2026-10-27T00:00:00", "2026-10-27T07:30:00", "2026-10-27T19:01:00", "2026-10-27T23:59:59"]) {
			const d = new Date(iso);
			expect(dayString(d)).toBe(d.toLocaleDateString("en-CA"));
		}
	});

	// Only meaningful west of UTC, where the UTC date runs ahead of the local one
	// in the evening — which is what made the day roll over at 19:00 local.
	const westOfUTC = new Date().getTimezoneOffset() > 0;

	it.skipIf(!westOfUTC)("keeps an evening inside its own day, unlike the old UTC date", () => {
		const evening = new Date("2026-10-27T20:00:00");
		expect(dayString(evening)).toBe("2026-10-27");
		expect(evening.toISOString().slice(0, 10)).toBe("2026-10-28");
	});
});

describe("shouldInject", () => {
	it("returns true for every-turn regardless of injected state", () => {
		expect(shouldInject("every-turn", false)).toBe(true);
		expect(shouldInject("every-turn", true)).toBe(true);
	});

	it("returns true for first-turn when not yet injected", () => {
		expect(shouldInject("first-turn", false)).toBe(true);
	});

	it("returns false for first-turn when already injected", () => {
		expect(shouldInject("first-turn", true)).toBe(false);
	});

	it("returns false for off regardless of injected state", () => {
		expect(shouldInject("off", false)).toBe(false);
		expect(shouldInject("off", true)).toBe(false);
	});
});

// ── loadConfig / saveConfig ──────────────────────────────────────
// Mock node:fs so loadConfig/saveConfig use an in-memory filesystem.

vi.mock("node:fs", async () => {
	const memfs = await import("memfs");
	return { ...memfs.fs, default: memfs.fs };
});

describe("loadConfig", () => {
	beforeEach(() => vol.reset());

	it("returns defaults when config.json does not exist", () => {
		expect(loadConfig()).toEqual(DEFAULT_CONFIG);
	});

	it("DEFAULT_CONFIG matches original behavior (all every-turn)", () => {
		expect(DEFAULT_CONFIG).toEqual({
			activeProjects: "every-turn",
			dailyContext: "every-turn",
			knowledge: "every-turn",
			history: "every-turn",
		});
	});

	it("parses valid config from disk", () => {
		vol.fromJSON({ "config.json": JSON.stringify({
			injection: { activeProjects: "first-turn", dailyContext: "first-turn", knowledge: "every-turn", history: "off" },
		}) }, configDir());
		expect(loadConfig()).toEqual({
			activeProjects: "first-turn",
			dailyContext: "first-turn",
			knowledge: "every-turn",
			history: "off",
		});
	});

	it("falls back to defaults for invalid values", () => {
		vol.fromJSON({ "config.json": JSON.stringify({
			injection: { activeProjects: "invalid", knowledge: "first-turn" },
		}) }, configDir());
		const loaded = loadConfig();
		expect(loaded.activeProjects).toBe("every-turn"); // invalid → default
		expect(loaded.knowledge).toBe("first-turn"); // valid
		expect(loaded.dailyContext).toBe("every-turn"); // missing → default
		expect(loaded.history).toBe("every-turn"); // missing → default
	});

	it("handles corrupted JSON gracefully", () => {
		vol.fromJSON({ "config.json": "not json{{" }, configDir());
		expect(loadConfig()).toEqual(DEFAULT_CONFIG);
	});

	it("handles empty injection object", () => {
		vol.fromJSON({ "config.json": JSON.stringify({ injection: {} }) }, configDir());
		expect(loadConfig()).toEqual(DEFAULT_CONFIG);
	});

	it("handles missing injection key", () => {
		vol.fromJSON({ "config.json": JSON.stringify({ other: "data" }) }, configDir());
		expect(loadConfig()).toEqual(DEFAULT_CONFIG);
	});
});

describe("saveConfig", () => {
	beforeEach(() => vol.reset());

	it("writes config as JSON with injection key", () => {
		vol.mkdirSync(configDir(), { recursive: true });
		const config: InjectionConfig = {
			activeProjects: "first-turn",
			dailyContext: "first-turn",
			knowledge: "every-turn",
			history: "off",
		};
		saveConfig(config);
		const written = JSON.parse(vol.readFileSync(configDir() + "/config.json", "utf-8") as string);
		expect(written.injection).toEqual(config);
	});

	it("preserves other keys in config.json", () => {
		vol.fromJSON({ "config.json": JSON.stringify({ other: "data" }) }, configDir());
		saveConfig({ ...DEFAULT_CONFIG, history: "off" });
		const written = JSON.parse(vol.readFileSync(configDir() + "/config.json", "utf-8") as string);
		expect(written.other).toBe("data");
		expect(written.injection.history).toBe("off");
	});

	it("round-trips through loadConfig", () => {
		vol.mkdirSync(configDir(), { recursive: true });
		const custom: InjectionConfig = {
			activeProjects: "first-turn",
			dailyContext: "off",
			knowledge: "every-turn",
			history: "first-turn",
		};
		saveConfig(custom);
		expect(loadConfig()).toEqual(custom);
	});
});

/**
 * Helper: the directory CONFIG_PATH lives in.
 *
 * Derived from the extension's own CONFIG_PATH so this file can never drift
 * from the source's memory bank location.
 */
function configDir(): string {
	return CONFIG_PATH.replace(/\/config\.json$/, "");
}

// ── Injection behavior matrix ────────────────────────────────────

describe("injection behavior matrix", () => {
	// Simulate a multi-turn session by tracking injectedTypes state
	function simulateSession(config: InjectionConfig, turns: number) {
		const injectedTypes = {
			activeProjects: false,
			dailyContext: false,
			knowledge: false,
			history: false,
		};
		const keys = ["activeProjects", "dailyContext", "knowledge", "history"] as const;

		const results: Array<Record<string, boolean>> = [];

		for (let i = 0; i < turns; i++) {
			const turnResult: Record<string, boolean> = {};
			for (const key of keys) {
				const inject = shouldInject(config[key], injectedTypes[key]);
				turnResult[key] = inject;
				if (inject) injectedTypes[key] = true;
			}
			results.push(turnResult);
		}
		return results;
	}

	it("default config: all types injected every turn", () => {
		const results = simulateSession(DEFAULT_CONFIG, 3);
		for (const turn of results) {
			expect(turn.activeProjects).toBe(true);
			expect(turn.dailyContext).toBe(true);
			expect(turn.knowledge).toBe(true);
			expect(turn.history).toBe(true);
		}
	});

	it("all first-turn: only injected on turn 1", () => {
		const config: InjectionConfig = {
			activeProjects: "first-turn",
			dailyContext: "first-turn",
			knowledge: "first-turn",
			history: "first-turn",
		};
		const results = simulateSession(config, 3);

		// Turn 1: all true
		expect(results[0]).toEqual({
			activeProjects: true, dailyContext: true, knowledge: true, history: true,
		});
		// Turns 2-3: all false
		expect(results[1]).toEqual({
			activeProjects: false, dailyContext: false, knowledge: false, history: false,
		});
		expect(results[2]).toEqual({
			activeProjects: false, dailyContext: false, knowledge: false, history: false,
		});
	});

	it("mixed config: some every-turn, some first-turn, some off", () => {
		const config: InjectionConfig = {
			activeProjects: "first-turn",
			dailyContext: "first-turn",
			knowledge: "every-turn",
			history: "off",
		};
		const results = simulateSession(config, 3);

		// Turn 1
		expect(results[0]).toEqual({
			activeProjects: true, dailyContext: true, knowledge: true, history: false,
		});
		// Turn 2
		expect(results[1]).toEqual({
			activeProjects: false, dailyContext: false, knowledge: true, history: false,
		});
		// Turn 3
		expect(results[2]).toEqual({
			activeProjects: false, dailyContext: false, knowledge: true, history: false,
		});
	});

	it("all off: nothing injected", () => {
		const config: InjectionConfig = {
			activeProjects: "off",
			dailyContext: "off",
			knowledge: "off",
			history: "off",
		};
		const results = simulateSession(config, 3);
		for (const turn of results) {
			expect(turn.activeProjects).toBe(false);
			expect(turn.dailyContext).toBe(false);
			expect(turn.knowledge).toBe(false);
			expect(turn.history).toBe(false);
		}
	});

	it("compaction resets first-turn types", () => {
		const config: InjectionConfig = {
			activeProjects: "first-turn",
			dailyContext: "first-turn",
			knowledge: "every-turn",
			history: "off",
		};

		const injectedTypes = {
			activeProjects: false,
			dailyContext: false,
			knowledge: false,
			history: false,
		};
		const keys = ["activeProjects", "dailyContext", "knowledge", "history"] as const;

		// Turn 1
		for (const key of keys) {
			if (shouldInject(config[key], injectedTypes[key])) {
				injectedTypes[key] = true;
			}
		}
		expect(injectedTypes.activeProjects).toBe(true);
		expect(injectedTypes.dailyContext).toBe(true);

		// Turn 2: first-turn types skip
		expect(shouldInject(config.activeProjects, injectedTypes.activeProjects)).toBe(false);

		// Simulate compaction reset
		for (const key of keys) injectedTypes[key] = false;

		// Turn 3 (post-compaction): first-turn types re-inject
		expect(shouldInject(config.activeProjects, injectedTypes.activeProjects)).toBe(true);
		expect(shouldInject(config.dailyContext, injectedTypes.dailyContext)).toBe(true);
		expect(shouldInject(config.knowledge, injectedTypes.knowledge)).toBe(true);
		expect(shouldInject(config.history, injectedTypes.history)).toBe(false); // off stays off
	});
});
