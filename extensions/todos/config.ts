/**
 * Where the task list lives, and the two settings that decide it.
 *
 * Everything here is a pure function of (cwd, session id, environment, config
 * file) plus one reader and one writer, so the whole matrix of storage modes is
 * testable without a running Pi:
 *
 * | scope     | file                                                  |
 * |-----------|---------------------------------------------------------|
 * | `memory`  | none — tasks die with the session                       |
 * | `session` | `<cwd>/.pi/tasks/tasks-<sessionId>.json` (default)      |
 * | `project` | `<cwd>/.pi/tasks/tasks.json`, shared by every session   |
 *
 * `PI_TODOS` overrides the file, and wins over the config:
 *
 * | value           | file                                            |
 * |-----------------|-------------------------------------------------|
 * | `off`           | none (CI, automation)                           |
 * | `/abs/x.json`   | that file                                       |
 * | `./rel.json`    | that file, resolved against the session cwd     |
 * | `~`             | `~/.pi/tasks/default.json`                    |
 * | `~/x.json`      | that file, under the home directory             |
 * | `sprint-1`      | `~/.pi/tasks/sprint-1.json` — a named shared list |
 *
 * A name is turned into a filename, so it is reduced to a basename of safe
 * characters first: `PI_TODOS=../../etc/passwd` names a list, it does not point
 * at a file outside `~/.pi/tasks`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { AUTO_CLEAR_MODES, type AutoClearMode } from "./auto-clear.js";
import { TASK_SCOPES, type TaskScope, WIDGET_DENSITIES, type WidgetDensity } from "./types.js";

export type { AutoClearMode } from "./auto-clear.js";
export type { TaskScope } from "./types.js";

export { AUTO_CLEAR_MODES };

/** How many turns completed tasks stay visible before auto-clear removes them. */
export const AUTO_CLEAR_DELAY_TURNS = 4;

/** Turns without a task tool call before the gentle nudge rides along with a result. */
export const REMINDER_INTERVAL_TURNS = 4;

/**
 * What a session starts with, before `alt+t` says otherwise. Deliberately the
 * generous one: the widget is where "what is it doing now" lives, so the key is
 * for contracting it when it gets in the way, not for earning it back.
 */
export const DEFAULT_WIDGET_DENSITY: WidgetDensity = "full";

export interface TodoConfig {
	taskScope?: TaskScope;
	autoClearCompleted?: AutoClearMode;
	/** Ask once when file-changing tools start with an empty list. Default on. */
	planNudge?: boolean;
	/** Rows the widget may take. Sets where a session starts, not what it ends on. */
	widgetDensity?: WidgetDensity;
}

export interface StorePathInput {
	cwd: string;
	sessionId?: string;
	config?: TodoConfig;
	env?: Record<string, string | undefined>;
	/** Injected so the named-list location is testable. */
	homeDir?: string;
}

/** Environment variable that overrides the storage location. */
export const ENV_VAR = "PI_TODOS";

function safeScope(value: unknown): TaskScope | undefined {
	return TASK_SCOPES.includes(value as TaskScope) ? (value as TaskScope) : undefined;
}

function safeMode(value: unknown): AutoClearMode | undefined {
	return AUTO_CLEAR_MODES.includes(value as AutoClearMode) ? (value as AutoClearMode) : undefined;
}

function safeDensity(value: unknown): WidgetDensity | undefined {
	return WIDGET_DENSITIES.includes(value as WidgetDensity) ? (value as WidgetDensity) : undefined;
}

/**
 * Read `<cwd>/.pi/tasks-config.json`. Unknown or malformed values are dropped
 * rather than trusted — this file is editable by hand, and a typo should fall
 * back to the default, not send tasks somewhere unexpected.
 */
export function loadTodoConfig(cwd: string): TodoConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(cwd, ".pi", "tasks-config.json"), "utf-8"));
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
	const raw = parsed as Record<string, unknown>;
	const config: TodoConfig = {};
	const scope = safeScope(raw.taskScope);
	if (scope) config.taskScope = scope;
	const mode = safeMode(raw.autoClearCompleted);
	if (mode) config.autoClearCompleted = mode;
	if (typeof raw.planNudge === "boolean") config.planNudge = raw.planNudge;
	const density = safeDensity(raw.widgetDensity);
	if (density) config.widgetDensity = density;
	return config;
}

/** Write the config back. `loadTodoConfig` reads exactly this. */
export function saveTodoConfig(cwd: string, config: TodoConfig): void {
	const path = join(cwd, ".pi", "tasks-config.json");
	mkdirSync(dirname(path), { recursive: true });
	const clean: TodoConfig = {};
	const scope = safeScope(config.taskScope);
	if (scope) clean.taskScope = scope;
	const mode = safeMode(config.autoClearCompleted);
	if (mode) clean.autoClearCompleted = mode;
	if (typeof config.planNudge === "boolean") clean.planNudge = config.planNudge;
	const density = safeDensity(config.widgetDensity);
	if (density) clean.widgetDensity = density;
	writeFileSync(path, JSON.stringify(clean, null, 2));
}

/** A list name becomes a filename: basename, then only characters a path can hold. */
export function safeListName(value: string): string {
	const cleaned = basename(value)
		.replace(/\.json$/i, "")
		.replace(/[^A-Za-z0-9._-]/g, "-")
		.replace(/^\.+/, "")
		.slice(0, 64);
	return cleaned.length > 0 ? cleaned : "default";
}

/**
 * The file this session should use, or undefined for an in-memory list.
 * `sessionId` is absent before the first session starts, which is what makes the
 * default `session` scope in-memory until one exists.
 */
export function resolveStorePath(input: StorePathInput): string | undefined {
	const env = input.env ?? process.env;
	const home = input.homeDir ?? input.env?.HOME ?? homedir();
	const override = env[ENV_VAR]?.trim();

	if (override) {
		if (override === "off") return undefined;
		if (isAbsolute(override)) return override;
		if (override.startsWith("./") || override.startsWith("../") || override === "." || override === "..") {
			return resolve(input.cwd, override);
		}
		// `~/x` means the home directory, not the filesystem root: slicing one
		// character would turn `~/board.json` into `/board.json`.
		if (override === "~") return join(home, ".pi", "tasks", "default.json");
		if (override.startsWith("~/")) return resolve(home, override.slice(2));
		return join(home, ".pi", "tasks", `${safeListName(override)}.json`);
	}

	const scope = safeScope(input.config?.taskScope) ?? "session";
	if (scope === "memory") return undefined;
	if (scope === "project") return join(input.cwd, ".pi", "tasks", "tasks.json");
	if (!input.sessionId) return undefined;
	return join(input.cwd, ".pi", "tasks", `tasks-${safeListName(input.sessionId)}.json`);
}
