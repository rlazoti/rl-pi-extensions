/**
 * The shape of a task, and the two vocabularies attached to it.
 *
 * `parentId` is the only hierarchy this keeps: a subtask is a task with a parent,
 * and the viewer and the store both render one level of it. Statuses are what an
 * agent reports about its own work, so `blocked` means "I cannot finish this
 * yet" — it does not mean "waiting on another task", which is what `blockedBy`
 * is for.
 */

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "failed" | "cancelled";

export type TaskPriority = "high" | "medium" | "low";

/**
 * Where the task list lives. `memory` keeps it in the process only; `session`
 * gives every session its own file; `project` shares one file across them.
 */
export type TaskScope = "memory" | "session" | "project";

export const TASK_SCOPES: readonly TaskScope[] = ["memory", "session", "project"];

/** Everything the store knows about one task. */
export interface Task {
	id: string;
	/** Imperative title, the only required field. */
	content: string;
	description?: string;
	status: TaskStatus;
	priority: TaskPriority;
	/** Spinner text while in_progress (e.g. "Running tests"). */
	activeForm?: string;
	/** Who is working on it, shown in the widget only when set. */
	owner?: string;
	/** Set when this task is a subtask of another one. */
	parentId?: string;
	/** Free-form notes; `null` values in an update delete the key. */
	metadata: Record<string, unknown>;
	/** Task IDs that cannot start until this one completes. */
	blocks: string[];
	/** Task IDs that must complete before this one can start. */
	blockedBy: string[];
	createdAt: number;
	updatedAt: number;
	startedAt?: number;
	completedAt?: number;
}

/** On-disk format. `nextId` is part of the record, not derived, so ids are never reused. */
export interface TaskStoreData {
	nextId: number;
	tasks: Task[];
}

/** What the tools render and the system prompt lists with. */
export interface TaskDetails {
	tasks: Task[];
}

export const TASK_STATUSES: readonly TaskStatus[] = [
	"pending",
	"in_progress",
	"completed",
	"blocked",
	"failed",
	"cancelled",
];

export const TASK_PRIORITIES: readonly TaskPriority[] = ["high", "medium", "low"];

/** Sort order for "work the model should look at first". */
export const PRIORITY_ORDER: Record<TaskPriority, number> = {
	high: 0,
	medium: 1,
	low: 2,
};

/** A task that is not finished in any sense, so it still takes up a line. */
export function isOpen(task: Task): boolean {
	return task.status !== "completed" && task.status !== "cancelled";
}

export function isTask(value: unknown): value is Task {
	if (typeof value !== "object" || value === null) return false;
	const task = value as Partial<Task>;
	return typeof task.id === "string" && typeof task.content === "string";
}
