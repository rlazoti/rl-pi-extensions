/**
 * todos — a task list the agent keeps, and shows you.
 *
 * The failure this exists for is goal drift: a long session accumulates tool
 * calls, the original plan stops being the thing the model is reacting to, and it
 * finishes something adjacent. A list the model writes, that is put back in front
 * of it every turn, and that the human can see above the editor, keeps the plan in
 * the context instead of only in the history.
 *
 * ## What is wired where
 *
 * - `store.ts` owns the file, the lock and the dependency rules. Nothing else
 *   writes a task.
 * - `render.ts` owns the text of a task line, so the widget, the tool results and
 *   the system-prompt block cannot disagree about what a row means.
 * - `viewer.ts` owns the panel's keys and geometry, and asks for writes instead of
 *   making them.
 * - This file owns the session: which store is open, when the counters move, what
 *   gets injected into the prompt, and what the four tools answer.
 *
 * ## Two rules the hooks follow
 *
 * - **A broken task list must not break the session.** A corrupt file, an unwritable
 *   directory or a refused store never propagates out of a hook: the list falls
 *   back to memory for the session and the problem is reported once.
 * - **Injection is bounded.** The system-prompt block lists open work only, and the
 *   nudge rides along at most once per quiet period — a reminder every turn is
 *   noise the model learns to ignore, and it costs tokens on every request.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { AutoClear, type AutoClearMode } from "./auto-clear.js";
import {
	AUTO_CLEAR_DELAY_TURNS,
	loadTodoConfig,
	REMINDER_INTERVAL_TURNS,
	resolveStorePath,
	saveTodoConfig,
	type TaskScope,
} from "./config.js";
import { listForLLM, systemPromptBlock, taskDetailText, themePaint, toolResultText } from "./render.js";
import { PLAN_NUDGE_REMINDER, PLAN_NUDGE_THRESHOLD, PlanNudge } from "./plan-nudge.js";
import { TaskStore, type TaskUpdateFields } from "./store.js";
import {
	TASK_PRIORITIES,
	TASK_STATUSES,
	type Task,
	type TaskDetails,
	type TaskPriority,
	type TaskStatus,
} from "./types.js";
import { PANEL_HEIGHT_PERCENT, TaskViewer, type TaskAction, type TaskViewerResult } from "./viewer.js";
import { TaskWidget } from "./widget.js";

const TOOL_NAMES = new Set(["TodoCreate", "TodoList", "TodoGet", "TodoUpdate"]);

const REMINDER = `<system-reminder>
Task tools have not been used recently. If this work would benefit from tracking, use TodoCreate to plan the remaining steps and TodoUpdate to move a task to in_progress before starting it and completed once it is fully done. Consider clearing a task list that no longer reflects the work. Only use these if relevant to the current work — never mention this reminder to the user.
</system-reminder>`;

// ── Parameter schemas ─────────────────────────────────────────────────────────

/** An enum without importing a validator: the schema is the contract, the type is local. */
function enumField<Value extends string>(values: readonly Value[], description: string) {
	return Type.Unsafe<Value>({ type: "string", enum: [...values], description });
}

const CreateItem = Type.Object({
	content: Type.String({
		description: "A brief, actionable title in imperative form, e.g. 'Fix the auth bug in the login flow'.",
	}),
	description: Type.Optional(
		Type.String({ description: "What needs doing, including context and acceptance criteria." }),
	),
	priority: Type.Optional(enumField(TASK_PRIORITIES, "Priority. Defaults to 'medium'.")),
	activeForm: Type.Optional(
		Type.String({ description: "Present-continuous text for the spinner, e.g. 'Fixing the auth bug'." }),
	),
	parentId: Type.Optional(Type.String({ description: "Parent task id — makes this a subtask of it." })),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary key-value notes." })),
});

