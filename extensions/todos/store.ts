/**
 * File-backed task persistence.
 *
 * Three properties worth having before you change anything here:
 *
 * - **One writer at a time, across processes.** Several Pi sessions can point at
 *   the same file (`project` scope, or `PI_TODOS=sprint-1`), so every mutation
 *   takes a lock file, re-reads the record, applies, and writes it back through a
 *   temporary file plus rename. A lock left behind by a process that died is
 *   detected by pid and stolen, so a crashed session cannot wedge a task list
 *   forever.
 * - **A rejected mutation changes nothing on disk.** Dependencies are validated
 *   inside the transaction and the in-memory record is restored from the bytes
 *   that were read, so a cycle or a dangling reference cannot half-apply.
 * - **A file this build cannot read is preserved, not deleted.** A parse failure
 *   renames the file aside and says where it went; a field this build does not
 *   know (a status from a newer version) falls back to a safe default instead of
 *   failing the whole record.
 *
 * There is no operation-id ledger: nothing outside this extension writes the
 * file, so replay protection would be a second copy of the lock.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
	isTask,
	isOpen,
	TASK_PRIORITIES,
	TASK_STATUSES,
	type Task,
	type TaskPriority,
	type TaskStatus,
	type TaskStoreData,
} from "./types.js";

const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

/** Fields a caller may change in one update. `status: "deleted"` removes the task. */
export interface TaskUpdateFields {
	status?: TaskStatus | "deleted";
	content?: string;
	description?: string;
	priority?: TaskPriority;
	activeForm?: string;
	owner?: string;
	parentId?: string;
	/** Merge semantics: a `null` value deletes that key. */
	metadata?: Record<string, unknown>;
	addBlocks?: string[];
	addBlockedBy?: string[];
	removeBlocks?: string[];
	removeBlockedBy?: string[];
}

export interface CreateTaskOptions {
	description?: string;
	priority?: TaskPriority;
	activeForm?: string;
	owner?: string;
	parentId?: string;
	metadata?: Record<string, unknown>;
}

export interface UpdateResult {
	/** The task after the update, or undefined when it was deleted or never existed. */
	task: Task | undefined;
	/** Which fields actually moved. `"deleted"` for a removal; empty when the id was unknown. */
	changedFields: string[];
}

/** Thrown when the record on disk cannot be parsed; the bytes are kept. */
export class TaskStoreCorruptionError extends Error {
	readonly originalPath: string;
	readonly preservedPath: string;

	constructor(originalPath: string, preservedPath: string, options?: ErrorOptions) {
		super(`Task store is corrupt; preserved at ${preservedPath}`, options);
		this.name = "TaskStoreCorruptionError";
		this.originalPath = originalPath;
		this.preservedPath = preservedPath;
	}
}

