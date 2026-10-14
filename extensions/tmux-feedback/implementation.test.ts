import assert from "node:assert/strict";
import test from "node:test";
import tmuxFeedback, {
	buildFeedbackMessage,
	reconstructFeedbackState,
	type FeedbackNote,
} from "./implementation.ts";

// --- helpers ---

function makeNote(overrides: Partial<FeedbackNote> = {}): FeedbackNote {
	return {
		id: 1,
		quote: "the selected line",
		feedback: "please fix this",
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function snapshotEntry(notes: FeedbackNote[], nextId: number) {
	return {
		type: "custom",
		customType: "tmux-feedback",
		data: { action: "snapshot", notes, nextId },
	};
}

interface FakePi {
	events: Map<string, (event: unknown, ctx: unknown) => Promise<void>>;
	commands: Map<string, { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> }>;
	entries: { type: string; data: unknown }[];
	sent: { message: string; options?: Record<string, unknown> }[];
	execLog: { command: string; args: string[] }[];
	execResults: { code: number; stdout: string; stderr: string }[];
}

function makeFakePi(): FakePi {
	const pi: FakePi = {
		events: new Map(),
		commands: new Map(),
		entries: [],
		sent: [],
		execLog: [],
		execResults: [],
	};
	(pi as unknown as Record<string, unknown>).on = (name: string, handler: unknown) => {
		pi.events.set(name, handler as (event: unknown, ctx: unknown) => Promise<void>);
	};
	(pi as unknown as Record<string, unknown>).registerCommand = (name: string, command: unknown) => {
		pi.commands.set(name, command as never);
	};
	(pi as unknown as Record<string, unknown>).appendEntry = (type: string, data: unknown) => {
		pi.entries.push({ type, data });
	};
	(pi as unknown as Record<string, unknown>).sendUserMessage = (message: string, options?: Record<string, unknown>) => {
		pi.sent.push({ message, options });
	};
	(pi as unknown as Record<string, unknown>).exec = async (command: string, args: string[]) => {
		pi.execLog.push({ command, args });
		const result = pi.execResults.shift() ?? { code: 0, stdout: "", stderr: "" };
		return result;
	};
	return pi;
}

interface FakeCtx {
	hasUI: boolean;
	isIdle: () => boolean;
	notifications: { message: string; type: string }[];
	statuses: { key: string; value: string | undefined }[];
	editorCalls: { title: string; initial: string }[];
	editorResults: (string | undefined)[];
	selectResults: (string | undefined)[];
	confirmResults: boolean[];
	branch: unknown[];
	ui?: Record<string, unknown>;
	sessionManager: { getBranch: () => unknown[] };
}

function makeFakeCtx({ hasUI = true, idle = true, branch = [] }: { hasUI?: boolean; idle?: boolean; branch?: unknown[] } = {}): FakeCtx {
	const ctx: FakeCtx = {
		hasUI,
		isIdle: () => idle,
		notifications: [],
		statuses: [],
		editorCalls: [],
		editorResults: [],
		selectResults: [],
		confirmResults: [],
		branch,
		sessionManager: { getBranch: () => branch },
	};
	if (hasUI) {
		ctx.ui = {
			notify: (message: string, type: string = "info") => {
				ctx.notifications.push({ message, type });
			},
			setStatus: (key: string, value: string | undefined) => {
				ctx.statuses.push({ key, value });
			},
			editor: async (title: string, initial: string) => {
				ctx.editorCalls.push({ title, initial });
				return ctx.editorResults.shift();
			},
			select: async (_title: string, _options: string[]) => ctx.selectResults.shift(),
			confirm: async (_title: string, _detail?: string) => ctx.confirmResults.shift() ?? false,
		};
	}
	return ctx;
}

// --- reconstructFeedbackState ---

test("reconstructFeedbackState: empty branch gives empty state", () => {
	assert.deepEqual(reconstructFeedbackState([]), { notes: [], nextId: 1 });
});

test("reconstructFeedbackState: ignores non-custom and foreign custom entries", () => {
	const branch = [
		{ type: "message", content: "hello" },
		{ type: "custom", customType: "other-extension", data: { action: "snapshot", notes: [], nextId: 1 } },
		"garbage",
		null,
	];
	assert.deepEqual(reconstructFeedbackState(branch), { notes: [], nextId: 1 });
});

test("reconstructFeedbackState: uses the last valid snapshot in the branch", () => {
	const first = [makeNote({ id: 1, feedback: "old" })];
	const second = [makeNote({ id: 1, feedback: "old" }), makeNote({ id: 2, feedback: "new" })];
	const branch = [
		snapshotEntry(first, 2),
		{ type: "custom", customType: "tmux-feedback", data: { action: "wrong" } },
		snapshotEntry(second, 3),
	];
	const state = reconstructFeedbackState(branch);
	assert.equal(state.notes.length, 2);
	assert.equal(state.notes[1].feedback, "new");
	assert.equal(state.nextId, 3);
});

test("reconstructFeedbackState: filters invalid note entries and duplicate ids", () => {
	const branch = [
		snapshotEntry(
			[
				makeNote({ id: 1 }),
				{ id: 1, quote: "dup", feedback: "dup", createdAt: "x" },
				{ id: 0, quote: "zero", feedback: "bad", createdAt: "x" },
				{ id: 1.5, quote: "frac", feedback: "bad", createdAt: "x" },
				{ id: 2, quote: "ok", feedback: "ok", createdAt: "x" },
				"not-a-note",
				// The point of the fixture is that a snapshot can carry junk; the
				// reader has to survive it, so the cast is intentional.
			] as unknown as FeedbackNote[],
			5,
		),
	];
	const state = reconstructFeedbackState(branch);
	assert.deepEqual(state.notes.map((note) => note.id), [1, 2]);
	assert.equal(state.nextId, 5);
});

test("reconstructFeedbackState: nextId is at least highest note id plus one", () => {
	const branch = [snapshotEntry([makeNote({ id: 1 }), makeNote({ id: 2 })], 1)];
	assert.equal(reconstructFeedbackState(branch).nextId, 3);

	const branchInvalidNext = [snapshotEntry([makeNote({ id: 2 })], 0)];
	assert.equal(reconstructFeedbackState(branchInvalidNext).nextId, 3);
});

test("reconstructFeedbackState: returned notes are clones of the branch data", () => {
	const note = makeNote();
	const branch = [snapshotEntry([note], 2)];
	const state = reconstructFeedbackState(branch);
	state.notes[0].feedback = "mutated";
	assert.equal(note.feedback, "please fix this");
});

// --- buildFeedbackMessage ---

test("buildFeedbackMessage: formats a single note with singular label", () => {
	const message = buildFeedbackMessage([makeNote()]);
	assert.ok(message.startsWith("I captured inline feedback from tmux scrollback (1 note)."));
	assert.ok(message.includes("Feedback 1 (note #1):"));
	assert.ok(message.includes("> the selected line"));
	assert.ok(message.includes("Feedback:\nplease fix this"));
});

test("buildFeedbackMessage: uses plural label for multiple notes and indexes them", () => {
	const message = buildFeedbackMessage([makeNote({ id: 1 }), makeNote({ id: 2, feedback: "second" })]);
	assert.ok(message.includes("(2 notes)"));
	assert.ok(message.includes("Feedback 1 (note #1):"));
	assert.ok(message.includes("Feedback 2 (note #2):"));
	assert.ok(message.includes("Feedback:\nsecond"));
});

test("buildFeedbackMessage: quotes every line of a multi-line selection", () => {
	const message = buildFeedbackMessage([makeNote({ quote: "line one\nline two" })]);
	assert.ok(message.includes("> line one\n> line two"));
});

test("buildFeedbackMessage: trims surrounding whitespace from feedback", () => {
	const message = buildFeedbackMessage([makeNote({ feedback: "  padded \n" })]);
	assert.ok(message.endsWith("Feedback:\npadded"));
});

// --- extension lifecycle and commands ---

test("factory: registers all six feedback commands and session lifecycle hooks", () => {
	const pi = makeFakePi();
	tmuxFeedback(pi as never);

	assert.deepEqual(
		[...pi.commands.keys()].sort(),
		["feedback-capture", "feedback-clear", "feedback-help", "feedback-install-tmux-binding", "feedback-list", "feedback-send"],
	);
	assert.ok(pi.events.has("session_start"));
	assert.ok(pi.events.has("session_tree"));
});

test("session_start: reconstructs notes from the branch and shows the status", async () => {
	const pi = makeFakePi();
	tmuxFeedback(pi as never);
	const note = makeNote();
	const ctx = makeFakeCtx({ branch: [snapshotEntry([note], 2)] });

	await pi.events.get("session_start")!({}, ctx);

	assert.deepEqual(ctx.statuses, [{ key: "tmux-feedback", value: "tmux feedback 1" }]);
});

test("session_start: clears the status when no feedback is queued", async () => {
	const pi = makeFakePi();
	tmuxFeedback(pi as never);
	const ctx = makeFakeCtx();

	await pi.events.get("session_start")!({}, ctx);

	assert.deepEqual(ctx.statuses, [{ key: "tmux-feedback", value: undefined }]);
});

test("feedback-send: sends all queued notes as one message and appends a clearing snapshot", async () => {
	const pi = makeFakePi();
	tmuxFeedback(pi as never);
	const branch = [
		snapshotEntry(
			[makeNote({ id: 1, feedback: "first" }), makeNote({ id: 2, feedback: "second" })],
			3,
		),
	];
	const ctx = makeFakeCtx({ branch });

	await pi.commands.get("feedback-send")!.handler(null, ctx);

	assert.equal(pi.sent.length, 1);
	assert.ok(pi.sent[0].message.includes("(2 notes)"));
	assert.equal(pi.sent[0].options, undefined, "idle session sends directly");
	assert.equal(pi.entries.length, 1);
	assert.deepEqual(pi.entries[0].data, { action: "snapshot", notes: [], nextId: 1 });
	assert.ok(ctx.notifications.at(-1)?.message.includes("Sent 2 feedback notes"));
});

test("feedback-send: delivers as follow-up when the agent is busy", async () => {
	const pi = makeFakePi();
	tmuxFeedback(pi as never);
	const ctx = makeFakeCtx({ idle: false, branch: [snapshotEntry([makeNote()], 2)] });

	await pi.commands.get("feedback-send")!.handler(null, ctx);

	assert.deepEqual(pi.sent[0].options, { deliverAs: "followUp" });
	assert.ok(ctx.notifications.at(-1)?.message.includes("Queued 1 feedback note as follow-up"));
});

test("feedback-send: reports when nothing is queued and appends no snapshot", async () => {
	const pi = makeFakePi();
	tmuxFeedback(pi as never);
	const ctx = makeFakeCtx();

	await pi.commands.get("feedback-send")!.handler(null, ctx);

	assert.equal(pi.sent.length, 0);
	assert.equal(pi.entries.length, 0);
	assert.ok(ctx.notifications.at(-1)?.message.includes("No queued tmux feedback"));
});

test("feedback-capture: reads the tmux buffer and queues the edited note", async () => {
	const pi = makeFakePi();
	tmuxFeedback(pi as never);
	pi.execResults.push({ code: 0, stdout: "  selected text\n", stderr: "" });
	const ctx = makeFakeCtx();
	ctx.editorResults.push("  make it clearer  ");

	await pi.commands.get("feedback-capture")!.handler(null, ctx);

	assert.deepEqual(pi.execLog, [{ command: "tmux", args: ["show-buffer"] }]);
	assert.equal(pi.entries.length, 1);
	const snapshot = pi.entries[0].data as { notes: FeedbackNote[]; nextId: number };
	assert.equal(snapshot.notes.length, 1);
	assert.equal(snapshot.notes[0].id, 1);
	assert.equal(snapshot.notes[0].quote, "selected text", "buffer is normalized (trimmed, LF)");
	assert.equal(snapshot.notes[0].feedback, "make it clearer", "editor output is trimmed");
	assert.equal(snapshot.nextId, 2);
	assert.ok(ctx.notifications.at(-1)?.message.includes("Queued tmux feedback #1"));
});

test("feedback-capture: warns and queues nothing when the buffer is empty", async () => {
	const pi = makeFakePi();
	tmuxFeedback(pi as never);
	pi.execResults.push({ code: 0, stdout: "   \n", stderr: "" });
	const ctx = makeFakeCtx();

	await pi.commands.get("feedback-capture")!.handler(null, ctx);

	assert.equal(pi.entries.length, 0);
	assert.equal(ctx.editorCalls.length, 0);
	const last = ctx.notifications.at(-1);
	assert.equal(last?.type, "warning");
	assert.ok(last?.message.includes("tmux buffer is empty"));
});

test("feedback-capture: reports tmux failures with the stderr detail", async () => {
	const pi = makeFakePi();
	tmuxFeedback(pi as never);
	pi.execResults.push({ code: 1, stdout: "", stderr: "no current session" });
	const ctx = makeFakeCtx();

	await pi.commands.get("feedback-capture")!.handler(null, ctx);

	const last = ctx.notifications.at(-1);
	assert.equal(last?.type, "error");
	assert.ok(last?.message.includes("no current session"));
});

test("feedback-capture: requires interactive mode", async () => {
	const pi = makeFakePi();
	tmuxFeedback(pi as never);
	const ctx = makeFakeCtx({ hasUI: false });

	await pi.commands.get("feedback-capture")!.handler(null, ctx);

	// Headless: no tmux call, nothing queued (notify() is a no-op without a UI).
	assert.equal(pi.execLog.length, 0);
	assert.equal(pi.entries.length, 0);
});

test("feedback-clear: removes notes after confirmation and appends a clearing snapshot", async () => {
	const pi = makeFakePi();
	tmuxFeedback(pi as never);
	const ctx = makeFakeCtx({ branch: [snapshotEntry([makeNote()], 2)] });
	ctx.confirmResults.push(true);

	await pi.commands.get("feedback-clear")!.handler(null, ctx);

	assert.deepEqual(pi.entries[0].data, { action: "snapshot", notes: [], nextId: 1 });
	assert.ok(ctx.notifications.at(-1)?.message.includes("Cleared queued tmux feedback"));
});

test("feedback-clear: keeps notes when the user declines", async () => {
	const pi = makeFakePi();
	tmuxFeedback(pi as never);
	const ctx = makeFakeCtx({ branch: [snapshotEntry([makeNote()], 2)] });
	ctx.confirmResults.push(false);

	await pi.commands.get("feedback-clear")!.handler(null, ctx);

	assert.equal(pi.entries.length, 0);
	assert.ok(ctx.statuses.at(-1)?.value === "tmux feedback 1");
});

test("feedback-install-tmux-binding: installs both copy-mode tables and reports failure on error", async () => {
	const pi = makeFakePi();
	tmuxFeedback(pi as never);
	const ctx = makeFakeCtx();

	await pi.commands.get("feedback-install-tmux-binding")!.handler(null, ctx);
	assert.equal(pi.execLog.length, 2);
	assert.deepEqual(pi.execLog[0].args.slice(0, 4), ["bind-key", "-T", "copy-mode", "Y"]);
	assert.deepEqual(pi.execLog[1].args.slice(0, 4), ["bind-key", "-T", "copy-mode-vi", "Y"]);
	assert.ok(ctx.notifications.at(-1)?.message.includes("Installed tmux feedback binding in 2 copy-mode tables"));

	pi.execResults.push({ code: 1, stdout: "", stderr: "bad table" });
	await pi.commands.get("feedback-install-tmux-binding")!.handler(null, ctx);
	const failed = ctx.notifications.at(-1);
	assert.equal(failed?.type, "error");
	assert.ok(failed?.message.includes("bad table"));
});
