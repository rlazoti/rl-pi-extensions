/**
 * One vocabulary of lines for everything that shows the task list: the widget
 * above the editor, the tool results, the system-prompt block, and `/todos` in a
 * non-interactive run.
 *
 * The colour is a parameter, not a constant. Every builder here takes a `Paint`,
 * and `plainPaint` is a legal value, which is what lets a test assert on the text
 * a panel will show without a theme — and lets the system prompt use the same
 * builder as the widget, so the model and the human cannot disagree about what a
 * line means.
 *
 * Two invariants the terminal needs, both asserted in the tests:
 *
 * - **No row returned by `widgetLines` contains a newline.** One element of a
 *   `render()` array is one terminal row; an element holding a newline is painted
 *   as two rows while the layout counted one, which shifts everything under it.
 * - **No row is wider than the frame it was asked for**, after stripping colour.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	PRIORITY_ORDER,
	type Task,
	type TaskPriority,
	type TaskStatus,
	type WidgetDensity,
} from "./types.js";

/** The spinner the widget cycles through while a task is in progress. */
export const SPINNER_FRAMES = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];

/** Beyond this many rows the widget is a wall of text; the count line still tells the truth. */
export const MAX_WIDGET_TASKS = 12;

/**
 * The key that cycles the widget's density. It lives with the text because the
 * overflow rows name it: the row that makes the widget small is the row that
 * tells you how to make it big again, and a constant keeps the two from drifting.
 */
export const DENSITY_SHORTCUT = "alt+t";

/** Rows `attention` spends on work; past that it counts the rest, like `full` does. */
export const ATTENTION_MAX_ROWS = 4;

/** The statuses that still earn a row once the widget is contracted. */
export const ATTENTION_STATUSES: readonly TaskStatus[] = ["in_progress", "blocked", "failed"];

/** What each density gives you, for the settings menu and the notify after a cycle. */
export const DENSITY_SUMMARY: Record<WidgetDensity, string> = {
	full: "the tally and the task rows",
	attention: "the tally and whatever is in progress, blocked or failed",
	minimal: "one line: what is running now, and the counts",
};

export type LineRole = "accent" | "dim" | "muted" | "success" | "warning" | "error" | "bold" | "strike";

/** Applies styling to a fragment. `plainPaint` returns the text unchanged. */
export type Paint = (role: LineRole, text: string) => string;

export const plainPaint: Paint = (_role, text) => text;

export function themePaint(theme: Theme): Paint {
	return (role, text) => {
		switch (role) {
			case "accent":
				return theme.fg("accent", text);
			case "dim":
				return theme.fg("dim", text);
			case "muted":
				return theme.fg("muted", text);
			case "success":
				return theme.fg("success", text);
			case "warning":
				return theme.fg("warning", text);
			case "error":
				return theme.fg("error", text);
			case "bold":
				return theme.bold(text);
			case "strike":
				return theme.strikethrough(theme.fg("dim", text));
		}
	};
}

/**
 * Collapse a task's own words onto one line. One element of `render()` is one
 * terminal row, so content that arrives with a newline would shift everything
 * under it. The store normalises this on the way in too; a hand-built Task must
 * not be able to break the frame on its way through.
 */
/**
 * Task ids in the order they were created. `localeCompare` would put `t10` before
 * `t2`, and both readers of a sorted list — the model, told to work lowest id
 * first, and the panel — would take that as the plan.
 */
export function compareTaskIds(left: string, right: string): number {
	const a = /^(\D+)\d+$/.exec(left);
	const b = /^(\D+)\d+$/.exec(right);
	if (a && b) {
		if (a[1] !== b[1]) return left.localeCompare(right);
		const rank = Number.parseInt(left.slice(a[1]!.length), 10) - Number.parseInt(right.slice(b[1]!.length), 10);
		if (rank !== 0) return rank;
		return left.length - right.length;
	}
	return left.localeCompare(right);
}

export function oneLine(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ").trim();
}

export function statusIcon(status: TaskStatus): string {
	switch (status) {
		case "completed":
			return "✔";
		case "in_progress":
			return "◼";
		case "blocked":
			return "⏸";
		case "failed":
			return "✗";
		case "cancelled":
			return "⊘";
		default:
			return "◻";
	}
}

