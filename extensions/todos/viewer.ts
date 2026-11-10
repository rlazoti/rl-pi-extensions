/**
 * `/todos` — the interactive task manager.
 *
 * One framed panel: a summary line, a progress bar, the open work grouped by what
 * needs doing, and keys to move a task through its life without leaving the
 * editor. The layout borrows the repo's shared frame so this panel looks like the
 * other pickers, and the row budget works the way the context viewer's does: the
 * summary and the footer are structural, the progress bar is not, so a short
 * terminal loses the bar before it loses a task. Spare rows go above the footer
 * rather than below it, so the keys stay the last thing in the frame.
 *
 * Writing is delegated. The viewer never touches the store: it asks for an action
 * through `act`, which is where the write and its errors belong. That keeps this
 * file about geometry and keystrokes, and it means the two ways a task can change
 * — the panel and the model's `TodoUpdate` — go through one code path.
 *
 * While an action is in flight every key is ignored. Two `x` keystrokes in a row
 * would otherwise delete the task that moved into the second keystroke's slot.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { fit, frameLines, fillRows } from "../panel.js";
import {
	blockerHint,
	compareTaskIds,
	counts,
	oneLine,
	openBlockers,
	priorityLabel,
	priorityRole,
	rowIcon,
	summaryLine,
	type LineRole,
	type Paint,
} from "./render.js";
import type { Task } from "./types.js";

export type TaskAction = "start" | "complete" | "block" | "delete" | "clear_completed";

export type TaskViewerResult = "closed" | "settings";

/** Runs one action. Resolves to a status line to show in the panel, or nothing. */
export type TaskActionHandler = (task: Task | undefined, action: TaskAction) => Promise<string | undefined>;

export interface TaskViewState {
	/** Completed tasks start hidden — they are the least useful rows in the panel. */
	showCompleted?: boolean;
	/** Task index to put the cursor on. */
	cursor?: number;
}

type SectionRole = "accent" | "muted" | "warning" | "dim";

interface Section {
	title: string;
	role: SectionRole;
	tasks: Task[];
}

type Row = { kind: "section"; title: string; role: SectionRole; count: number } | { kind: "task"; task: Task };

/**
 * The key hints, in two lines: the panel is wide enough that a single line of every
 * binding overflows the frame, and the reader loses the keys at exactly the moment
 * the list gets long enough to need them.
 */
const FOOTER_LINES = ["↑↓ move  enter act  s start  d done  b block  x delete", "c clear done  t show done  o settings  q close"];

/**
 * How much of the terminal the panel may take — and the number the host is told as
 * `maxHeight` where the overlay is opened. Both sides must be this one number:
 * pi-tui slices the overlay's lines to the cap it was given, so a component that
 * budgets more rows than the box allows has its last rows cut off by the host.
 * Those rows are the footer keys and the bottom border — the part a reader needs
 * in order to leave.
 */
export const PANEL_HEIGHT_PERCENT = 80;

/** `LineRole` → a theme token, because two roles are styles rather than colours. */
function tokenFor(role: LineRole): ThemeColor {
	switch (role) {
		case "accent":
			return "accent";
		case "success":
			return "success";
		case "warning":
			return "warning";
		case "error":
			return "error";
		case "dim":
			return "dim";
		default:
			return "muted";
	}
}

export class TaskViewer {
	private readonly listTasks: () => Task[];
	private readonly theme: Theme;
	private readonly paint: Paint;
	private readonly tui: TUI;
	private readonly done: (result: TaskViewerResult) => void;
	private readonly act: TaskActionHandler;

	private cursor: number;
	private showCompleted: boolean;
	private offset = 0;
	private bodyRows = 1;
	private status: string | undefined;
	private busy = false;
	private closed = false;

