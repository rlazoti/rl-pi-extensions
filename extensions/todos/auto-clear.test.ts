/**
 * Auto-clear, as a table: which mode removes what, and when.
 *
 * The countdown is counted in turns, so the tests move the turn number rather
 * than the clock. Each mode has a failure it exists to avoid: `on_list_complete`
 * must not clear a plan while one task is still open, and `on_task_complete` must
 * not clear a task that was reopened.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AutoClear, isAutoClearMode, type AutoClearMode } from "./auto-clear.ts";
import { TaskStore } from "./store.ts";

const DELAY = 4;

async function harness(mode: AutoClearMode) {
	const store = new TaskStore();
	await store.createMany([{ content: "A" }, { content: "B" }]);
	const clear = new AutoClear(() => store, () => mode, DELAY);
	const remaining = () => store.list().map((task) => `${task.id}:${task.status}`).join(" ");
	return { store, clear, remaining };
}

describe("modes", () => {
	it("recognises only the three it implements", () => {
		for (const mode of ["never", "on_list_complete", "on_task_complete"]) {
			assert.equal(isAutoClearMode(mode), true);
		}
		assert.equal(isAutoClearMode("sometimes"), false);
		assert.equal(isAutoClearMode(undefined), false);
	});

	it("never removes anything in never mode", async () => {
		const { store, clear, remaining } = await harness("never");
		await store.update("t1", { status: "completed" });
		await store.update("t2", { status: "completed" });
		clear.trackCompletion("t1", 1);
		clear.trackCompletion("t2", 1);

		assert.equal(await clear.onTurnStart(100), false);
		assert.equal(remaining(), "t1:completed t2:completed");
	});
});

describe("on_list_complete", () => {
	it("waits for the last task before counting down", async () => {
		const { store, clear, remaining } = await harness("on_list_complete");
		await store.update("t1", { status: "completed" });
		clear.trackCompletion("t1", 1);

		assert.equal(clear.state.allCompletedAtTurn, null, "a half-finished plan is not finished");
		assert.equal(await clear.onTurnStart(50), false);
		assert.equal(remaining(), "t1:completed t2:pending");
	});

	it("clears the whole list a few turns after the last completion", async () => {
		const { store, clear, remaining } = await harness("on_list_complete");
		await store.update("t1", { status: "completed" });
		await store.update("t2", { status: "completed" });
		clear.trackCompletion("t2", 10);

		assert.equal(clear.state.allCompletedAtTurn, 10);
		assert.equal(await clear.onTurnStart(10 + DELAY - 1), false, "the delay is a grace period, not an instant");
		assert.equal(await clear.onTurnStart(10 + DELAY), true);
		assert.equal(remaining(), "");
	});

	it("starts over when new work arrives", async () => {
		const { store, clear, remaining } = await harness("on_list_complete");
		await store.update("t1", { status: "completed" });
		await store.update("t2", { status: "completed" });
		clear.trackCompletion("t2", 10);

		const added = await store.create("New scope found");
		clear.resetBatchCountdown();
		assert.equal(clear.state.allCompletedAtTurn, null);
		assert.equal(await clear.onTurnStart(40), false);

		await store.update(added.id, { status: "completed" });
		clear.trackCompletion(added.id, 41);
		assert.equal(await clear.onTurnStart(41 + DELAY), true);
		assert.equal(remaining(), "");
	});

	it("counts a list that became complete without a tracked completion", async () => {
		const { store, clear } = await harness("on_list_complete");
		await store.update("t1", { status: "completed" });
		await store.update("t2", { status: "completed" });

		assert.equal(await clear.onTurnStart(5), false, "the countdown starts now, not retroactively");
		assert.equal(clear.state.allCompletedAtTurn, 5);
		assert.equal(await clear.onTurnStart(5 + DELAY), true);
	});

	it("says nothing when there is nothing to clear", async () => {
		const { clear } = await harness("on_list_complete");
		assert.equal(await clear.onTurnStart(9), false, "an empty list is not a completed list");
	});

	it("forgets the schedule on reset", async () => {
		const { store, clear } = await harness("on_list_complete");
		await store.update("t1", { status: "completed" });
		await store.update("t2", { status: "completed" });
		clear.trackCompletion("t2", 2);
		clear.reset();
		assert.deepEqual(clear.state, { perTask: [], allCompletedAtTurn: null });
	});
});

describe("on_task_complete", () => {
	it("gives every task its own countdown", async () => {
		const { store, clear, remaining } = await harness("on_task_complete");
		await store.update("t1", { status: "completed" });
		clear.trackCompletion("t1", 1);
		await store.update("t2", { status: "completed" });
		clear.trackCompletion("t2", 3);

		assert.equal(await clear.onTurnStart(1 + DELAY), true);
		assert.equal(remaining(), "t2:completed", "t2 finished later, so it stays longer");
		assert.equal(await clear.onTurnStart(3 + DELAY), true);
		assert.equal(remaining(), "");
	});

	it("stops clearing a task that was reopened", async () => {
		const { store, clear, remaining } = await harness("on_task_complete");
		await store.update("t1", { status: "completed" });
		clear.trackCompletion("t1", 1);
		await store.update("t1", { status: "in_progress" });

		assert.equal(await clear.onTurnStart(1 + DELAY), false);
		assert.deepEqual(clear.state.perTask, [], "a reopened task is no longer scheduled");
		assert.equal(remaining(), "t1:in_progress t2:pending");
	});

	it("does not schedule anything while in never mode", async () => {
		const { store, clear } = await harness("never");
		await store.update("t1", { status: "completed" });
		clear.trackCompletion("t1", 1);
		assert.deepEqual(clear.state.perTask, []);
	});
});