/** The icon a row gets, with the spinner taking precedence over the status glyph. */
export function rowIcon(task: Task, active: boolean, spinnerFrame: string, paint: Paint): string {
	if (active) return paint("accent", spinnerFrame);
	const icon = statusIcon(task.status);
	switch (task.status) {
		case "completed":
			return paint("success", icon);
		case "in_progress":
			return paint("accent", icon);
		case "blocked":
			return paint("warning", icon);
		case "failed":
			return paint("error", icon);
		case "cancelled":
			return paint("dim", icon);
		default:
			return icon;
	}
}

export function priorityLabel(priority: TaskPriority): string {
	return priority.charAt(0).toUpperCase() + priority.slice(1);
}

export function priorityRole(priority: TaskPriority): LineRole {
	return priority === "high" ? "error" : priority === "low" ? "dim" : "warning";
}

/** `42s`, `3m 20s`, `1h 5m` — long enough to be useful, short enough to fit a row. */
export function formatDuration(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	if (totalSec < 60) return `${totalSec}s`;
	const minutes = Math.floor(totalSec / 60);
	const seconds = totalSec % 60;
	if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Blockers that still have to resolve, in the order they were added. */
export function openBlockers(task: Task, tasks: readonly Task[]): Task[] {
	const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
	return task.blockedBy
		.map((id) => byId.get(id))
		.filter((blocker): blocker is Task => blocker !== undefined && blocker.status !== "completed");
}

/** ` › blocked by #t1, #t2`, or "" — the hint that stops the model starting blocked work. */
export function blockerHint(task: Task, tasks: readonly Task[], paint: Paint): string {
	const blockers = openBlockers(task, tasks);
	if (blockers.length === 0) return "";
	const ids = blockers.map((blocker) => `#${blocker.id}`).join(", ");
	return paint("dim", ` › blocked by ${ids}`);
}

export interface Counts {
	total: number;
	completed: number;
	inProgress: number;
	blocked: number;
	failed: number;
	cancelled: number;
	pending: number;
}

export function counts(tasks: readonly Task[]): Counts {
	const tally: Counts = {
		total: tasks.length,
		completed: 0,
		inProgress: 0,
		blocked: 0,
		failed: 0,
		cancelled: 0,
		pending: 0,
	};
	for (const task of tasks) {
		if (task.status === "completed") tally.completed++;
		else if (task.status === "in_progress") tally.inProgress++;
		else if (task.status === "blocked") tally.blocked++;
		else if (task.status === "failed") tally.failed++;
		else if (task.status === "cancelled") tally.cancelled++;
		else tally.pending++;
	}
	return tally;
}

/** `4 tasks (1 done, 1 in progress, 2 open)` — the widget header, and the print-mode headline. */
export function summaryLine(tasks: readonly Task[], paint: Paint = plainPaint): string {
	const tally = counts(tasks);
	const parts: string[] = [];
	if (tally.completed > 0) parts.push(`${tally.completed} done`);
	if (tally.inProgress > 0) parts.push(`${tally.inProgress} in progress`);
	if (tally.blocked > 0) parts.push(paint("warning", `${tally.blocked} blocked`));
	if (tally.failed > 0) parts.push(paint("error", `${tally.failed} failed`));
	if (tally.cancelled > 0) parts.push(paint("dim", `${tally.cancelled} cancelled`));
	if (tally.pending > 0) parts.push(`${tally.pending} open`);
	const noun = tally.total === 1 ? "task" : "tasks";
	return paint("accent", `${tally.total} ${noun}`) + (parts.length > 0 ? ` (${parts.join(", ")})` : "");
}

/** Which row of a task is emphasised, and how, for a given status. */
function paintTitle(task: Task, active: boolean, paint: Paint): string {
	const content = oneLine(task.content);
	if (active) return paint("accent", `${oneLine(task.activeForm || task.content)}…`);
	if (task.status === "completed") return paint("strike", content);
	if (task.status === "in_progress") return paint("bold", content);
	if (task.status === "blocked") return paint("muted", content);
	if (task.status === "failed") return paint("error", content);
	if (task.status === "cancelled") return paint("dim", content);
	return content;
}

export interface WidgetOptions {
	/** Tasks with a live spinner, usually the one the agent is working on. */
	activeIds?: ReadonlySet<string>;
	/** When each active task started, for the elapsed column. */
	startedAt?: ReadonlyMap<string, number>;
	/** Spinner frame index. */
	frame?: number;
	/** Injectable clock; tests do not wait in real time. */
	now?: number;
	paint?: Paint;
	/** Terminal columns. Every returned line fits inside it. */
	width?: number;
	/** Cap on visible rows; the overflow is summarised, not hidden silently. */
	maxTasks?: number;
	/** How much of the list a row budget buys. Defaults to `full`. */
	density?: WidgetDensity;
}

/**
 * The tasks a density gives a row to, in display order, with the indent they are
 * drawn at. One selection rule on purpose: `rendersSpinner` asks this the same
 * question the renderer answers, so the widget's animation timer cannot tick for
 * a spinner the current density has hidden.
 */
function orderVisible(tasks: readonly Task[], options: WidgetOptions): Array<[Task, number]> {
	const density = options.density ?? "full";
	const cap = Math.max(0, options.maxTasks ?? MAX_WIDGET_TASKS);
	const maxTasks = density === "attention" ? Math.min(cap, ATTENTION_MAX_ROWS) : cap;
	const candidates =
		density === "attention" ? tasks.filter((task) => ATTENTION_STATUSES.includes(task.status)) : tasks;

	const children = new Map<string, Task[]>();
	for (const task of candidates) {
		if (!task.parentId) continue;
		const siblings = children.get(task.parentId) ?? [];
		siblings.push(task);
		children.set(task.parentId, siblings);
	}

	const ordered: Array<[Task, number]> = [];
	const placed = new Set<string>();
	const place = (task: Task, indent: number): void => {
		if (placed.size >= maxTasks) return;
		placed.add(task.id);
		ordered.push([task, indent]);
	};
	for (const task of candidates) {
		if (task.parentId) continue;
		place(task, 0);
		for (const child of children.get(task.id) ?? []) place(child, 1);
	}
	// Orphans: a subtask whose parent is not on screen still has to be reachable.
	for (const task of candidates) {
		if (!placed.has(task.id)) place(task, task.parentId ? 1 : 0);
	}
	return ordered;
}

/**
 * Whether the rows this density would return contain a live spinner. The widget's
 * 200 ms timer follows this rather than the store: a spinner nobody can see is a
 * timer repainting an idle terminal.
 */
export function rendersSpinner(tasks: readonly Task[], options: WidgetOptions = {}): boolean {
	const activeIds = options.activeIds;
	if (tasks.length === 0 || !activeIds || activeIds.size === 0) return false;
	const running = (task: Task): boolean => task.status === "in_progress" && activeIds.has(task.id);
	// `minimal` has no task rows, but its one row still carries the spinner.
	if ((options.density ?? "full") === "minimal") return tasks.some(running);
	return orderVisible(tasks, options).some(([task]) => running(task));
}

/**
 * The widget body: a count line, then the open work with one line per task,
 * subtasks indented under their parent. Returns nothing when the list is empty —
 * an empty widget must not occupy a row.
 *
 * `density` trades rows for detail, because the widget sits on top of somebody's
 * output: `full` is the whole list, `attention` drops the queue and the finished
 * work, `minimal` is one line. The tally is the first row of every density, so
 * contracting never hides the size of the plan.
 */
export function widgetLines(tasks: readonly Task[], options: WidgetOptions = {}): string[] {
	if (tasks.length === 0) return [];
	const paint = options.paint ?? plainPaint;
	const width = Math.max(8, options.width ?? 80);
	const now = options.now ?? Date.now();
	const spinner = SPINNER_FRAMES[(options.frame ?? 0) % SPINNER_FRAMES.length]!;
	const density = options.density ?? "full";

	if (density === "minimal") {
		return [clip(minimalLine(tasks, { ...options, spinner, now, paint }), width)];
	}

	const ordered = orderVisible(tasks, options);
	const lines: string[] = [clip(summaryLine(tasks, paint), width)];

	for (const [task, indent] of ordered) {
		lines.push(clip(widgetTaskLine(task, tasks, { ...options, indent, spinner, now, paint }), width));
	}

	if (density === "attention" && ordered.length === 0) {
		return [...lines, clip(paint("dim", `    nothing needs attention · ${DENSITY_SHORTCUT} for the list`), width)];
	}

	const hidden = tasks.length - ordered.length;
	if (hidden > 0) {
		const hint =
			density === "full" ? `see TodoList · ${DENSITY_SHORTCUT} to contract` : `${DENSITY_SHORTCUT} for one line`;
		lines.push(clip(paint("dim", `    … and ${hidden} more (${hint})`), width));
	}
	return lines;
}

/**
 * The one row `minimal` spends: the active task with its spinner and elapsed
 * time, and the tally beside it. A widget that drops to a bare count cannot
 * answer "what is it doing", which is the row worth keeping.
 */
function minimalLine(
	tasks: readonly Task[],
	options: WidgetOptions & { spinner: string; now: number; paint: Paint },
): string {
	const paint = options.paint;
	const summary = summaryLine(tasks, paint);
	const active = tasks.find((task) => options.activeIds?.has(task.id) === true && task.status === "in_progress");
	if (!active) return summary;
	const started = options.startedAt?.get(active.id) ?? options.now;
	const elapsed = paint("dim", `(${formatDuration(options.now - started)})`);
	const icon = rowIcon(active, true, options.spinner, paint);
	return `${icon} ${paintTitle(active, true, paint)} ${elapsed}  ${paint("dim", "·")} ${summary}`;
}

function widgetTaskLine(
	task: Task,
	tasks: readonly Task[],
	options: WidgetOptions & { indent: number; spinner: string; now: number; paint: Paint },
): string {
	const { indent, spinner, now, paint } = options;
	const active = options.activeIds?.has(task.id) === true && task.status === "in_progress";
	const pad = `  ${"  ".repeat(indent)}`;
	const icon = rowIcon(task, active, spinner, paint);
	const owner = task.owner ? paint("dim", ` [${oneLine(task.owner)}]`) : "";

	if (active) {
		const started = options.startedAt?.get(task.id) ?? now;
		const elapsed = paint("dim", `(${formatDuration(now - started)})`);
		return `${pad}${icon} ${paintTitle(task, true, paint)} ${elapsed}${owner}`;
	}

	const hint =
		task.status === "pending" || task.status === "blocked" || task.status === "in_progress"
			? blockerHint(task, tasks, paint)
			: "";
	return `${pad}${icon} ${paintTitle(task, false, paint)}${owner}${hint}`;
}

export interface ResultOptions {
	expanded?: boolean;
	paint?: Paint;
	/** Rows shown when collapsed; the rest is counted, not hidden silently. */
	collapsedLimit?: number;
}

/**
 * The text a tool result shows under the call. Same icons and priority labels as
 * the widget, so a screenshot of a transcript and a glance at the widget describe
 * the same list.
 */
export function toolResultText(tasks: readonly Task[], options: ResultOptions = {}): string {
	const paint = options.paint ?? plainPaint;
	if (tasks.length === 0) return paint("dim", "Task list is empty");
	const limit = options.collapsedLimit ?? 5;
	const tally = counts(tasks);
	const parts: string[] = [];
	if (tally.inProgress > 0) parts.push(paint("accent", `◼ ${tally.inProgress} active`));
	if (tally.blocked > 0) parts.push(paint("warning", `⏸ ${tally.blocked} blocked`));
	if (tally.failed > 0) parts.push(paint("error", `✗ ${tally.failed} failed`));
	if (tally.cancelled > 0) parts.push(paint("dim", `⊘ ${tally.cancelled} cancelled`));
	parts.push(paint("success", `✔ ${tally.completed}/${tally.total} done`));

	const lines: string[] = [parts.join("  ")];
	const display = options.expanded ? tasks : tasks.slice(0, limit);
	for (const task of display) {
		const indent = task.parentId ? "  " : "";
		const icon = rowIcon(task, false, "", paint);
		const priority = paint(priorityRole(task.priority), priorityLabel(task.priority));
		const owner = task.owner ? paint("dim", ` [${oneLine(task.owner)}]`) : "";
		lines.push(`${indent}${icon} ${priority}  ${paintTitle(task, false, paint)}${owner}`);
	}
	if (!options.expanded && tasks.length > limit) {
		lines.push(paint("dim", `… ${tasks.length - limit} more, expand to see them`));
	}
	return lines.join("\n");
}

/** One task, as the model asked for it: every field it declared, in a fixed order. */
export function taskDetailText(task: Task, tasks: readonly Task[]): string {
	const lines: string[] = [
		`Task #${task.id}: ${oneLine(task.content)}`,
		`Status: ${task.status}`,
		`Priority: ${task.priority}`,
	];
	if (task.owner) lines.push(`Owner: ${task.owner}`);
	if (task.parentId) lines.push(`Subtask of: #${task.parentId}`);
	lines.push(`Description: ${task.description || "(none)"}`);
	const blockers = openBlockers(task, tasks).map((blocker) => `#${blocker.id}`);
	if (blockers.length > 0) lines.push(`Blocked by: ${blockers.join(", ")}`);
	if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.map((id) => `#${id}`).join(", ")}`);
	const metadataKeys = Object.keys(task.metadata);
	if (metadataKeys.length > 0) lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);
	const elapsed =
		task.startedAt && task.completedAt
			? `Took: ${formatDuration(task.completedAt - task.startedAt)}`
			: task.startedAt
				? `Started: ${formatDuration(Date.now() - task.startedAt)} ago`
				: "";
	if (elapsed) lines.push(elapsed);
	return lines.join("\n");
}

/** Every task on one line each, in the order the model should read them. */
export function listForLLM(tasks: readonly Task[]): string {
	if (tasks.length === 0) return "No tasks.";
	const order: Record<TaskStatus, number> = {
		pending: 0,
		in_progress: 1,
		blocked: 2,
		failed: 3,
		cancelled: 4,
		completed: 5,
	};
	return [...tasks]
		.sort((left, right) => order[left.status] - order[right.status] || compareTaskIds(left.id, right.id))
		.map((task) => {
			const ready =
				task.status === "pending" && openBlockers(task, tasks).length === 0 ? " [ready]" : "";
			const blockerIds = openBlockers(task, tasks).map((blocker) => `#${blocker.id}`);
			const blockers = blockerIds.length > 0 ? ` [blocked by ${blockerIds.join(", ")}]` : "";
			const subtask = task.parentId ? ` [subtask of #${task.parentId}]` : "";
			const owner = task.owner ? ` [owner: ${oneLine(task.owner)}]` : "";
			return `[${task.status}] [${task.priority}] #${task.id} ${oneLine(task.content)}${subtask}${owner}${blockers}${ready}`;
		})
		.join("\n");
}

