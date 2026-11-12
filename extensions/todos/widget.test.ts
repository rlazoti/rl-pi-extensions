/**
 * The widget's behaviour: when a row appears, when it animates, when it goes away.
 *
 * The rendering itself is covered in render.test.ts. What matters here is the
 * lifecycle, because the widget is the one part of this extension that sits on top
 * of somebody's editor: a row that outlives the list, a timer that keeps a process
 * alive, or a spinner stuck on a finished task are all worse than no widget.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { TaskStore } from "./store.ts";
import { TaskWidget, WIDGET_KEY } from "./widget.ts";

interface Recorded {
	key: string;
	options?: { placement?: string };
}

function harness() {
	const calls: Recorded[] = [];
	let factory: ((tui: unknown, theme: unknown) => { render: (width: number) => string[] }) | undefined;
	const uiCtx = {
		setWidget: (key: string, fn: ((tui: unknown, theme: unknown) => never) | undefined, options?: Recorded["options"]) => {
			calls.push({ key, options });
			factory = fn as typeof factory;
		},
	} as never;
	const tui = { requestRender: mock.fn(() => {}) };
	const colours: Array<{ token: string; text: string }> = [];
	const theme = {
		fg: (token: string, text: string) => { colours.push({ token, text }); return text; },
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};

	const framedRows = (width = 80): string[] => factory?.(tui, theme).render(width) ?? [];
	const rows = (width = 80): string[] => framedRows(width).slice(1);
	// Live getters: the assertions read them after the calls have happened.
	return {
		store: new TaskStore(),
		uiCtx,
		tui,
		rows,
		framedRows,
		colours,
		calls,
		get registrations() {
			return calls.filter((call) => call.key === WIDGET_KEY && call.options !== undefined).length;
		},
		get removals() {
			return calls.filter((call) => call.key === WIDGET_KEY && call.options === undefined).length;
		},
	};
}

beforeEach(() => {
	// Date is mocked alongside the interval so "how long has this been running"
	// can be moved forward by a test.
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
});

afterEach(() => {
	mock.timers.reset();
});

describe("registration", () => {
	it("shows nothing until there is a task, so an empty session loses no row", () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store);
		widget.setUICtx(h.uiCtx);
		widget.update();

		assert.equal(h.registrations, 0);
		assert.deepEqual(h.rows(), []);
	});

	it("gives every density one full-width dim top rule and no bottom rule", async () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store);
		widget.setUICtx(h.uiCtx);
		const task = await h.store.create("First");
		widget.update();
		for (const density of ["full", "attention", "minimal"] as const) {
			widget.setDensity(density);
			for (const width of [20, 80]) {
				const rows = h.framedRows(width);
				assert.equal(rows[0], "─".repeat(width));
				assert.notEqual(rows.at(-1), "─".repeat(width), "no second border below the content");
				assert.ok(h.colours.some((entry) => entry.token === "dim" && entry.text === "─".repeat(width)));
				assert.ok(rows.length >= 2);
			}
		}
		await h.store.delete(task.id);
		assert.deepEqual(h.framedRows(), [], "even a stale registered component must not draw empty borders");
		widget.update();
		assert.deepEqual(h.framedRows(), []);
	});

	it("registers once, then repaints the same row", async () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store);
		widget.setUICtx(h.uiCtx);

		await h.store.create("First");
		widget.update();
		const after = h.registrations;
		await h.store.create("Second");
		widget.update();

		assert.equal(after, 1);
		assert.equal(h.registrations, 1, "re-registering would fight the host for the slot");
		assert.equal(h.rows().length, 3, "one header and two tasks");
	});

	it("takes the row away when the list empties", async () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store);
		widget.setUICtx(h.uiCtx);

		const task = await h.store.create("Temp");
		widget.update();
		assert.equal(h.registrations, 1);

		await h.store.delete(task.id);
		widget.update();
		assert.equal(h.removals, 1);
		assert.deepEqual(h.rows(), []);
	});

	it("does nothing without a UI, which is what a print-mode session has", async () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store);
		await h.store.create("First");
		widget.update();
		assert.equal(h.registrations, 0);
	});

	it("clears the row on dispose", async () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store);
		widget.setUICtx(h.uiCtx);
		await h.store.create("First");
		widget.update();

		widget.dispose();
		assert.equal(h.removals, 1);
		assert.equal(widget.isAnimating, false);
	});
});

describe("the animation", () => {
	it("runs only while a task is marked active and in progress", async () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store, 100);
		widget.setUICtx(h.uiCtx);

		const task = await h.store.create("Work");
		await h.store.update(task.id, { status: "in_progress" });
		widget.update();
		assert.equal(widget.isAnimating, false, "in progress is not enough — nobody asked to watch it");

		widget.setActiveTask(task.id);
		assert.equal(widget.isAnimating, true);
		assert.deepEqual(widget.activeTaskIds, [task.id]);
	});

	it("stops when the task finishes, and forgets its spinner", async () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store, 100);
		widget.setUICtx(h.uiCtx);

		const task = await h.store.create("Work");
		await h.store.update(task.id, { status: "in_progress" });
		widget.setActiveTask(task.id);
		await h.store.update(task.id, { status: "completed" });
		widget.update();

		assert.equal(widget.isAnimating, false, "a finished task must not keep a timer alive");
		assert.deepEqual(widget.activeTaskIds, []);
	});

	it("stops when the task is reopened", async () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store, 100);
		widget.setUICtx(h.uiCtx);

		const task = await h.store.create("Work");
		await h.store.update(task.id, { status: "in_progress" });
		widget.setActiveTask(task.id);
		widget.setActiveTask(task.id, false);

		assert.equal(widget.isAnimating, false);
		assert.deepEqual(widget.activeTaskIds, []);
	});

	it("repaints on a tick, and survives a host that refuses", async () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store, 100);
		widget.setUICtx(h.uiCtx);
		const task = await h.store.create("Work", { activeForm: "working" });
		await h.store.update(task.id, { status: "in_progress" });
		widget.setActiveTask(task.id);

		// The host painting the row once is what hands the widget its `tui`; until
		// then there is nothing to ask for a repaint.
		h.rows();
		const requested = h.tui.requestRender.mock.callCount();
		await mock.timers.tick(250);
		assert.ok(h.tui.requestRender.mock.callCount() > requested, "the spinner has to actually move");

		(h.tui as { requestRender: () => void }).requestRender = () => {
			throw new Error("host is closed");
		};
		widget.update();
		assert.ok(true, "a refused repaint must not fail a tool call");
	});

	it("shows the elapsed time from when the task started, not from when the widget appeared", async () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store, 100);
		widget.setUICtx(h.uiCtx);

		const task = await h.store.create("Work");
		await h.store.update(task.id, { status: "in_progress" });
		await mock.timers.tick(30_000);
		widget.setActiveTask(task.id);

		assert.ok(h.rows().some((line) => line.includes("30s")), h.rows().join(" | "));
	});

	it("ignores a call with no task id", () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store);
		widget.setUICtx(h.uiCtx);
		widget.setActiveTask(undefined);
		assert.deepEqual(widget.activeTaskIds, []);
	});
});

/**
 * The same list at three row budgets, reached with one key. What is tested here is
 * the widget's side of it — that contracting repaints, and that a density which
 * hides the only spinner also stops the timer, which is the whole point of the
 * animation rule above.
 */
