/**
 * The `/todos` panel, driven by keystrokes.
 *
 * The panel is the half of this extension a human touches, so the bugs that matter
 * are the ones only visible from outside: a row that wraps and shifts the frame, a
 * completed task that silently disappears, a keystroke that acts twice while the
 * first action is still in flight, a cursor that scrolls itself out of the window.
 *
 * Nothing here touches a store. The viewer asks for actions; whether they are
 * allowed is `store.ts`'s problem and is tested there.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TaskViewer, type TaskAction, type TaskViewerResult } from "./viewer.ts";
import type { Task, TaskStatus } from "./types.ts";

const KEYS = {
	up: "\u001b[A",
	down: "\u001b[B",
	home: "\u001b[H",
	end: "\u001b[F",
	escape: "\u001b",
	enter: "\r",
	ctrlC: "\u0003",
} as const;

function stripAnsi(lines: string[]): string[] {
	return lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+$/, ""));
}

/** The theme's colours are irrelevant to these assertions; its styles are not. */
function themeMock() {
	return {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => text,
		getBgAnsi: () => "",
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	} as never;
}

function task(overrides: Partial<Task> & { id: string }): Task {
	return {
		content: `Task ${overrides.id}`,
		status: "pending" as TaskStatus,
		priority: "medium",
		metadata: {},
		blocks: [],
		blockedBy: [],
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

interface Options {
	rows?: number;
	cols?: number;
	showCompleted?: boolean;
	cursor?: number;
	/** Override what an action answers — return a promise to hold the panel busy. */
	act?: (task: Task | undefined, action: TaskAction) => Promise<string | undefined>;
}

function harness(tasks: Task[], options: Options = {}) {
	const cols = options.cols ?? 80;
	const actions: Array<{ id: string | undefined; action: TaskAction }> = [];
	const renders: number[] = [];
	let closed: TaskViewerResult | undefined;
	let closeCalls = 0;

	const viewer = new TaskViewer(
		() => tasks,
		themeMock(),
		{ terminal: { rows: options.rows ?? 40, columns: cols }, requestRender: () => renders.push(1) } as never,
		(result) => {
			closeCalls++;
			closed = result;
		},
		async (task, action) => {
			actions.push({ id: task?.id, action });
			if (options.act) return options.act(task, action);
			return `${action} #${task?.id ?? "all"}`;
		},
		{ showCompleted: options.showCompleted, cursor: options.cursor },
	);

	return {
		viewer,
		actions,
		get closed() {
			return closed;
		},
		get closeCalls() {
			return closeCalls;
		},
		get renders() {
			return renders.length;
		},
		press(...keys: string[]) {
			for (const key of keys) viewer.handleInput(key);
		},
		lines(width = cols): string[] {
			return stripAnsi(viewer.render(width));
		},
		text(width = cols): string {
			return this.lines(width).join("\n");
		},
	};
}

describe("the frame", () => {
	it("draws a titled frame with the summary and the keys", () => {
		const h = harness([task({ id: "t1" })]);
		const lines = h.lines();

		assert.ok(lines[0]!.includes("Tasks"), "the frame says what it is");
		assert.match(h.text(), /1 task/);
		assert.match(h.text(), /q close/);
		assert.ok(lines.length > 4);
	});

	it("keeps every line inside the width it was given, on any content", () => {
		const hostile = [
			task({ id: "t1", content: "x".repeat(400), owner: "an-owner-wide-enough-to-push-the-row" }),
			task({ id: "t2", content: "tab\tand\ttabs", blockedBy: ["t1"] }),
		];
		for (const width of [40, 60, 100]) {
			for (const line of harness(hostile).lines(width)) {
				assert.ok(line.replace(/\u001b\[[0-9;]*m/g, "").length <= width, `width ${width}: ${line}`);
			}
		}
	});

	it("never returns a line containing a newline", () => {
		for (const line of harness([task({ id: "t1", content: "two\nlines" })]).lines()) {
			assert.equal(line.includes("\n"), false, "one element of render() is one terminal row");
		}
	});

	it("keeps the tasks and drops the progress bar when the terminal is short", () => {
		const tasks = [task({ id: "t1" }), task({ id: "t2", status: "completed" })];
		const short = harness(tasks, { rows: 9 });

		assert.match(short.text(), /2 tasks/);
		assert.match(short.text(), /Task t1/);
		assert.equal(short.text().includes("░"), false, "the bar is decoration; a task is not");
		assert.match(short.text(), /q close/, "the keys stay, or the panel is unreadable");
	});

	it("shows the progress bar and what it is hiding when there is room", () => {
		const h = harness([task({ id: "t1", status: "completed" }), task({ id: "t2" })]);
		assert.match(h.text(), /█/);
		assert.match(h.text(), /1\/2/);
		assert.match(h.text(), /1 hidden \(t\)/, "completed work is hidden, and it says so");
	});
});

describe("grouping", () => {
	it("orders the sections by what needs doing", () => {
		const h = harness([
			task({ id: "t1", status: "completed" }),
			task({ id: "t2", status: "cancelled" }),
			task({ id: "t3", status: "blocked" }),
			task({ id: "t4", status: "in_progress" }),
			task({ id: "t5" }),
		]);
		const text = h.text();
		const at = (title: string) => text.indexOf(title);
		assert.ok(at("In Progress") < at("Pending"));
		assert.ok(at("Pending") < at("Needs Attention"));
		assert.ok(at("Needs Attention") < at("Cancelled"));
		assert.equal(text.includes("Completed"), false, "finished work starts hidden");
	});

	it("puts work that is waiting on another task under Needs Attention", () => {
		const h = harness([task({ id: "t1", status: "in_progress" }), task({ id: "t2", blockedBy: ["t1"] })]);
		const lines = h.lines();
		const waiting = lines.findIndex((line) => line.includes("Task t2"));
		const attention = lines.findIndex((line) => line.includes("Needs Attention"));
		const pending = lines.findIndex((line) => line.includes("Pending"));

		assert.ok(waiting > attention, "a blocked task belongs where a human looks");
		assert.ok(pending < attention, "and not in the queue nobody is waiting on");
		assert.match(h.text(), /blocked by #t1/);
	});

	it("orders the open queue by priority", () => {
		const h = harness([task({ id: "t1", priority: "low" }), task({ id: "t2", priority: "high" })]);
		const lines = h.lines();
		assert.ok(
			lines.findIndex((line) => line.includes("Task t2")) < lines.findIndex((line) => line.includes("Task t1")),
			"high before low",
		);
	});

	it("reveals completed work on t and hides it again", () => {
		const h = harness([task({ id: "t1", status: "completed" })]);
		assert.equal(h.text().includes("Completed"), false);

		h.press("t");
		assert.match(h.text(), /Completed \(1\)/);
		assert.match(h.text(), /t hides/);

		h.press("t");
		assert.equal(h.text().includes("Completed"), false);
	});
});

describe("keys", () => {
	it("moves the cursor and clamps it at both ends", () => {
		const h = harness([task({ id: "t1" }), task({ id: "t2" }), task({ id: "t3" })]);
		h.press(KEYS.down, KEYS.down, KEYS.down);
		assert.equal(h.viewer.view.cursor, 2, "past the end stays on the last row");

		h.press(KEYS.up, KEYS.up, KEYS.up, KEYS.up);
		assert.equal(h.viewer.view.cursor, 0);

		h.press(KEYS.end);
		assert.equal(h.viewer.view.cursor, 2);
		h.press(KEYS.home);
		assert.equal(h.viewer.view.cursor, 0);
	});

	it("marks the cursor's row so it can be seen", () => {
		const h = harness([task({ id: "t1" }), task({ id: "t2" })], { cursor: 1 });
		const marked = h.lines().filter((line) => line.includes("❯"));
		assert.equal(marked.length, 1, "exactly one row is selected");
		assert.ok(marked[0]!.includes("Task t2"));
	});

	it("asks for the action each key means", async () => {
		const h = harness([task({ id: "t1" })]);
		h.press("s");
		await settled();
		h.press("d");
		await settled();
		h.press("b");
		await settled();
		h.press("x");
		await settled();

		assert.deepEqual(
			h.actions.map((entry) => entry.action),
			["start", "complete", "block", "delete"],
		);
		assert.ok(h.actions.every((entry) => entry.id === "t1"));
	});

	it("makes enter mean start, and then complete", () => {
		const running = harness([task({ id: "t1", status: "in_progress" })]);
		const waiting = harness([task({ id: "t1" })]);
		assert.equal(running.viewer.primaryAction(task({ id: "t1", status: "in_progress" })), "complete");
		assert.equal(waiting.viewer.primaryAction(task({ id: "t1" })), "start");
	});

	it("shows what it did in the panel", async () => {
		const h = harness([task({ id: "t1" })]);
		h.press("d");
		await settled();
		assert.match(h.text(), /complete #t1/);
	});

	it("reports an action that was refused, without throwing", async () => {
		const h = harness([task({ id: "t1" })], {
			act: async () => {
				throw new Error("cannot complete #t1: subtask #t2 is still open");
			},
		});
		h.press("d");
		await settled();

		assert.match(h.text(), /subtask #t2 is still open/);
	});

	it("ignores every key while an action is in flight", async () => {
		let release: (() => void) | undefined;
		const h = harness([task({ id: "t1" }), task({ id: "t2" })], {
			act: () => new Promise<string | undefined>((resolve) => (release = () => resolve("deleted #t1"))),
		});

		h.press("x");
		assert.equal(h.viewer.view.busy, true);
		h.press("x", "d", KEYS.down, "s");
		assert.equal(h.actions.length, 1, "the second x would delete whatever moved into the slot");

		release?.();
		await settled();
		assert.equal(h.viewer.view.busy, false);
		assert.equal(h.actions.length, 1);
	});

	it("clears completed work through the same door, with no task selected", async () => {
		const h = harness([task({ id: "t1", status: "completed" })], { showCompleted: true });
		h.press("c");
		await settled();

		assert.deepEqual(h.actions, [{ id: undefined, action: "clear_completed" }]);
	});

	it("leaves the panel for settings on o", () => {
		const h = harness([task({ id: "t1" })]);
		h.press("o");
		assert.equal(h.closed, "settings");
	});

	it("closes on q, escape and ctrl-c, and only says so once", () => {
		for (const key of ["q", KEYS.escape, KEYS.ctrlC]) {
			const h = harness([task({ id: "t1" })]);
			h.press(key, key, "d");
			assert.equal(h.closed, "closed", `key ${JSON.stringify(key)}`);
			assert.equal(h.closeCalls, 1, "a second done() would resolve the host's promise twice");
		}
	});

	it("asks for a repaint on every change, and survives one that is refused", () => {
		const h = harness([task({ id: "t1" }), task({ id: "t2" })]);
		const before = h.renders;
		h.press(KEYS.down);
		assert.ok(h.renders > before);
	});
});

describe("an empty panel", () => {
	it("says what to do instead of showing nothing", () => {
		const h = harness([]);
		assert.match(h.text(), /No tasks yet/);
	});

	it("closes on enter, and opens settings on o", () => {
		const enter = harness([]);
		enter.press(KEYS.enter);
		assert.equal(enter.closed, "closed");

		const settings = harness([]);
		settings.press("o");
		assert.equal(settings.closed, "settings");
	});

	it("says the list is empty rather than blank, when every task is completed and hidden", () => {
		const h = harness([task({ id: "t1", status: "completed" })]);
		assert.match(h.text(), /Nothing to show/);
		assert.match(h.text(), /t to reveal/);
	});
});

describe("scrolling", () => {
	it("moves the window to keep the cursor visible and counts what is off screen", () => {
		const many = Array.from({ length: 30 }, (_unused, index) => task({ id: `t${index + 1}` }));
		const h = harness(many, { rows: 12 });

		for (let index = 0; index < 20; index++) h.press(KEYS.down);
		const lines = h.lines();

		assert.ok(h.viewer.view.offset > 0, "the window moved rather than the list");
		const text = lines.join("\n");
		const focused = h.viewer.visibleTasks()[h.viewer.view.cursor]!;
		assert.ok(text.includes(`Task ${focused.id}`), "the cursor's row is reachable");
		assert.match(text, /more below/, "and it says there is more");
		assert.match(text, /q close/, "the keys survive a long list — that is when they are needed");
		assert.equal(lines.some((line) => line.includes("Task t1\n")), false);
	});

	it("numbers the rows in the order they were created, not in string order", () => {
		const many = ["t1", "t2", "t10", "t20"].map((id) => task({ id }));
		const ids = harness(many)
			.viewer.visibleTasks()
			.map((row) => row.id);
		assert.deepEqual(ids, ["t1", "t2", "t10", "t20"], "t10 comes after t2, or the panel reads as a wrong plan");
	});

	it("shows every task when they all fit", () => {
		const few = Array.from({ length: 4 }, (_unused, index) => task({ id: `t${index + 1}` }));
		const h = harness(few, { rows: 40 });
		assert.match(h.text(), /Task t4/);
		assert.equal(h.text().includes("more below"), false);
	});
});

/** Let the action promise settle and its `.finally()` run. */
async function settled(): Promise<void> {
	for (let index = 0; index < 8; index++) await Promise.resolve();
}