const CreateParams = Type.Object({
	tasks: Type.Optional(
		Type.Array(CreateItem, {
			description: "Create several tasks in one call. When present, the top-level fields below are ignored.",
		}),
	),
	content: Type.Optional(CreateItem.properties.content),
	description: Type.Optional(CreateItem.properties.description),
	priority: Type.Optional(CreateItem.properties.priority),
	activeForm: Type.Optional(CreateItem.properties.activeForm),
	parentId: Type.Optional(CreateItem.properties.parentId),
	metadata: Type.Optional(CreateItem.properties.metadata),
});

const GetParams = Type.Object({ id: Type.String({ description: "The task id to retrieve." }) });

const UpdateParams = Type.Object({
	id: Type.String({ description: "The task id to update." }),
	status: Type.Optional(
		enumField([...TASK_STATUSES, "deleted"] as const, "New status. 'deleted' removes the task permanently."),
	),
	content: Type.Optional(Type.String({ description: "New title." })),
	description: Type.Optional(Type.String({ description: "New description." })),
	priority: Type.Optional(enumField(TASK_PRIORITIES, "New priority.")),
	activeForm: Type.Optional(Type.String({ description: "Spinner text while in_progress." })),
	owner: Type.Optional(Type.String({ description: "Who is working on it." })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Any(), { description: "Merged in. Set a key to null to delete it." }),
	),
	addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Ids that cannot start until this completes." })),
	addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Ids that must complete before this can start." })),
	removeBlocks: Type.Optional(Type.Array(Type.String(), { description: "Drop these links from addBlocks." })),
	removeBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Drop these links from addBlockedBy." })),
});

type CreateInput = {
	tasks?: Array<{
		content: string;
		description?: string;
		priority?: TaskPriority;
		activeForm?: string;
		parentId?: string;
		metadata?: Record<string, unknown>;
	}>;
	content?: string;
	description?: string;
	priority?: TaskPriority;
	activeForm?: string;
	parentId?: string;
	metadata?: Record<string, unknown>;
};

// ── Extension ────────────────────────────────────────────────────────────────

