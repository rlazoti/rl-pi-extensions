/**
 * Turn-based clearing of finished tasks.
 *
 * A completed task is useful for exactly one thing: showing that the plan is
 * being executed. Left forever it becomes a wall of struck-through text that
 * pushes the open work off the panel and back into the model's context, so the
 * list clears itself a few turns after finishing.
 *
 * "Turns" are counted by the extension, not the clock — a task that finished
 * while nobody was looking should still be visible when the human comes back, and
 * a timer would clear it mid-thought.
 *
 * - `never` — keep everything until it is cleared by hand.
 * - `on_list_complete` — the countdown starts when the *last* task finishes, so a
 *   plan is visible whole while it is being executed.
 * - `on_task_complete` — each task has its own countdown, which suits a running
 *   list that new tasks keep arriving in.
 */

import type { TaskStore } from "./store.js";

export type AutoClearMode = "never" | "on_list_complete" | "on_task_complete";

export const AUTO_CLEAR_MODES: readonly AutoClearMode[] = [
	"never",
	"on_list_complete",
	"on_task_complete",
];

export function isAutoClearMode(value: unknown): value is AutoClearMode {
	return AUTO_CLEAR_MODES.includes(value as AutoClearMode);
}

export class AutoClear {
	/** Turn each completed task was finished on, for `on_task_complete`. */
	private completedAtTurn = new Map<string, number>();
	/** Turn the last open task finished on, for `on_list_complete`. */
	private allCompletedAtTurn: number | null = null;

	private readonly getStore: () => TaskStore;
	private readonly getMode: () => AutoClearMode;
	private readonly delayTurns: number;

	constructor(
		getStore: () => TaskStore,
		getMode: () => AutoClearMode,
		/** Turns a finished task lingers before it is removed. */
		delayTurns = 4,
	) {
		this.getStore = getStore;
		this.getMode = getMode;
		this.delayTurns = Math.max(1, delayTurns);
	}

	/** Note a completion. Call after a status change to completed, or a stop. */
	trackCompletion(taskId: string, currentTurn: number): void {
		const mode = this.getMode();
		if (mode === "never") return;
		if (mode === "on_task_complete") {
			this.completedAtTurn.set(taskId, currentTurn);
			return;
		}
		this.checkAllCompleted(currentTurn);
	}

	/** A new task means the plan is open again, so the batch countdown restarts. */
	resetBatchCountdown(): void {
		this.allCompletedAtTurn = null;
	}

	/** Forget everything (new session). */
	reset(): void {
		this.completedAtTurn.clear();
		this.allCompletedAtTurn = null;
	}

	/** Test seam: the countdowns as they stand. */
	get state(): { perTask: Array<[string, number]>; allCompletedAtTurn: number | null } {
		return { perTask: [...this.completedAtTurn.entries()], allCompletedAtTurn: this.allCompletedAtTurn };
	}

	/**
	 * Called at each turn start. Returns true when something was removed, so the
	 * caller knows to repaint the widget.
	 */
	async onTurnStart(currentTurn: number): Promise<boolean> {
		const mode = this.getMode();
		if (mode === "never") return false;
		let cleared = false;

		if (mode === "on_task_complete") {
			for (const [taskId, turn] of [...this.completedAtTurn]) {
				const store = this.getStore();
				const task = store.get(taskId);
				if (!task || task.status !== "completed") {
					this.completedAtTurn.delete(taskId);
				} else if (currentTurn - turn >= this.delayTurns) {
					await store.delete(taskId);
					this.completedAtTurn.delete(taskId);
					cleared = true;
				}
			}
			return cleared;
		}

		if (this.allCompletedAtTurn === null) this.checkAllCompleted(currentTurn);
		if (this.allCompletedAtTurn === null) return false;
		if (currentTurn - this.allCompletedAtTurn >= this.delayTurns) {
			await this.getStore().clearCompleted();
			this.allCompletedAtTurn = null;
			cleared = true;
		}
		return cleared;
	}

	private checkAllCompleted(currentTurn: number): void {
		const tasks = this.getStore().list();
		const allDone = tasks.length > 0 && tasks.every((task) => task.status === "completed");
		this.allCompletedAtTurn = allDone ? (this.allCompletedAtTurn ?? currentTurn) : null;
	}
}
