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
	const theme = {
		fg: (_token: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};

	const rows = (width = 80): string[] => factory?.(tui, theme).render(width) ?? [];
	// Live getters: the assertions read them after the calls have happened.
	return {
		store: new TaskStore(),
		uiCtx,
		tui,
		rows,
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