/**
 * The block appended to the system prompt while work is open. In-progress first,
 * then the open queue by priority, then whatever needs a decision — the order the
 * model should act in, not the order the tasks were created.
 */
export function systemPromptBlock(tasks: readonly Task[]): string {
	const open = tasks.filter((task) => task.status !== "completed" && task.status !== "cancelled");
	if (open.length === 0) return "";
	const inProgress = open.filter((task) => task.status === "in_progress");
	const pending = open
		.filter((task) => task.status === "pending")
		.sort((left, right) => PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]);
	const attention = open.filter((task) => task.status === "blocked" || task.status === "failed");

	const lines = [
		"## Current Task List",
		"",
		"Update these with `TodoUpdate` as you work — `in_progress` before starting, `completed` only when fully done.",
		"When the user has requested execution of this plan, continue to the next actionable task without waiting for another prompt. Stop if the user asks you to stop, a decision or approval is needed, or you are blocked or cannot safely proceed. A status request or question alone is not permission to execute the plan.",
		"",
	];
	for (const task of [...inProgress, ...pending, ...attention]) {
		const icon = statusIcon(task.status);
		const marker = task.status === "in_progress" ? "  ← in progress" : "";
		const blockerIds = openBlockers(task, tasks).map((blocker) => `#${blocker.id}`);
		const blockers = blockerIds.length > 0 ? ` [blocked by ${blockerIds.join(", ")}]` : "";
		lines.push(`${icon} [${task.id}] [${priorityLabel(task.priority)}] ${oneLine(task.content)}${marker}${blockers}`);
	}
	const done = tasks.length - open.length;
	if (done > 0) lines.push("", `${done}/${tasks.length} tasks completed.`);
	return lines.join("\n");
}

/** Strip colour and clip to a terminal width, so a row never wraps into two. */
function clip(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	return truncateVisible(line, width);
}

/**
 * Width-aware truncation that keeps colour sequences intact: the escape codes are
 * carried along without being counted, and the string is closed with a reset.
 */
export function truncateVisible(line: string, width: number): string {
	const limit = Math.max(1, width);
	const pieces = line.match(/\u001b\[[0-9;]*m|[^\u001b]+/g) ?? [];
	let out = "";
	let used = 0;
	for (const piece of pieces) {
		if (piece.startsWith("\u001b")) {
			out += piece;
			continue;
		}
		for (const character of piece) {
			const size = visibleWidth(character);
			if (used + size > limit - 1) {
				out += "\u001b[0m…";
				return out;
			}
			used += size;
			out += character;
		}
	}
	return out;
}