	constructor(
		listTasks: () => Task[],
		theme: Theme,
		tui: TUI,
		done: (result: TaskViewerResult) => void,
		act: TaskActionHandler,
		state: TaskViewState = {},
	) {
		this.listTasks = listTasks;
		this.theme = theme;
		this.paint = (role, text) => (role === "bold" ? theme.bold(text) : role === "strike" ? theme.strikethrough(theme.fg("dim", text)) : theme.fg(tokenFor(role), text));
		this.tui = tui;
		this.done = done;
		this.act = act;
		this.showCompleted = state.showCompleted ?? false;
		this.cursor = Math.max(0, state.cursor ?? 0);
	}

	/** Required by pi-tui's Component; nothing here is cached between frames. */
	invalidate(): void {}

	/** Test seam: the state a keystroke moves. */
	get view(): { cursor: number; offset: number; status: string | undefined; busy: boolean; showCompleted: boolean } {
		return { cursor: this.cursor, offset: this.offset, status: this.status, busy: this.busy, showCompleted: this.showCompleted };
	}

	/** Test seam: the tasks the cursor can reach, in panel order. */
	visibleTasks(tasks: Task[] = this.listTasks()): Task[] {
		return this.sections(tasks).flatMap((section) => section.tasks);
	}

	handleInput(data: string): void {
		if (this.closed || this.busy) return;

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, "q")) {
			this.close("closed");
			return;
		}

		const tasks = this.visibleTasks();
		if (tasks.length === 0) {
			// Nothing to move a cursor over: the panel is a message, and any key leaves it.
			if (matchesKey(data, Key.enter)) this.close("closed");
			else if (matchesKey(data, "t")) {
				this.showCompleted = !this.showCompleted;
				this.changed();
			} else if (matchesKey(data, "o")) this.close("settings");
			return;
		}

		this.cursor = Math.min(this.cursor, tasks.length - 1);
		const selected = tasks[this.cursor]!;

		if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.cursor = Math.max(0, this.cursor - 1);
		else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.cursor = Math.min(tasks.length - 1, this.cursor + 1);
		else if (matchesKey(data, Key.home) || matchesKey(data, "g")) this.cursor = 0;
		else if (matchesKey(data, Key.end)) this.cursor = tasks.length - 1;
		else if (matchesKey(data, "t")) this.showCompleted = !this.showCompleted;
		else if (matchesKey(data, "o")) {
			this.close("settings");
			return;
		} else if (matchesKey(data, "c")) void this.run(undefined, "clear_completed");
		else if (matchesKey(data, Key.enter)) void this.run(selected, this.primaryAction(selected));
		else if (matchesKey(data, "s")) void this.run(selected, "start");
		else if (matchesKey(data, "d")) void this.run(selected, "complete");
		else if (matchesKey(data, "b")) void this.run(selected, "block");
		else if (matchesKey(data, "x")) void this.run(selected, "delete");
		else return;

		this.scrollIntoView(tasks.length);
		this.changed();
	}

	/** What `enter` means for this task: begin it, or finish it. */
	primaryAction(task: Task): TaskAction {
		return task.status === "in_progress" ? "complete" : "start";
	}

	private close(result: TaskViewerResult): void {
		if (this.closed) return;
		this.closed = true;
		this.done(result);
	}

	private async run(task: Task | undefined, action: TaskAction): Promise<void> {
		this.busy = true;
		this.status = action === "clear_completed" ? "clearing completed tasks…" : `${action} #${task?.id ?? "?"}…`;
		this.changed();
		try {
			this.status = (await this.act(task, action)) ?? undefined;
		} catch (error) {
			// A refused action is reported in the panel, never thrown into the UI loop.
			this.status = error instanceof Error ? error.message : String(error);
		} finally {
			this.busy = false;
			this.cursor = Math.min(this.cursor, Math.max(0, this.visibleTasks().length - 1));
			this.changed();
		}
	}

	/**
	 * The panel's sections in display order: what is running, then the open queue
	 * by priority, then work that needs a decision, then the rest. Completed work
	 * is last and hidden by default.
	 */
	sections(tasks: readonly Task[]): Section[] {
		const byPriority = (left: Task, right: Task) =>
			priorityRank(left) - priorityRank(right) || compareTaskIds(left.id, right.id);
		// "Waiting on another task" is a property of the edges, not of the status the
		// agent authored, so it is derived here rather than written into the record.
		const waiting = (task: Task) => openBlockers(task, tasks).length > 0;
		const sections: Section[] = [
			{ title: "In Progress", role: "accent", tasks: tasks.filter((task) => task.status === "in_progress") },
			{
				title: "Pending",
				role: "muted",
				tasks: tasks.filter((task) => task.status === "pending" && !waiting(task)).sort(byPriority),
			},
			{
				title: "Needs Attention",
				role: "warning",
				tasks: tasks.filter(
					(task) => task.status === "blocked" || task.status === "failed" || (task.status === "pending" && waiting(task)),
				),
			},
			{ title: "Cancelled", role: "dim", tasks: tasks.filter((task) => task.status === "cancelled") },
		];
		if (this.showCompleted) {
			sections.push({ title: "Completed", role: "dim", tasks: tasks.filter((task) => task.status === "completed") });
		}
		return sections.filter((section) => section.tasks.length > 0);
	}

	private rows(tasks: readonly Task[]): Row[] {
		const rows: Row[] = [];
		for (const section of this.sections(tasks)) {
			rows.push({ kind: "section", title: section.title, role: section.role, count: section.tasks.length });
			for (const task of section.tasks) rows.push({ kind: "task", task });
		}
		return rows;
	}

	/** Keep the cursor inside the window; the window moves, the list does not. */
	private scrollIntoView(total: number): void {
		const max = Math.max(0, total - this.bodyRows);
		if (this.cursor < this.offset) this.offset = Math.max(0, Math.min(this.cursor, max));
		else if (this.cursor >= this.offset + this.bodyRows) {
			this.offset = Math.max(0, Math.min(this.cursor - this.bodyRows + 1, max));
		} else this.offset = Math.max(0, Math.min(this.offset, max));
	}

	private changed(): void {
		try {
			this.tui.requestRender();
		} catch {
			// A host that refuses a repaint is not a reason to fail a keystroke.
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(20, Math.floor(width));
		const availableRows = Math.max(5, Math.floor((this.tui.terminal.rows * PANEL_HEIGHT_PERCENT) / 100));
		const paddingY = availableRows >= 14 ? 1 : 0;
		const contentWidth = safeWidth - 4;
		const contentRows = availableRows - 2 - paddingY * 2;

		const tasks = this.listTasks();
		const visible = this.visibleTasks(tasks);
		const showProgress = contentRows >= 8 && tasks.length > 0;
		// Everything except the task rows, counted. An uncounted line is a task row
		// pushed out of the frame by `fillRows`, and the footer was the line it lost.
		const chrome = 1 + (showProgress ? 2 : 0) + (this.status ? 1 : 0) + FOOTER_LINES.length;
		const headings = this.sections(tasks).length;
		this.bodyRows = Math.max(1, contentRows - chrome - headings);
		// The "N more below" line is structural too: it is what tells the reader the
		// list did not fit, so it gets its row before the tasks take the last one.
		if (visible.length > this.bodyRows) this.bodyRows = Math.max(1, this.bodyRows - 1);

		const body: string[] = [];
		body.push(fit(summaryLine(tasks, this.paint), contentWidth));
		if (showProgress) {
			body.push(fit(this.progressLine(tasks, visible.length, contentWidth), contentWidth));
			body.push(fit(this.theme.fg("dim", "─".repeat(contentWidth)), contentWidth));
		}

		if (tasks.length === 0) {
			body.push(
				fit(this.theme.fg("dim", "No tasks yet. Ask the agent to plan the work, or press o for settings."), contentWidth),
			);
		} else if (visible.length === 0) {
			body.push(fit(this.theme.fg("dim", "Nothing to show — press t to reveal completed tasks."), contentWidth));
		} else {
			this.cursor = Math.min(this.cursor, visible.length - 1);
			this.scrollIntoView(visible.length);
			let index = -1;
			for (const row of this.rows(tasks)) {
				if (row.kind === "section") {
					body.push(fit(this.sectionLine(row.title, row.role, row.count), contentWidth));
					continue;
				}
				index++;
				if (index < this.offset || index >= this.offset + this.bodyRows) continue;
				body.push(fit(this.taskLine(row.task, tasks, index === this.cursor), contentWidth));
			}
			const hidden = visible.length - Math.min(visible.length, this.bodyRows);
			if (hidden > 0) body.push(fit(this.theme.fg("dim", `… ${hidden} more below (↓ to scroll)`), contentWidth));
		}

		const statusLine: string[] = [];
		const footer: string[] = [];
		if (this.status) statusLine.push(fit(this.theme.fg("dim", this.status), contentWidth));
		for (const line of FOOTER_LINES) footer.push(fit(this.theme.fg("dim", line), contentWidth));
		// Spare rows go between the list and the keys, not below them: padding under the
		// footer leaves the keys floating in the middle of a tall frame, which is where a
		// reader looks for the way out and finds nothing.
		const filler = Math.max(0, contentRows - body.length - statusLine.length - footer.length);
		for (let row = 0; row < filler; row++) body.push("");
		body.push(...statusLine, ...footer);

		return frameLines(this.theme, fillRows(body, contentRows), safeWidth, paddingY, " Tasks ");
	}

	private sectionLine(title: string, role: SectionRole, count: number): string {
		const note = role === "dim" && title === "Completed" ? this.theme.fg("dim", "  t hides") : "";
		return `  ${this.theme.fg(role, this.theme.bold(title))} ${this.theme.fg("dim", `(${count})`)}${note}`;
	}

	private taskLine(task: Task, all: readonly Task[], focused: boolean): string {
		const icon = rowIcon(task, false, "", this.paint);
		const priority = this.paint(priorityRole(task.priority), priorityLabel(task.priority));
		const indent = task.parentId ? "  " : "";		const content = oneLine(task.content);
		const title =
			task.status === "completed"
				? this.paint("strike", content)
				: task.status === "in_progress"
					? this.paint("bold", content)
					: task.status === "failed"
						? this.paint("error", content)
						: task.status === "blocked"
							? this.paint("warning", content)
							: task.status === "cancelled"
								? this.paint("dim", content)
								: content;
		const cursor = focused ? this.theme.fg("accent", "❯") : " ";
		const meta = [this.theme.fg("dim", `#${task.id}`)];
		if (task.owner) meta.push(this.theme.fg("dim", `@${task.owner}`));
		return `  ${cursor} ${indent}${icon} ${priority}  ${title} ${meta.join(" ")}${blockerHint(task, all, this.paint)}`;
	}

	private progressLine(tasks: readonly Task[], visibleCount: number, width: number): string {
		const tally = counts(tasks);
		const barWidth = Math.max(4, Math.min(24, width - 22));
		const filled = tally.total > 0 ? Math.round((tally.completed / tally.total) * barWidth) : 0;
		const bar = `${this.theme.fg("success", "█".repeat(filled))}${this.theme.fg("dim", "░".repeat(Math.max(0, barWidth - filled)))}`;
		const percent = tally.total > 0 ? Math.round((tally.completed / tally.total) * 100) : 0;
		const hidden = tally.total - visibleCount;
		const note = hidden > 0 ? this.theme.fg("dim", `  ${hidden} hidden (t)`) : "";
		return `  ${bar}  ${this.theme.fg("muted", `${tally.completed}/${tally.total}`)} ${this.theme.fg("dim", `(${percent}%)`)}${note}`;
	}
}

/** Rank used by the Pending section — the same order the system prompt lists work in. */
function priorityRank(task: Task): number {
	return task.priority === "high" ? 0 : task.priority === "low" ? 2 : 1;
}
