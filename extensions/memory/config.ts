/**
 * `~/.pi/memory/config.json` — the few numbers the spec leaves configurable.
 *
 * An invalid value never stops the extension: it falls back to its default and
 * the fallback is reported. A memory system that refuses to start has the same
 * effect as one that crashes on read (R30), and a typo in a JSON file is not a
 * reason to lose the turn.
 */

import { readFileSync } from "node:fs";

import type { BankPaths } from "./store.js";

export interface MemoryConfig {
	/** Hard ceiling on the injected block (R26). */
	budgetTokens: number;
	/** Section caps (R27). Unused core and daily budget flows to retrieval. */
	coreTokens: number;
	dailyTokens: number;
	/**
	 * R27.4: how many retrieved claims one turn may receive, whatever the token
	 * budget leaves room for. The budget alone does not bound the block: with a
	 * bank of dozens of claims, retrieval fills every token it is given, so the
	 * per-turn cost tracks the budget instead of the work in front of it.
	 * 0 means no cap.
	 */
	maxRetrievedClaims: number;
	/** A pending claim older than this is flagged and no longer injected (R20, R28). */
	pendingFlagDays: number;
	/** R19: ask about a rival proposal immediately instead of at review time. */
	inlineConflictDialog: boolean;
	/** Which ranker automatic recall uses (R32). */
	ranker: string;
	/** Default `memory_search` result count. */
	searchLimit: number;
}

/**
 * One row per setting: what it decides, its bounds, and what a boundary value
 * means. `applyConfig` validates against these same bounds, and
 * `/memory settings` renders them, so no listing can drift from the validator
 * (R48).
 */
export interface SettingInfo {
	key: keyof MemoryConfig;
	/** One line on what the number or name decides, with the requirement it serves. */
	meaning: string;
	/** Bounds for a whole number. Absent for the settings that are not numbers. */
	range?: { min: number; max: number };
	/** What a boundary value means, when the number alone would mislead. */
	boundary?: string;
}

export const SETTINGS: readonly SettingInfo[] = [
	{ key: "budgetTokens", range: { min: 200, max: 20_000 }, meaning: "the whole block one turn receives (R26)" },
	{ key: "coreTokens", range: { min: 0, max: 20_000 }, meaning: "always-on rules and facts (R27)" },
	{ key: "dailyTokens", range: { min: 0, max: 20_000 }, meaning: "open daily items (R27)" },
	{ key: "maxRetrievedClaims", range: { min: 0, max: 200 }, boundary: "0 means no cap", meaning: "claims one turn may recall, whatever the budget leaves (R27.4)" },
	{ key: "pendingFlagDays", range: { min: 1, max: 3650 }, meaning: "days a pending claim waits before it is flagged and stops injecting (R20)" },
	{ key: "searchLimit", range: { min: 1, max: 100 }, meaning: "hits memory_search returns when asked for none (R33)" },
	{ key: "inlineConflictDialog", meaning: "ask about a rival claim at the tool call instead of at review (R19)" },
	{ key: "ranker", meaning: "ranker for automatic recall; bm25 is the only one implemented (R32)" },
];

export const DEFAULT_CONFIG: MemoryConfig = {
	budgetTokens: 2000,
	coreTokens: 600,
	dailyTokens: 500,
	maxRetrievedClaims: 6,
	pendingFlagDays: 14,
	inlineConflictDialog: false,
	ranker: "bm25",
	searchLimit: 12,
};

const LIMITS: Record<string, { min: number; max: number }> = {};
for (const setting of SETTINGS) {
	if (setting.range) LIMITS[setting.key] = setting.range;
}

export interface ConfigResult {
	config: MemoryConfig;
	warnings: string[];
	/** Keys the file named itself. Anything not listed here is a default. */
	explicit: string[];
	/** Keys the file named but the section interlock adjusted (R27). */
	capped: string[];
}

/**
 * Read and validate the config. Anything unreadable or malformed is a warning
 * plus the default, never an exception.
 */
export function loadConfig(paths: BankPaths): ConfigResult {
	let text: string;
	try {
		text = readFileSync(paths.config, "utf8");
	} catch {
		return { config: { ...DEFAULT_CONFIG }, warnings: [], explicit: [], capped: [] };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return {
			config: { ...DEFAULT_CONFIG },
			warnings: [`${paths.config} is not valid JSON (${error instanceof Error ? error.message : String(error)}); every default is in use`],
			explicit: [],
			capped: [],
		};
	}
	return applyConfig(raw, paths.config);
}

