/**
 * The live task list above the editor.
 *
 * Thin on purpose: the text comes from `render.ts`, so the widget is only about
 * lifecycle — registering once, repainting on change, animating while something
 * is actually running, and removing itself when the list is empty so a finished
 * plan never leaves a stray row above the prompt.
 *
 * Two details that are easy to get wrong and are tested:
 *
 * - **The 200 ms timer only runs while a spinner is visible.** A timer that ticks
 *   forever repaints the terminal in an idle session and keeps the process busy
 *   for a list that is not moving.
 * - **Elapsed time comes from the task, not from when the widget noticed.** A
 *   session that is reloaded or resumed mid-task must keep showing the real
 *   elapsed time, not restart at zero.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { widgetLines, themePaint } from "./render.js";
import type { TaskStore } from "./store.js";

/** Widget slot. Namespaced so two extensions cannot overwrite each other's row. */
export const WIDGET_KEY = "rl-todos";

const TICK_MS = 200;

export class TaskWidget {
	private readonly getStore: () => TaskStore;
	private readonly intervalMs: number;
	private uiCtx: ExtensionUIContext | undefined;
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private activeIds = new Set<string>();
	private startedAt = new Map<string, number>();
	private tui: TUI | undefined;
	private registered = false;

	constructor(getStore: () => TaskStore, intervalMs = TICK_MS) {
		this.getStore = getStore;
		this.intervalMs = Math.max(50, intervalMs);
	}

	setUICtx(uiCtx: ExtensionUIContext): void {
		this.uiCtx = uiCtx;
	}

	/** Mark a task as the one being worked on (or stop marking it). */
	setActiveTask(taskId: string | undefined, active = true): void {
		if (!taskId) return;
		if (active) {
			this.activeIds.add(taskId);
			if (!this.startedAt.has(taskId)) {
				const task = this.getStore().get(taskId);
				this.startedAt.set(taskId, task?.startedAt ?? Date.now());
			}
		} else {
			this.activeIds.delete(taskId);
			this.startedAt.delete(taskId);
		}
		this.update();
	}

	/** Test seam: which tasks are showing a spinner right now. */
	get activeTaskIds(): string[] {
		return [...this.activeIds];
	}

	/** Test seam: whether the animation timer is running. */
	get isAnimating(): boolean {
		return this.timer !== undefined;
	}

	/** Repaint, and start or stop the animation to match what is on screen. */
	update(): void {
		if (!this.uiCtx) return;
		const store = this.getStore();
		const tasks = store.list();
		this.pruneActive(tasks.map((task) => [task.id, task.status] as const));

		if (tasks.length === 0) {
			this.stopAnimation();
			if (this.registered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.registered = false;
				this.tui = undefined;
			}
			return;
		}

		const animating = tasks.some((task) => this.activeIds.has(task.id) && task.status === "in_progress");
		if (animating && !this.timer) {
			this.timer = setInterval(() => {
				this.frame++;
				this.repaint();
			}, this.intervalMs);
			// A background animation must never be the reason a process cannot exit.
			this.timer.unref?.();
		} else if (!animating) {
			this.stopAnimation();
		}

		if (!this.registered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) =>
							widgetLines(store.list(), {
								paint: themePaint(theme),
								width,
								frame: this.frame,
								activeIds: this.activeIds,
								startedAt: this.startedAt,
							}),
						invalidate: () => {},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.registered = true;
		} else {
			this.repaint();
		}
	}

	private repaint(): void {
		try {
			this.tui?.requestRender();
		} catch {
			// A host that refuses a repaint is not a reason to fail a tool call.
		}
	}

	/** Drop spinners whose tasks finished, were deleted, or are no longer in progress. */
	private pruneActive(statuses: ReadonlyArray<readonly [string, string]>): void {
		const live = new Map(statuses);
		for (const id of [...this.activeIds]) {
			if (live.get(id) !== "in_progress") {
				this.activeIds.delete(id);
				this.startedAt.delete(id);
			}
		}
	}

	private stopAnimation(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Forget everything and take the row away (session shutdown). */
	dispose(): void {
		this.stopAnimation();
		this.uiCtx?.setWidget(WIDGET_KEY, undefined);
		this.registered = false;
		this.tui = undefined;
		this.activeIds.clear();
		this.startedAt.clear();
	}
}