describe("the density", () => {
	it("starts at full, so a session that never touches the key still sees the plan", async () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store);
		widget.setUICtx(h.uiCtx);
		for (const id of ["a", "b", "c"]) await h.store.create(`Task ${id}`);
		widget.update();

		assert.equal(widget.densitySetting, "full");
		assert.equal(h.rows().length, 4, "the tally and three rows");
	});

	it("contracts the same list to the work that needs a look, then to one line", async () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store);
		widget.setUICtx(h.uiCtx);
		const running = await h.store.create("Write the migration");
		await h.store.create("Backlog one");
		await h.store.create("Backlog two");
		await h.store.update(running.id, { status: "in_progress" });
		widget.update();

		widget.setDensity("attention");
		const attention = h.rows();
		assert.equal(attention.length, 3, "the tally, the migration, and the two it dropped named as two");
		assert.ok(attention.some((line) => line.includes("Backlog one")) === false, String(attention));
		assert.match(attention.at(2)!, /2 more/);

		widget.setDensity("minimal");
		assert.equal(h.rows().length, 1);

		widget.setDensity("full");
		assert.equal(h.rows().length, 4, "and the way back is the same key");
	});

	it("cycles full → attention → minimal → full", async () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store);
		widget.setUICtx(h.uiCtx);
		await h.store.create("Only");
		widget.update();

		assert.equal(widget.cycleDensity(), "attention");
		assert.equal(widget.cycleDensity(), "minimal");
		assert.equal(widget.cycleDensity(), "full", "the cycle wraps rather than dead-ending");
	});

	it("stops the timer when the contracted rows hide the only spinner", async () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store, 100);
		widget.setUICtx(h.uiCtx);
		// Four attention tasks first, so the cap fills before the running one arrives:
		// in `attention` there is no row left for its spinner.
		for (const id of ["1", "2", "3", "4"]) {
			const stuck = await h.store.create(`Stuck ${id}`);
			await h.store.update(stuck.id, { status: "blocked" });
		}
		const running = await h.store.create("The one that is moving");
		await h.store.update(running.id, { status: "in_progress" });
		widget.setActiveTask(running.id);
		assert.equal(widget.isAnimating, true, "full has room for it");

		widget.setDensity("attention");
		assert.equal(widget.isAnimating, false, "a spinner nobody can see must not repaint the terminal");

		widget.setDensity("minimal");
		assert.equal(widget.isAnimating, true, "minimal still paints the spinner, on its one row");
	});

	it("repaints when the density changes, and does nothing when it did not change", async () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store);
		widget.setUICtx(h.uiCtx);
		await h.store.create("First");
		widget.update();
		h.rows(); // hands the widget its tui, which is when repaints become possible

		const requested = h.tui.requestRender.mock.callCount();
		widget.setDensity("attention");
		assert.ok(h.tui.requestRender.mock.callCount() > requested, "the change has to reach the screen");

		const after = h.tui.requestRender.mock.callCount();
		widget.setDensity("attention");
		assert.equal(h.tui.requestRender.mock.callCount(), after, "a no-op must not repaint");
	});

	it("takes the density set before the first task, which is what a config default does", async () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store);
		widget.setUICtx(h.uiCtx);
		widget.setDensity("minimal");

		await h.store.create("First");
		await h.store.create("Second");
		widget.update();
		assert.equal(h.rows().length, 1);
	});

	it("forgets the session's choice on shutdown, so the next session starts as configured", async () => {
		const h = harness();
		const widget = new TaskWidget(() => h.store);
		widget.setUICtx(h.uiCtx);
		await h.store.create("First");
		widget.update();
		widget.setDensity("minimal");

		widget.dispose();
		assert.equal(widget.densitySetting, "full");
	});
});