export default function todosExtension(pi: ExtensionAPI): void {
	let cwd = process.cwd();
	let config = loadTodoConfig(cwd);
	let store = new TaskStore();
	/** The store this session asked for, so a repeated hook does not reopen it. */
	let openedFor: string | undefined;
	/** A storage problem worth telling the human about, once per message. */
	let problem: string | undefined;
	const reported = new Set<string>();

	const widget = new TaskWidget(() => store);
	const autoClear = new AutoClear(
		() => store,
		() => config.autoClearCompleted ?? "on_list_complete",
		AUTO_CLEAR_DELAY_TURNS,
	);
	/** Asks once when file-changing tools start with no task list (`plan-nudge.ts`). */
	const planNudge = new PlanNudge();

	let turn = 0;
	let lastTaskToolTurn = 0;
	let reminderShown = false;

	function report(uiCtx: ExtensionUIContext, message: string): void {
		if (reported.has(message)) return;
		reported.add(message);
		try {
			uiCtx.notify(message, "warning");
		} catch {
			// A host with no notification channel is not a reason to fail a hook.
		}
	}

	/**
	 * Point at the file this session should use. A store that cannot be opened
	 * becomes an in-memory list plus one report: the session keeps working, it just
	 * does not persist.
	 */
	function openStore(sessionId: string | undefined): void {
		const path = resolveStorePath({ cwd, sessionId, config, env: process.env });
		const key = `${sessionId ?? "no-session"}\u0000${path ?? "memory"}`;
		if (openedFor === key) return;
		openedFor = key;
		widget.setActiveTask(undefined, false);
		autoClear.reset();
		if (!path) {
			store = new TaskStore();
			problem = undefined;
			return;
		}
		try {
			store = new TaskStore(path);
			problem = store.error?.message;
		} catch (error) {
			store = new TaskStore();
			problem = `tasks are in memory this session: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	/** Refresh cwd/config from the host — that is where a `/cd` or a resumed session shows up. */
	function readContext(ctx: ExtensionContext): void {
		cwd = ctx.cwd;
		config = loadTodoConfig(cwd);
		widget.setUICtx(ctx.ui);
		openStore(sessionIdOf(ctx));
		if (problem) report(ctx.ui, problem);
	}

	/** The live session id, when the host is willing to say it. */
	function sessionIdOf(ctx: ExtensionCommandContext | { sessionManager?: { getSessionId?(): string } }): string | undefined {
		try {
			return ctx.sessionManager?.getSessionId?.();
		} catch {
			return undefined;
		}
	}

	function details(): TaskDetails {
		return { tasks: store.list() };
	}

	function text(message: string, taskDetails: TaskDetails = details()) {
		return {
			content: [{ type: "text" as const, text: message }],
			details: taskDetails,
		};
	}

	/**
	 * A refused rule is an answer, not a crash. The store throws for a cycle, a
	 * dangling id, or a parent with open subtasks; the model reads the reason and
	 * fixes it, instead of getting a stack trace in a tool result.
	 */
	async function attempt<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
		try {
			return { ok: true, value: await run() };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	/** One place for both writers (tools and panel) so a change cannot half-happen. */
	async function applyAction(task: Task | undefined, action: TaskAction): Promise<string> {
		if (action === "clear_completed") {
			const cleared = await store.clearCompleted();
			store.deleteFileIfEmpty();
			widget.update();
			return cleared > 0 ? `cleared ${cleared} completed task${cleared === 1 ? "" : "s"}` : "no completed tasks to clear";
		}
		if (!task) throw new Error("no task selected");

		const fields: TaskUpdateFields = {};
		switch (action) {
			case "start":
				fields.status = "in_progress";
				break;
			case "complete":
				fields.status = "completed";
				break;
			case "block":
				fields.status = "blocked";
				break;
			case "delete":
				fields.status = "deleted";
				break;
		}
		const result = await store.update(task.id, fields);
		if (result.changedFields.length === 0) throw new Error(`#${task.id} no longer exists`);

		if (action === "start") {
			widget.setActiveTask(task.id, true);
			autoClear.resetBatchCountdown();
		} else if (action === "complete") {
			widget.setActiveTask(task.id, false);
			autoClear.trackCompletion(task.id, turn);
		} else {
			widget.setActiveTask(task.id, false);
		}
		widget.update();
		return action === "delete" ? `deleted #${task.id}` : `#${task.id} → ${fields.status}`;
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	pi.on("session_start", async (event, ctx) => {
		cwd = ctx.cwd;
		config = loadTodoConfig(cwd);
		turn = 0;
		lastTaskToolTurn = 0;
		reminderShown = false;
		planNudge.reset(config.planNudge !== false);
		reported.clear();
		openedFor = undefined;
		openStore(sessionIdOf(ctx));
		autoClear.reset();
		widget.setUICtx(ctx.ui);
		// A memory-scoped list from a previous session is not this session's work.
		if (event.reason !== "resume" && !store.path) await store.clearAll();
		if (problem) report(ctx.ui, problem);
		widget.update();
	});

	pi.on("turn_start", async (_event, ctx) => {
		turn++;
		readContext(ctx);
		if (await autoClear.onTurnStart(turn)) widget.update();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		readContext(ctx);
		const block = systemPromptBlock(store.list());
		if (!block) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
	});

	pi.on("agent_end", async (_event, ctx) => {
		widget.setUICtx(ctx.ui);
		widget.update();
	});

	pi.on("session_tree", async (_event, ctx) => {
		widget.setUICtx(ctx.ui);
		widget.update();
	});

	pi.on("session_shutdown", async () => {
		widget.dispose();
		await store.cleanup();
	});

	/**
	 * The two reminders. Both ride on a tool result rather than being sent as
	 * their own message, so they cost nothing when no tool is running, and a
	 * result carries at most one of them: the plan nudge speaks to an empty list,
	 * the quiet-turns reminder to a non-empty one, so they cannot both be due.
	 *
	 * - The plan nudge asks once when file-changing tools start with no list —
	 *   the case the injected block and the quiet-turns reminder both stay silent
	 *   about (`plan-nudge.ts`).
	 * - The quiet-turns reminder waits `REMINDER_INTERVAL_TURNS` turns without a
	 *   task tool call, and only speaks when there is a list to come back to.
	 */
	pi.on("tool_result", async (event) => {
		if (TOOL_NAMES.has(event.toolName)) {
			lastTaskToolTurn = turn;
			reminderShown = false;
			return undefined;
		}
		const hasTasks = store.list().length > 0;
		const plan = planNudge.note(event.toolName, hasTasks, turn);
		if (plan) return { content: [...event.content, { type: "text" as const, text: PLAN_NUDGE_REMINDER }] };
		if (reminderShown || !hasTasks || turn - lastTaskToolTurn < REMINDER_INTERVAL_TURNS) return undefined;
		reminderShown = true;
		lastTaskToolTurn = turn;
		return { content: [...event.content, { type: "text" as const, text: REMINDER }] };
	});

	// ── Tools ─────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "TodoCreate",
		label: "TodoCreate",
		description: `Use TodoCreate to plan multi-step work — one task per step. Use it when there are 3+ distinct steps, the user asked for a plan, several tasks were handed over at once, or new instructions arrived mid-run. Skip it for one-off or conversational work.

Pass \`tasks: [...]\` to create several in one call — do not call this tool repeatedly:
\`\`\`json
{ "tasks": [ { "content": "Add the migration" }, { "content": "Update the tests", "priority": "high" } ] }
\`\`\`
For one task, pass the fields at the top level. Fields: content (imperative title), description (context and acceptance criteria), priority (high/medium/low), activeForm (spinner text while in_progress), parentId (makes this a subtask). Tasks start as pending.

Check TodoList first to avoid duplicates; wire dependencies afterwards with TodoUpdate.`,
		promptGuidelines: [
			"Use TodoCreate to plan multi-step work, TodoUpdate to move a task to in_progress before starting it and to completed once it is fully done.",
			"Create several tasks in one TodoCreate call via tasks[], never one call per task.",
			"After completing a task, call TodoList to see what the completion unblocked.",
		],
		parameters: CreateParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			widget.setUICtx(ctx.ui);
			const input = params as CreateInput;
			const items = input.tasks;

			if (items && items.length > 0) {
				const invalid = items.findIndex((item) => item.content === undefined || item.content.trim() === "");
				if (invalid >= 0) return text(`tasks[${invalid}] needs a non-empty content field.`);
				const outcome = await attempt(() =>
					store.createMany(
						items.map((item) => ({
							content: item.content.trim(),
							options: {
								description: item.description,
								priority: item.priority,
								activeForm: item.activeForm,
								parentId: item.parentId,
								metadata: item.metadata,
							},
						})),
					),
				);
				if (!outcome.ok) return text(`TodoCreate: ${outcome.message}`);
				const created = outcome.value;
				autoClear.resetBatchCountdown();
				widget.update();
				const summary = created.map((task) => `#${task.id}: ${task.content}`).join(", ");
				return text(`Created ${created.length} task${created.length === 1 ? "" : "s"} — ${summary}`);
			}

			const content = input.content?.trim();
			if (!content) {
				return text("TodoCreate needs either a tasks[] array or a top-level content field.");
			}
			const outcome = await attempt(() =>
				store.create(content, {
					description: input.description,
					priority: input.priority,
					activeForm: input.activeForm,
					parentId: input.parentId,
					metadata: input.metadata,
				}),
			);
			if (!outcome.ok) return text(`TodoCreate: ${outcome.message}`);
			const task = outcome.value;
			autoClear.resetBatchCountdown();
			widget.update();
			return text(`Created #${task.id}: ${task.content}`);
		},

		renderCall(args, theme) {
			const items = (args as CreateInput).tasks;
			if (items && items.length > 0) {
				const preview = items
					.slice(0, 3)
					.map((item) => item.content ?? "")
					.filter(Boolean)
					.join(", ");
				const extra = items.length > 3 ? ` +${items.length - 3} more` : "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("TodoCreate "))}${theme.fg("dim", `[${items.length}]`)}  ${theme.fg("muted", preview + extra)}`,
					0,
					0,
				);
			}
			const input = args as CreateInput;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("TodoCreate "))}  ${theme.fg("muted", input.content ?? "")}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			return renderDetails(result.details as TaskDetails | undefined, expanded, theme);
		},
	});

	pi.registerTool({
		name: "TodoList",
		label: "TodoList",
		description: `List the task list with status, priority and dependencies.

Use it to see what is ready to start, check progress, find work that needs a decision, or see what finishing a task unblocked. Work tasks in id order (lowest first) unless a priority says otherwise.

Each line: [status] [priority] #id title, plus [blocked by #id] for open blockers and [ready] for pending work nobody is waiting on. Use TodoGet for one task's full detail.`,
		promptSnippet: "List the task list with status, priority and dependency info",
		parameters: Type.Object({}),

		async execute() {
			const tasks = store.list();
			if (tasks.length === 0) return text("No tasks. Use TodoCreate when the work has several distinct steps.", { tasks: [] });
			return text(listForLLM(tasks), { tasks });
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("TodoList")), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			return renderDetails(result.details as TaskDetails | undefined, expanded, theme);
		},
	});

	pi.registerTool({
		name: "TodoGet",
		label: "TodoGet",
		description: `Read one task in full: description, dependencies, owner, metadata, elapsed time.

Use it before starting assigned work, or to check what a task blocks. Verify its open blockers are gone before starting. Use TodoList for the summary.`,
		promptSnippet: "Read one task's full detail, including description and dependencies",
		parameters: GetParams,

		async execute(_id, params) {
			const task = store.get(params.id);
			if (!task) return text(`No task #${params.id}. Call TodoList for the current ids.`, { tasks: [] });
			return text(taskDetailText(task, store.list()), { tasks: [task] });
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("TodoGet ")) + theme.fg("muted", `#${args.id}`), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			return renderDetails(result.details as TaskDetails | undefined, expanded, theme);
		},
	});

	pi.registerTool({
		name: "TodoUpdate",
		label: "TodoUpdate",
		description: `Move a task along, or change it.

Mark in_progress BEFORE starting, and completed ONLY when the work is fully done — not while tests fail, the implementation is partial, or errors are open. When you cannot finish, keep it in_progress and add a task for what has to be resolved first. Call TodoList after a completion.

Fields: status (pending / in_progress / completed / blocked / failed / cancelled / deleted), content, description, priority, activeForm, owner, metadata (merged; null deletes a key), addBlocks / removeBlocks (ids that wait on this), addBlockedBy / removeBlockedBy (ids this waits on — both directions are recorded).

A task with subtasks cannot be completed until they are all finished; a dependency that would form a cycle or point at an unknown id is refused, with the reason in the result.

Examples: { "id": "t1", "status": "in_progress" } · { "id": "t1", "status": "completed" } · { "id": "t2", "addBlockedBy": ["t1"] } · { "id": "t3", "status": "deleted" }`,
		promptSnippet: "Update a task's status, fields, or dependency links",
		promptGuidelines: [
			"Mark a task in_progress before starting it and completed immediately after finishing it — never batch completions.",
			"Mark completed only when the work is fully done, with tests passing and no unresolved errors.",
		],
		parameters: UpdateParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			widget.setUICtx(ctx.ui);
			const { id, ...fields } = params as { id: string } & TaskUpdateFields;
			const status = fields.status;
			const outcome = await attempt(() => store.update(id, fields));
			if (!outcome.ok) return text(`TodoUpdate: ${outcome.message}`, details());
			const { changedFields } = outcome.value;

			if (changedFields.length === 0) return text(`No task #${id}. Call TodoList for the current ids.`, details());

			if (status === "in_progress") {
				widget.setActiveTask(id, true);
				autoClear.resetBatchCountdown();
			} else if (status === "pending") {
				autoClear.resetBatchCountdown();
				widget.setActiveTask(id, false);
			} else if (status === "completed") {
				widget.setActiveTask(id, false);
				autoClear.trackCompletion(id, turn);
			} else {
				widget.setActiveTask(id, false);
			}
			widget.update();
			return text(`Updated #${id}: ${changedFields.join(", ")}`, details());
		},

		renderCall(args, theme) {
			const params = args as { id?: string; status?: string };
			const status = params.status ? `  ${theme.fg("muted", `→ ${params.status}`)}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("TodoUpdate ")) + theme.fg("accent", `#${params.id ?? "?"}`) + status, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			return renderDetails(result.details as TaskDetails | undefined, expanded, theme);
		},
	});

	// ── Command: /todos ───────────────────────────────────────────────────────

	pi.registerCommand("todos", {
		description: "Open the task list panel: move tasks, see the plan. `/todos clear` drops finished work, `/todos settings` picks storage and auto-clear.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			readContext(ctx);
			const wanted = args.trim().toLowerCase();
			// A non-interactive run gets the same answers as one line of text, not a
			// panel nobody can see — so the arguments that need no panel still work.
			const interactive = ctx.mode === "tui" && ctx.hasUI;

			if (wanted === "clear") {
				const cleared = await store.clearCompleted();
				store.deleteFileIfEmpty();
				widget.update();
				ctx.ui.notify(cleared > 0 ? `Cleared ${cleared} completed task(s).` : "No completed tasks to clear.", "info");
				return;
			}
			if (wanted === "settings") {
				if (!interactive) {
					ctx.ui.notify("/todos settings needs an interactive session; the file is .pi/tasks-config.json.", "warning");
					return;
				}
				await configure(ctx);
				return;
			}
			if (!interactive) {
				const tasks = store.list();
				ctx.ui.notify(tasks.length === 0 ? "No tasks. Ask the agent to plan the work." : listForLLM(tasks), "info");
				return;
			}
			if (wanted !== "" && wanted !== "open") {
				ctx.ui.notify(`/todos: unknown argument "${args.trim()}". Use /todos, /todos clear, or /todos settings.`, "warning");
			}
			await showPanel(ctx);
		},
	});

	/** Panel + settings, looping only while the panel asks for settings. */
	async function showPanel(ctx: ExtensionCommandContext): Promise<void> {
		for (;;) {
			const result = await openViewer(ctx);
			if (result !== "settings") return;
			await configure(ctx);
		}
	}

	async function openViewer(ctx: ExtensionCommandContext): Promise<TaskViewerResult> {
		return ctx.ui.custom<TaskViewerResult>(
			(tui, theme, _keybindings, done) =>
				new TaskViewer(() => store.list(), theme, tui, done, (task, action) => applyAction(task, action), {}),
			// The same constant the viewer budgets rows with: the host cuts every line past
			// this cap, and the lines it would cut are the key hints.
			{ overlay: true, overlayOptions: { width: "88%", maxHeight: `${PANEL_HEIGHT_PERCENT}%`, anchor: "center" } },
		);
	}

	/**
	 * Storage and auto-clear, asked through the host's own selectors and written to
	 * `<cwd>/.pi/tasks-config.json`. A cancelled prompt changes nothing: leaving the
	 * menu is not an instruction to reconfigure.
	 */
	async function configure(ctx: ExtensionCommandContext): Promise<void> {
		const before = { ...config };
		for (;;) {
			const scope = config.taskScope ?? "session";
			const mode = config.autoClearCompleted ?? "on_list_complete";
			const nudged = config.planNudge !== false;
			const heading = `Tasks · settings   file: ${store.path ?? "(in memory)"}   saved to: .pi/tasks-config.json`;
			const choice = await ctx.ui.select(heading, [
				`Task storage: ${scope}`,
				`Auto-clear completed: ${mode}`,
				`Plan nudge: ${nudged ? "on" : "off"}`,
				"Close",
			]);
			if (choice === undefined || choice === "Close") break;

			if (choice.startsWith("Task storage")) {
				const picked = await ctx.ui.select(
					`Task storage — applies to the next session (this one keeps ${store.path ?? "its in-memory list"})`,
					SCOPE_CHOICES.map((option) => optionLabel(option, scope)),
				);
				const value = SCOPE_CHOICES.find((option) => optionLabel(option, scope) === picked)?.value;
				if (value) config.taskScope = value;
			} else if (choice.startsWith("Auto-clear")) {
				const picked = await ctx.ui.select(
					`Auto-clear completed — finished work disappears ${AUTO_CLEAR_DELAY_TURNS} turns after it lands`,
					MODE_CHOICES.map((option) => optionLabel(option, mode)),
				);
				const value = MODE_CHOICES.find((option) => optionLabel(option, mode) === picked)?.value;
				if (value) config.autoClearCompleted = value;
			} else if (choice.startsWith("Plan nudge")) {
				const picked = await ctx.ui.select(
					`Plan nudge — after ${PLAN_NUDGE_THRESHOLD} turns containing file changes, with no task list, ask once to plan`,
					NUDGE_CHOICES.map((option) => optionLabel(option, nudged ? "on" : "off")),
				);
				const value = NUDGE_CHOICES.find((option) => optionLabel(option, nudged ? "on" : "off") === picked)?.value;
				if (value) {
					config.planNudge = value === "on";
					// Unlike storage, this takes effect right away: it is a rule about the
					// rest of this session, not about where a file lives.
					planNudge.reset(config.planNudge);
				}
			}

			try {
				saveTodoConfig(cwd, config);
			} catch (error) {
				problem = `could not save task settings: ${error instanceof Error ? error.message : String(error)}`;
				report(ctx.ui, problem);
			}
		}
		if (config.taskScope !== before.taskScope) {
			ctx.ui.notify(
				`Task storage is now "${config.taskScope ?? "session"}" — new sessions use it. This session keeps ${store.path ?? "its in-memory list"}.`,
				"info",
			);
		}
		if (config.autoClearCompleted !== before.autoClearCompleted) {
			ctx.ui.notify(`Auto-clear completed is now "${config.autoClearCompleted ?? "on_list_complete"}".`, "info");
		}
		if ((config.planNudge !== false) !== (before.planNudge !== false)) {
			ctx.ui.notify(`Plan nudge is now "${config.planNudge !== false ? "on" : "off"}".`, "info");
		}
	}
}