export function applyConfig(raw: unknown, file: string): ConfigResult {
	const config: MemoryConfig = { ...DEFAULT_CONFIG };
	const warnings: string[] = [];
	const explicit: string[] = [];
	const capped: string[] = [];
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { config, warnings: [`${file} must hold a JSON object; every default is in use`], explicit, capped };
	}
	const source = raw as Record<string, unknown>;
	for (const [key, value] of Object.entries(source)) {
		if (!(key in DEFAULT_CONFIG)) {
			warnings.push(`${file}: unknown setting "${key}" — ignored`);
			continue;
		}
		if (key === "inlineConflictDialog") {
			if (typeof value === "boolean") {
				config.inlineConflictDialog = value;
				explicit.push(key);
			} else warnings.push(`${file}: inlineConflictDialog must be true or false — using ${DEFAULT_CONFIG.inlineConflictDialog}`);
			continue;
		}
		if (key === "ranker") {
			if (typeof value === "string" && value.trim() !== "") {
				config.ranker = value.trim();
				explicit.push(key);
			} else warnings.push(`${file}: ranker must be a name — using "${DEFAULT_CONFIG.ranker}"`);
			continue;
		}
		const limit = LIMITS[key]!;
		if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
			warnings.push(`${file}: ${key} must be a whole number — using ${DEFAULT_CONFIG[key as keyof MemoryConfig]}`);
			continue;
		}
		if (value < limit.min || value > limit.max) {
			warnings.push(`${file}: ${key}=${value} is outside ${limit.min}..${limit.max} — using ${DEFAULT_CONFIG[key as keyof MemoryConfig]}`);
			continue;
		}
		(config as unknown as Record<string, number>)[key] = value;
		explicit.push(key);
	}
	// A budget smaller than its own sections is a contradiction, not a preference.
	if (config.coreTokens + config.dailyTokens > config.budgetTokens) {
		warnings.push(
			`${file}: coreTokens (${config.coreTokens}) + dailyTokens (${config.dailyTokens}) exceed budgetTokens (${config.budgetTokens}) — the sections are capped to fit`,
		);
		const room = config.budgetTokens;
		const coreShare = Math.min(config.coreTokens, room);
		const dailyShare = Math.min(config.dailyTokens, room - coreShare);
		if (coreShare !== config.coreTokens) capped.push("coreTokens");
		if (dailyShare !== config.dailyTokens) capped.push("dailyTokens");
		config.coreTokens = coreShare;
		config.dailyTokens = dailyShare;
	}
	return { config, warnings, explicit, capped };
}

const NAME_WIDTH = Math.max(...SETTINGS.map((setting) => setting.key.length), "retrieved".length) + 1;

/**
 * `/memory settings`: every setting with the value in use, its default, the
 * range it must fall inside, and where the value came from — the file, a
 * default, or the section interlock. A number with no range beside it cannot be
 * reviewed: the reader has no way to know it is wrong (R48).
 *
 * When there is no file, the listing also carries a paste-ready template and
 * writes nothing: a key the file names is a choice, so a file naming every key
 * would pin every default against a later change (R49).
 */
export function describeSettings(result: ConfigResult, view: { file: string; present: boolean }): string {
	const row = (name: string, current: string, fallback: string, allowed: string, state: string, meaning: string) =>
		`${name.padEnd(NAME_WIDTH)}${current.padStart(9)}${fallback.padStart(9)}${allowed.padStart(12)}  ${state.padEnd(9)}${meaning}`;
	const stateOf = (key: string) => (result.capped.includes(key) ? "capped" : result.explicit.includes(key) ? "file" : "default");
	const value = (key: keyof MemoryConfig) => String(result.config[key]);
	const fallback = (key: keyof MemoryConfig) => String(DEFAULT_CONFIG[key]);
	const lines: string[] = [
		view.present
			? `config file: ${view.file}\nThis file is hand-editable: the next turn reads it, no restart.`
			: `config file: ${view.file} — not present, so every value below is a default`,
		"",
		row("setting", "current", "default", "allowed", "in use", "what it decides"),
	];
	for (const setting of SETTINGS) {
		const allowed = setting.range ? `${setting.range.min}..${setting.range.max}` : setting.key === "ranker" ? "a name" : "true|false";
		const meaning = setting.boundary ? `${setting.meaning}; ${setting.boundary}` : setting.meaning;
		lines.push(row(setting.key, value(setting.key), fallback(setting.key), allowed, stateOf(setting.key), meaning));
	}
	const retrieved = result.config.budgetTokens - result.config.coreTokens - result.config.dailyTokens;
	const defaultRetrieved = DEFAULT_CONFIG.budgetTokens - DEFAULT_CONFIG.coreTokens - DEFAULT_CONFIG.dailyTokens;
	lines.push(row("retrieved", String(retrieved), String(defaultRetrieved), "—", "derived", "what is left for recall after core and daily (R27)"));
	if (!view.present) {
		lines.push(
			"",
			"To change a value, create that file with only the keys you want — a key you leave out keeps its default.",
			"The next turn of a running session reads it, no restart. This listing writes nothing.",
			"",
			configTemplate(),
			"",
			"Writing every key works, and pins every default above as of today: a later change to a default will not reach you.",
		);
	}
	for (const warning of result.warnings) lines.push(`warning: ${warning}`);
	return lines.join("\n");
}

/**
 * A paste-ready `config.json`, built from the same table and defaults the
 * validator uses, so it cannot drift from what is accepted. It is printed, never
 * written (R49).
 */
export function configTemplate(): string {
	const body = SETTINGS.map((setting) => `  ${JSON.stringify(setting.key)}: ${JSON.stringify(DEFAULT_CONFIG[setting.key])}`).join(",\n");
	return `{\n${body}\n}`;
}

export function describeConfig(config: MemoryConfig): string {
	return `budget ${config.budgetTokens} tokens (core ${config.coreTokens}, daily ${config.dailyTokens}, retrieved ${config.budgetTokens - config.coreTokens - config.dailyTokens}), retrieved claims at most ${config.maxRetrievedClaims === 0 ? "unbounded" : config.maxRetrievedClaims} per turn, pending flag after ${config.pendingFlagDays} days, inline conflict dialog ${config.inlineConflictDialog ? "on" : "off"}, ranker ${config.ranker}`;
}