function cloneTask(task: Task): Task {
	return structuredClone(task);
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Take the lock, or throw after ~5s of retries. Returns the releaser, which
 * tolerates a lock that vanished underneath it.
 */
async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
	for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
		try {
			const handle = await open(lockPath, "wx");
			await handle.writeFile(`${process.pid}`);
			await handle.sync();
			await handle.close();
			return async () => {
				try {
					await unlink(lockPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
			try {
				const pid = Number.parseInt(await readFile(lockPath, "utf8"), 10);
				if (pid && !isProcessRunning(pid)) {
					await unlink(lockPath);
					continue;
				}
			} catch (readError) {
				if ((readError as NodeJS.ErrnoException)?.code === "ENOENT") continue;
			}
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
	throw new Error(`Failed to acquire task lock: ${lockPath}`);
}

function pickStatus(value: unknown): TaskStatus {
	return TASK_STATUSES.includes(value as TaskStatus) ? (value as TaskStatus) : "pending";
}

function pickPriority(value: unknown): TaskPriority {
	return TASK_PRIORITIES.includes(value as TaskPriority) ? (value as TaskPriority) : "medium";
}

function stringOr(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberOr(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function idList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Collapse a task's own words onto one line. They are shown in single-line rows
 * everywhere — widget, tool result, system prompt — and a stored newline would
 * silently split one of those in two. `description` is exempt: it is prose, and
 * it is only ever shown on its own.
 */
function flatten(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ").trim();
}

/** Fill in whatever a hand-edited or newer-version record left out. */
function normalizeTask(raw: Task): Task {
	const task = cloneTask(raw);
	task.content = flatten(task.content ?? "");
	task.activeForm = task.activeForm === undefined ? undefined : flatten(task.activeForm) || undefined;
	task.owner = task.owner === undefined ? undefined : flatten(task.owner) || undefined;
	task.status = pickStatus(task.status);
	task.priority = pickPriority(task.priority);
	task.metadata =
		typeof task.metadata === "object" && task.metadata !== null ? (task.metadata as Record<string, unknown>) : {};
	task.blocks = idList(task.blocks);
	task.blockedBy = idList(task.blockedBy);
	const createdAt = numberOr(task.createdAt) ?? 0;
	task.createdAt = createdAt;
	task.updatedAt = numberOr(task.updatedAt) ?? createdAt;
	task.startedAt = numberOr(task.startedAt);
	task.completedAt = numberOr(task.completedAt);
	return task;
}

function optionalText(value: unknown, clean: (text: string) => string = (text) => text): string | undefined {
	const text = stringOr(value);
	const trimmed = text === undefined ? undefined : clean(text);
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export class TaskStore {
	private filePath: string | undefined;
	private lockPath: string | undefined;
	private nextId = 1;
	private tasks = new Map<string, Task>();
	/** Serialises mutations in this process; the lock file does the other ones. */
	private mutationQueue: Promise<void> = Promise.resolve();
	/** Set when the last read failed, so callers can report it once. */
	private loadError: Error | undefined;

	constructor(filePath?: string) {
		if (!filePath) return;
		mkdirSync(dirname(filePath), { recursive: true });
		this.filePath = filePath;
		this.lockPath = `${filePath}.lock`;
		this.load();
	}

	/** Undefined for an in-memory store. */
	get path(): string | undefined {
		return this.filePath;
	}

	/** The last read failure, if any: a corrupt record must be reported, not thrown from a hook. */
	get error(): Error | undefined {
		return this.loadError;
	}

	/**
	 * Re-read the file. Throws only when the bytes are unreadable — a store that
	 * was fine and then got corrupted must not look empty to the model.
	 */
	load(): void {
		if (!this.filePath || !existsSync(this.filePath)) {
			this.loadError = undefined;
			return;
		}
		try {
			this.applyData(JSON.parse(readFileSync(this.filePath, "utf8")) as TaskStoreData);
			this.loadError = undefined;
		} catch (cause) {
			const preservedPath = `${this.filePath}.corrupt-${Date.now()}`;
			try {
				// Only a file gets moved aside: a directory sitting where the store
				// belongs is the human's, and renaming it would look like data loss.
				if (lstatSync(this.filePath).isFile()) renameSync(this.filePath, preservedPath);
				else throw new Error(`Task store path is not a file: ${this.filePath}`);
			} catch {
				// Unreadable directory: report the corruption anyway, keep the bytes.
			}
			this.loadError = new TaskStoreCorruptionError(this.filePath, preservedPath, { cause });
			throw this.loadError;
		}
	}

	private applyData(data: TaskStoreData): void {
		if (!data || !Array.isArray(data.tasks) || !Number.isInteger(data.nextId)) {
			throw new Error("Invalid task store schema");
		}
		this.nextId = data.nextId;
		this.tasks.clear();
		for (const raw of data.tasks) {
			if (!isTask(raw)) throw new Error("Invalid task record");
			const task = normalizeTask(raw);
			this.tasks.set(task.id, task);
		}
		// A record written by another writer may have ids ahead of nextId.
		for (const task of this.tasks.values()) {
			const match = /^t(\d+)$/.exec(task.id);
			if (match) this.nextId = Math.max(this.nextId, Number.parseInt(match[1]!, 10) + 1);
		}
	}

	private data(): TaskStoreData {
		return { nextId: this.nextId, tasks: [...this.tasks.values()].map(cloneTask) };
	}

	private async save(): Promise<void> {
		if (!this.filePath) return;
		const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
		const payload = JSON.stringify(this.data(), null, 2);
		const handle = await open(temporaryPath, "w");
		try {
			await handle.writeFile(payload);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporaryPath, this.filePath);
		try {
			const directory = await open(dirname(this.filePath), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		} catch {
			// Directory fsync is unavailable on some platforms; the file is already renamed.
		}
	}

	/**
	 * Run one mutation under the lock. The record is re-read first, so a change
	 * made by another session is visible to this one, and rolled back to those
	 * bytes if the mutation throws.
	 */
	private async transaction<T>(mutation: () => T): Promise<T> {
		const job = this.mutationQueue.then(async () => {
			let release: () => Promise<void> = async () => {};
			try {
				release = this.lockPath ? await acquireLock(this.lockPath) : async () => {};
				if (this.filePath) this.load();
				const before = this.data();
				try {
					const value = mutation();
					this.validateDependencies();
					await this.save();
					return structuredClone(value);
				} catch (error) {
					// Roll the record back to the bytes this transaction read.
					this.applyData(before);
					throw error;
				}
			} finally {
				// Released before the caller's `await` resumes, so a caller that
				// finishes a write can rely on the lock being gone already.
				await release();
			}
		});
		// The chain only needs the ordering, not the value or the failure: each
		// caller has its own promise, and an unhandled rejection here is theirs.
		this.mutationQueue = job.then(
			() => undefined,
			() => undefined,
		);
		return job;
	}

	/** Every edge points at a live task, no task points at itself, and no edge is a cycle. */
	private validateDependencies(): void {
		for (const task of this.tasks.values()) {
			for (const targetId of task.blocks) {
				if (targetId === task.id) throw new Error(`#${task.id} cannot block itself`);
				if (!this.tasks.has(targetId)) throw new Error(`#${targetId} does not exist`);
			}
			for (const blockerId of task.blockedBy) {
				if (blockerId === task.id) throw new Error(`#${task.id} cannot be blocked by itself`);
				if (!this.tasks.has(blockerId)) throw new Error(`#${blockerId} does not exist`);
			}
		}

		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (id: string): void => {
			if (visiting.has(id)) throw new Error(`Dependency cycle includes #${id}`);
			if (visited.has(id)) return;
			visiting.add(id);
			for (const target of this.tasks.get(id)?.blocks ?? []) visit(target);
			visiting.delete(id);
			visited.add(id);
		};
		for (const id of this.tasks.keys()) visit(id);

		// A parent cycle would hide every task in it: the viewer renders children
		// under their parent, and a cycle has no top-level entry to hang it on.
		for (const task of this.tasks.values()) {
			const chain = new Set<string>([task.id]);
			let parent = task.parentId;
			while (parent) {
				if (chain.has(parent)) throw new Error(`Parent cycle includes #${task.id}`);
				chain.add(parent);
				parent = this.tasks.get(parent)?.parentId;
			}
		}
	}

	/** Tasks that could be started right now: pending, nothing open blocking them. */
	readyTasks(): Task[] {
		return this.list().filter((task) => {
			if (task.status !== "pending") return false;
			return task.blockedBy.every((id) => this.tasks.get(id)?.status === "completed");
		});
	}

	activeTasks(): Task[] {
		return this.list().filter(isOpen);
	}

	get(id: string): Task | undefined {
		this.refresh();
		const task = this.tasks.get(id);
		return task ? cloneTask(task) : undefined;
	}

	list(): Task[] {
		this.refresh();
		return [...this.tasks.values()].map(cloneTask);
	}

	/** Re-read unless the only thing in flight is another read; cheap for a small file. */
	private refresh(): void {
		if (!this.filePath) return;
		try {
			this.load();
		} catch {
			// Keep serving the last good record; `error` carries the report.
		}
	}

	async create(content: string, options?: CreateTaskOptions): Promise<Task> {
		return this.transaction(() => this.createUnlocked(content, options));
	}

	/** One transaction for a batch, so a plan written in one call cannot interleave with another session's. */
	async createMany(items: Array<{ content: string; options?: CreateTaskOptions }>): Promise<Task[]> {
		return this.transaction(() => items.map((item) => this.createUnlocked(item.content, item.options)));
	}

	private createUnlocked(content: string, options?: CreateTaskOptions): Task {
		if (options?.parentId && !this.tasks.has(options.parentId)) {
			throw new Error(`Parent task #${options.parentId} does not exist`);
		}
		const now = Date.now();
		const task: Task = {
			id: `t${this.nextId++}`,
			content: flatten(content),
			description: optionalText(options?.description),
			status: "pending",
			priority: options?.priority ?? "medium",
			activeForm: optionalText(options?.activeForm, flatten),
			owner: optionalText(options?.owner, flatten),
			parentId: options?.parentId,
			metadata: options?.metadata ? structuredClone(options.metadata) : {},
			blocks: [],
			blockedBy: [],
			createdAt: now,
			updatedAt: now,
		};
		this.tasks.set(task.id, task);
		return task;
	}

	async update(id: string, fields: TaskUpdateFields): Promise<UpdateResult> {
		return this.transaction(() => this.updateUnlocked(id, fields));
	}

	private updateUnlocked(id: string, fields: TaskUpdateFields): UpdateResult {
		const task = this.tasks.get(id);
		if (!task) return { task: undefined, changedFields: [] };
		if (fields.status === "deleted") {
			this.deleteUnlocked(id);
			return { task: undefined, changedFields: ["deleted"] };
		}

		if (fields.parentId !== undefined) {
			if (fields.parentId === id) throw new Error(`#${id} cannot be its own parent`);
			if (!this.tasks.has(fields.parentId)) throw new Error(`Parent task #${fields.parentId} does not exist`);
		}

		// A parent that says "done" while its subtasks are open makes the whole list
		// untrustworthy, so this is the one status change the store refuses.
		if (fields.status === "completed") {
			const open = [...this.tasks.values()]
				.filter((child) => child.parentId === id && isOpen(child))
				.map((child) => `#${child.id}`);
			if (open.length > 0) throw new Error(`#${id} has open subtasks: ${open.join(", ")}`);
		}

		const changed: string[] = [];
		const now = Date.now();

		if (fields.status !== undefined && fields.status !== task.status) {
			const status = fields.status;
			if (task.status !== "in_progress" && status === "in_progress") task.startedAt = now;
			if (task.status !== "completed" && status === "completed") {
				task.startedAt ??= now;
				task.completedAt = now;
			}
			if (status !== "completed") task.completedAt = undefined;
			task.status = status;
			changed.push("status");
		}

		for (const key of ["content", "description", "priority", "activeForm", "owner", "parentId"] as const) {
			const value = fields[key];
			if (value !== undefined && (task as unknown as Record<string, unknown>)[key] !== value) {
				(task as unknown as Record<string, unknown>)[key] = value;
				changed.push(key);
			}
		}

		if (fields.metadata) {
			let touched = false;
			for (const [key, value] of Object.entries(fields.metadata)) {
				if (value === null) {
					if (key in task.metadata) {
						delete task.metadata[key];
						touched = true;
					}
				} else if (task.metadata[key] !== value) {
					task.metadata[key] = value;
					touched = true;
				}
			}
			if (touched) changed.push("metadata");
		}

		let edges = false;
		for (const targetId of fields.addBlocks ?? []) edges = this.addEdge(id, targetId) || edges;
		for (const blockerId of fields.addBlockedBy ?? []) edges = this.addEdge(blockerId, id) || edges;
		for (const targetId of fields.removeBlocks ?? []) edges = this.removeEdge(id, targetId) || edges;
		for (const blockerId of fields.removeBlockedBy ?? []) edges = this.removeEdge(blockerId, id) || edges;
		if (edges) changed.push("blocks", "blockedBy");

		task.updatedAt = now;
		return { task: cloneTask(task), changedFields: changed };
	}

	/**
	 * Edges are bidirectional: one caller states the dependency, both tasks show
	 * it. Returns whether anything moved, so a repeat call is not reported as a
	 * change the model then has to wonder about.
	 */
	private addEdge(blockerId: string, blockedId: string): boolean {
		if (blockerId === blockedId) throw new Error(`#${blockerId} cannot block itself`);
		const blocker = this.tasks.get(blockerId);
		const blocked = this.tasks.get(blockedId);
		if (!blocker) throw new Error(`#${blockerId} does not exist`);
		if (!blocked) throw new Error(`#${blockedId} does not exist`);
		if (!blocker.blocks.includes(blockedId)) blocker.blocks.push(blockedId);
		const added = !blocker.blocks.includes(blockedId) || !blocked.blockedBy.includes(blockerId);
		if (!blocker.blocks.includes(blockedId)) blocker.blocks.push(blockedId);
		if (!blocked.blockedBy.includes(blockerId)) blocked.blockedBy.push(blockerId);
		return added;
	}

	/** Removal is equally two-sided — a half-removed edge still blocks the work. */
	private removeEdge(blockerId: string, blockedId: string): boolean {
		if (!this.tasks.has(blockerId)) throw new Error(`#${blockerId} does not exist`);
		if (!this.tasks.has(blockedId)) throw new Error(`#${blockedId} does not exist`);
		const blocker = this.tasks.get(blockerId)!;
		const blocked = this.tasks.get(blockedId)!;
		const present = blocker.blocks.includes(blockedId) || blocked.blockedBy.includes(blockerId);
		blocker.blocks = blocker.blocks.filter((other) => other !== blockedId);
		blocked.blockedBy = blocked.blockedBy.filter((other) => other !== blockerId);
		return present;
	}

	async delete(id: string): Promise<boolean> {
		return this.transaction(() => this.deleteUnlocked(id));
	}

	private deleteUnlocked(id: string): boolean {
		if (!this.tasks.delete(id)) return false;
		for (const task of this.tasks.values()) {
			task.blocks = task.blocks.filter((other) => other !== id);
			task.blockedBy = task.blockedBy.filter((other) => other !== id);
		}
		return true;
	}

	async clearAll(): Promise<number> {
		return this.transaction(() => {
			const count = this.tasks.size;
			this.tasks.clear();
			return count;
		});
	}

	async clearCompleted(): Promise<number> {
		return this.transaction(() => {
			const ids = [...this.tasks.values()].filter((task) => task.status === "completed").map((task) => task.id);
			for (const id of ids) this.deleteUnlocked(id);
			return ids.length;
		});
	}

	/**
	 * Drop the file once the list is empty, so a per-session scope does not leave
	 * an empty record for every session ever run. In-memory stores have no file.
	 */
	deleteFileIfEmpty(): boolean {
		if (!this.filePath || this.list().length > 0) return false;
		try {
			unlinkSync(this.filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
		}
		return true;
	}

	/** Wait for in-flight writes, then remove a lock this process still holds. */
	async cleanup(): Promise<void> {
		await this.mutationQueue;
		if (!this.lockPath || !existsSync(this.lockPath)) return;
		try {
			const pid = Number.parseInt(readFileSync(this.lockPath, "utf8"), 10);
			if (pid === process.pid) unlinkSync(this.lockPath);
		} catch {
			// Best-effort: a lock we cannot read is not ours to remove.
		}
	}
}
