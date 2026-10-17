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
	/** A pending claim older than this is flagged and no longer injected (R20, R28). */
	pendingFlagDays: number;
	/** R19: ask about a rival proposal immediately instead of at review time. */
	inlineConflictDialog: boolean;
	/** Which ranker automatic recall uses (R32). */
	ranker: string;
	/** Default `memory_search` result count. */
	searchLimit: number;
}

export const DEFAULT_CONFIG: MemoryConfig = {
	budgetTokens: 2000,
	coreTokens: 600,
	dailyTokens: 500,
	pendingFlagDays: 14,
	inlineConflictDialog: false,
	ranker: "bm25",
	searchLimit: 12,
};

const LIMITS: Record<string, { min: number; max: number }> = {
	budgetTokens: { min: 200, max: 20_000 },
	coreTokens: { min: 0, max: 20_000 },
	dailyTokens: { min: 0, max: 20_000 },
	pendingFlagDays: { min: 1, max: 3650 },
	searchLimit: { min: 1, max: 100 },
};

export interface ConfigResult {
	config: MemoryConfig;
	warnings: string[];
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
		return { config: { ...DEFAULT_CONFIG }, warnings: [] };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return {
			config: { ...DEFAULT_CONFIG },
			warnings: [`${paths.config} is not valid JSON (${error instanceof Error ? error.message : String(error)}); every default is in use`],
		};
	}
	return applyConfig(raw, paths.config);
}

export function applyConfig(raw: unknown, file: string): ConfigResult {
	const config: MemoryConfig = { ...DEFAULT_CONFIG };
	const warnings: string[] = [];
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { config, warnings: [`${file} must hold a JSON object; every default is in use`] };
	}
	const source = raw as Record<string, unknown>;
	for (const [key, value] of Object.entries(source)) {
		if (!(key in DEFAULT_CONFIG)) {
			warnings.push(`${file}: unknown setting "${key}" — ignored`);
			continue;
		}
		if (key === "inlineConflictDialog") {
			if (typeof value === "boolean") config.inlineConflictDialog = value;
			else warnings.push(`${file}: inlineConflictDialog must be true or false — using ${DEFAULT_CONFIG.inlineConflictDialog}`);
			continue;
		}
		if (key === "ranker") {
			if (typeof value === "string" && value.trim() !== "") config.ranker = value.trim();
			else warnings.push(`${file}: ranker must be a name — using "${DEFAULT_CONFIG.ranker}"`);
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
	}
	// A budget smaller than its own sections is a contradiction, not a preference.
	if (config.coreTokens + config.dailyTokens > config.budgetTokens) {
		warnings.push(
			`${file}: coreTokens (${config.coreTokens}) + dailyTokens (${config.dailyTokens}) exceed budgetTokens (${config.budgetTokens}) — the sections are capped to fit`,
		);
		const room = config.budgetTokens;
		const coreShare = Math.min(config.coreTokens, room);
		config.coreTokens = coreShare;
		config.dailyTokens = Math.min(config.dailyTokens, room - coreShare);
	}
	return { config, warnings };
}

export function describeConfig(config: MemoryConfig): string {
	return `budget ${config.budgetTokens} tokens (core ${config.coreTokens}, daily ${config.dailyTokens}, retrieved ${config.budgetTokens - config.coreTokens - config.dailyTokens}), pending flag after ${config.pendingFlagDays} days, inline conflict dialog ${config.inlineConflictDialog ? "on" : "off"}, ranker ${config.ranker}`;
}