/** One option in a selector. */
interface Choice<Value extends string> {
	value: Value;
	hint: string;
}

function optionLabel<Value extends string>(choice: Choice<Value>, current: Value): string {
	return `${choice.value}${choice.value === current ? "  ← current" : ""}  — ${choice.hint}`;
}

const SCOPE_CHOICES: Choice<TaskScope>[] = [
	{ value: "session", hint: "one file per session — survives resume, shares with no other session" },
	{ value: "project", hint: "one file for this directory, so a new session inherits the open work" },
	{ value: "memory", hint: "nothing on disk — the list is gone when the session ends" },
];

const MODE_CHOICES: Choice<AutoClearMode>[] = [
	{ value: "on_list_complete", hint: "clear finished work once the whole list is done" },
	{ value: "on_task_complete", hint: "clear each task a few turns after it finishes" },
	{ value: "never", hint: "completed tasks stay until you clear them" },
];

const NUDGE_CHOICES: Choice<"on" | "off">[] = [
	{ value: "on", hint: "ask once when file edits start with no task list" },
	{ value: "off", hint: "stay silent — AGENTS.md is the only thing that asks" },
];

/** The tool-result panel: the count line and the rows, in the widget's own vocabulary. */
function renderDetails(taskDetails: TaskDetails | undefined, expanded: boolean, theme: Theme): Text {
	return new Text(toolResultText(taskDetails?.tasks ?? [], { expanded, paint: themePaint(theme) }), 0, 0);
}
