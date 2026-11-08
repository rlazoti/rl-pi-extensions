/** Validated optional policies. Defaults do not silently enable experimental tuning. */
import { DEFAULT_RETRIEVAL, type RetrievalConfig } from "./retrieval.js";
import { DEFAULT_MAINTENANCE, type MaintenanceConfig } from "./maintenance.js";
import { DEFAULT_SCOPE, validScopeName, type ScopeConfig } from "./scope.js";
import { DEFAULT_REVISIONS, type RevisionConfig } from "./revisions.js";
export interface RuntimeSettings { retrieval: RetrievalConfig; maintenance: MaintenanceConfig; scope: ScopeConfig; revisions: RevisionConfig }
type Spec = { key: string; valid: (value: unknown) => boolean; hint: string };
const number = (min: number, max: number) => (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
export const SETTING_SPECS: Spec[] = [
	{ key: "retrieval.mode", valid: (v) => v === "legacy" || v === "balanced", hint: "legacy | balanced (experimental)" },
	{ key: "retrieval.minScorePerTerm", valid: number(0, 1000), hint: "number 0..1000" },
	{ key: "retrieval.minRelativeScore", valid: number(0, 1), hint: "number 0..1" },
	{ key: "retrieval.topicStickiness", valid: (v) => typeof v === "boolean", hint: "true | false" },
	{ key: "maintenance.historyMaxDays", valid: (v) => number(0, 36500)(v) && Number.isInteger(v), hint: "integer days 0..36500 (0 = all ages)" },
	{ key: "maintenance.carryForwardWarnDays", valid: (v) => number(1, 36500)(v) && Number.isInteger(v), hint: "integer days 1..36500" },
	{ key: "scope.mode", valid: (v) => v === "off" || v === "auto" || v === "explicit", hint: "off | auto | explicit" },
	{ key: "scope.name", valid: (v) => typeof v === "string" && (v === "" || validScopeName(v)), hint: "one folder name (not shared, '.', '..', slash or control characters); empty clears override" },
	{ key: "revisions.enabled", valid: (v) => typeof v === "boolean", hint: "true | false" },
	{ key: "revisions.maxPerFile", valid: (v) => number(1, 100)(v) && Number.isInteger(v), hint: "integer 1..100" },
	{ key: "revisions.maxTotalBytes", valid: (v) => number(65536, 1024 * 1024 * 1024)(v) && Number.isInteger(v), hint: "integer bytes 65536..1073741824" },
];
export function defaultSettings(): RuntimeSettings { return { retrieval: { ...DEFAULT_RETRIEVAL }, maintenance: { ...DEFAULT_MAINTENANCE }, scope: { ...DEFAULT_SCOPE }, revisions: { ...DEFAULT_REVISIONS } }; }
export function parseSettings(raw: unknown): RuntimeSettings {
	const out = defaultSettings();
	for (const spec of SETTING_SPECS) {
		const [section, key] = spec.key.split(".");
		const value = (raw as any)?.[section]?.[key];
		if (spec.valid(value)) (out as any)[section][key] = value;
	}
	return out;
}
export function changeSetting(current: RuntimeSettings, key: string, text: string): RuntimeSettings {
	const spec = SETTING_SPECS.find((s) => s.key === key);
	if (!spec) throw new Error(`Unknown policy setting: ${key}`);
	let value: unknown = text;
	try { value = JSON.parse(text); } catch {}
	if (!spec.valid(value)) throw new Error(`${key}: expected ${spec.hint}`);
	const next = structuredClone(current);
	const [section, name] = key.split("."); (next as any)[section][name] = value;
	return next;
}
export function settingsLines(settings: RuntimeSettings): string[] {
	return SETTING_SPECS.map(({ key }) => { const [section, name] = key.split("."); return `  ${key} = ${String((settings as any)[section][name])}`; });
}
