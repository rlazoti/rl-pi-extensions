/**
 * The store, tested against a real filesystem and real lock files.
 *
 * Each case is a rule another component relies on: an id is never reused, a
 * dependency is recorded on both sides or not at all, a refused mutation changes
 * nothing on disk, a parent cannot claim to be finished while its subtasks are
 * open, and a record this build cannot read is preserved rather than overwritten.
 * Those are the ways a task list loses work without anyone noticing.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { TaskStore, TaskStoreCorruptionError } from "./store.ts";
import type { Task, TaskStoreData } from "./types.ts";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "todos-store-"));
});
after(() => {
	rmSync(dir, { recursive: true, force: true });
});

const at = (name: string) => join(dir, name);

function read(path: string): TaskStoreData {
	return JSON.parse(readFileSync(path, "utf-8")) as TaskStoreData;
}

/** A record shaped like one a human would hand-edit: ids, titles, statuses only. */
function handWritten(tasks: Array<Partial<Task> & { id: string }>): string {
	return JSON.stringify({
		nextId: 1,
		tasks: tasks.map((task) => ({ content: `Hand-written ${task.id}`, status: "pending", priority: "medium", metadata: {}, blocks: [], blockedBy: [], createdAt: 0, updatedAt: 0, ...task })),
	});
}

describe("writing", () => {
	it("creates tasks with sequential ids and defaults", async () => {
		const store = new TaskStore(at("tasks.json"));
		const first = await store.create("First");
		const second = await store.create("Second", { priority: "high", description: "why" });

		assert.equal(first.id, "t1");
		assert.equal(second.id, "t2");
		assert.equal(first.status, "pending");
		assert.equal(first.priority, "medium");
		assert.equal(second.priority, "high");
		assert.equal(second.description, "why");
		assert.deepEqual(first.blockedBy, []);
		assert.equal(store.list().length, 2);
	});

	it("writes a batch in one transaction, so a bad item leaves no plan behind", async () => {
		const path = at("tasks.json");
		const store = new TaskStore(path);
		await assert.rejects(
			store.createMany([{ content: "A" }, { content: "B", options: { parentId: "t99" } }]),
			/does not exist/,
		);
		assert.equal(existsSync(path), false, "either the whole batch is stored or none of it");

		const created = await store.createMany([{ content: "A" }, { content: "B", options: { priority: "low" } }]);
		assert.deepEqual(
			created.map((task) => task.id),
			["t1", "t2"],
		);
		assert.equal(read(path).tasks.length, 2);
	});

	it("creates its own directory, so the first task of a session cannot fail", async () => {
		const store = new TaskStore(at("nested/deep/tasks.json"));
		const created = await store.create("Written before the directory existed");
		assert.ok(existsSync(at("nested/deep/tasks.json")));
		assert.equal(store.get(created.id)?.content, created.content);
	});

	it("never reuses an id, even after every task is gone", async () => {
		const path = at("tasks.json");
		const store = new TaskStore(path);
		await store.createMany([{ content: "A" }, { content: "B" }]);
		for (const task of store.list()) await store.update(task.id, { status: "deleted" });
		const next = await store.create("C");
		assert.equal(next.id, "t3", "a reused id would point old dependency links at new work");

		const reopened = new TaskStore(path);
		assert.equal((await reopened.create("D")).id, "t4", "the counter lives in the record, not in what survives");
	});
});

describe("updating", () => {
	it("reports which fields moved, and says nothing about an unknown id", async () => {
		const store = new TaskStore(at("tasks.json"));
		await store.create("Ship it");

		const changed = await store.update("t1", { status: "in_progress", priority: "high" });
		assert.deepEqual(changed.changedFields.sort(), ["priority", "status"]);
		assert.ok(store.get("t1")!.startedAt, "starting a task records when it started");

		const same = await store.update("t1", { status: "in_progress" });
		assert.deepEqual(same.changedFields, [], "writing the same value is not a change");

		const missing = await store.update("t99", { status: "completed" });
		assert.equal(missing.task, undefined);
		assert.deepEqual(missing.changedFields, []);
	});

	it("deletes a task and the dependency links that pointed at it", async () => {
		const store = new TaskStore(at("tasks.json"));
		await store.createMany([{ content: "A" }, { content: "B" }]);
		await store.update("t2", { addBlockedBy: ["t1"] });
		const deleted = await store.update("t1", { status: "deleted" });

		assert.deepEqual(deleted.changedFields, ["deleted"]);
		assert.equal(store.get("t1"), undefined);
		assert.deepEqual(store.get("t2")!.blockedBy, [], "a dangling blocker would block t2 forever");
	});

	it("merges metadata and deletes a key with null", async () => {
		const store = new TaskStore(at("tasks.json"));
		await store.create("Note", { metadata: { keep: 1, drop: 2 } });
		const result = await store.update("t1", { metadata: { drop: null, added: "yes" } });

		assert.deepEqual(result.task!.metadata, { keep: 1, added: "yes" });
	});

	it("refuses to complete a parent whose subtasks are open, and changes nothing", async () => {
		const store = new TaskStore(at("tasks.json"));
		const parent = await store.create("Parent");
		const child = await store.create("Child", { parentId: parent.id });

		await assert.rejects(store.update(parent.id, { status: "completed" }), /open subtasks: #t2/);
		assert.equal(store.get(parent.id)!.status, "pending");

		await store.update(child.id, { status: "completed" });
		await store.update(parent.id, { status: "completed" });
		assert.equal(store.get(parent.id)!.status, "completed");
	});

	it("lets a cancelled subtask out of the parent's way", async () => {
		const store = new TaskStore(at("tasks.json"));
		const parent = await store.create("Parent");
		const child = await store.create("Child", { parentId: parent.id });

		await store.update(child.id, { status: "cancelled" });
		await store.update(parent.id, { status: "completed" });
		assert.equal(store.get(parent.id)!.status, "completed", "work nobody is doing cannot hold a parent open");
	});

	it("refuses a self-parent and a missing parent", async () => {
		const store = new TaskStore(at("tasks.json"));
		await store.create("A");
		await assert.rejects(store.update("t1", { parentId: "t1" }), /own parent/);
		await assert.rejects(store.update("t1", { parentId: "t9" }), /does not exist/);
	});

	it("tracks the life of a task in timestamps", async () => {
		const store = new TaskStore(at("tasks.json"));
		await store.create("Timed");
		await store.update("t1", { status: "in_progress" });
		const started = store.get("t1")!;
		await store.update("t1", { status: "completed" });
		const done = store.get("t1")!;

		assert.ok(done.startedAt && done.startedAt >= started.createdAt);
		assert.ok(done.completedAt! >= done.startedAt!);
		await store.update("t1", { status: "in_progress" });
		assert.equal(store.get("t1")!.completedAt, undefined, "reopened work is no longer finished");
	});
});

describe("a task's own words", () => {
	it("keeps them on one line, because they are shown in single-line rows", async () => {
		const store = new TaskStore(at("words.json"));
		const task = await store.create("  fix the   parser\nthen test it\tplease  ", {
			activeForm: "fixing\nthe parser",
			owner: "team\tlead",
		});
		assert.equal(task.content, "fix the   parser then test it please");
		assert.equal(task.activeForm, "fixing the parser");
		assert.equal(task.owner, "team lead");
	});

	it("flattens what came off the disk too", async () => {
		const path = at("hostile.json");
		writeFileSync(
			path,
			handWritten([{ id: "t1", content: "line one\nline two" }]),
			"utf-8",
		);
		const store = new TaskStore(path);
		await store.load();
		assert.equal(store.get("t1")!.content, "line one line two");
	});

	it("keeps a description multi-line, because it is shown on its own", async () => {
		const task = await new TaskStore(at("description.json")).create("subject", { description: "first\nsecond" });
		assert.equal(task.description, "first\nsecond");
	});
});

describe("dependencies", () => {
	it("records both directions from either side", async () => {
		const store = new TaskStore(at("tasks.json"));
		await store.createMany([{ content: "A" }, { content: "B" }]);

		await store.update("t1", { addBlocks: ["t2"] });
		assert.deepEqual(store.get("t1")!.blocks, ["t2"]);
		assert.deepEqual(store.get("t2")!.blockedBy, ["t1"]);

		await store.update("t2", { removeBlockedBy: ["t1"] });
		assert.deepEqual(store.get("t1")!.blocks, []);
		assert.deepEqual(store.get("t2")!.blockedBy, []);
	});

	it("leaves status alone: readiness is derived from the edges", async () => {
		const store = new TaskStore(at("tasks.json"));
		await store.createMany([{ content: "A" }, { content: "B" }]);
		await store.update("t2", { addBlockedBy: ["t1"] });

		assert.equal(store.get("t2")!.status, "pending", "blockedBy is a fact about work, not a status the agent wrote");
		assert.deepEqual(
			store.readyTasks().map((task) => task.id),
			["t1"],
		);
		await store.update("t1", { status: "completed" });
		assert.deepEqual(
			store.readyTasks().map((task) => task.id),
			["t2"],
			"finishing a blocker is what unblocks the rest",
		);
	});

	it("rejects a cycle, a self-link and a dangling id, and writes nothing", async () => {
		const store = new TaskStore(at("tasks.json"));
		await store.createMany([{ content: "A" }, { content: "B" }, { content: "C" }]);
		await store.update("t2", { addBlockedBy: ["t1"] });
		await store.create("Unrelated");
		const before = readFileSync(at("tasks.json"), "utf-8");

		await assert.rejects(store.update("t1", { addBlockedBy: ["t2"] }), /cycle/);
		await assert.rejects(store.update("t1", { addBlockedBy: ["t1"] }), /itself/);
		await assert.rejects(store.update("t1", { addBlockedBy: ["t9"] }), /does not exist/);
		assert.equal(readFileSync(at("tasks.json"), "utf-8"), before, "a refused link leaves the file exactly as it was");
	});

	it("rejects a parent cycle", async () => {
		const store = new TaskStore(at("tasks.json"));
		await store.createMany([{ content: "A" }, { content: "B" }]);
		await store.update("t2", { parentId: "t1" });
		await assert.rejects(store.update("t1", { parentId: "t2" }), /Parent cycle/);
	});
});

describe("reading a file it did not write", () => {
	it("preserves an unparseable record instead of overwriting it", () => {
		const path = at("tasks.json");
		const original = "{ this is not json, but it is somebody's notes";
		writeFileSync(path, original, "utf-8");

		assert.throws(() => new TaskStore(path), TaskStoreCorruptionError);

		const preserved = readdirSync(dir).filter((entry) => entry.startsWith("tasks.json.corrupt-"));
		assert.equal(preserved.length, 1, "the unreadable bytes are moved aside exactly once");
		assert.equal(readFileSync(join(dir, preserved[0]!), "utf-8"), original);
		assert.equal(existsSync(path), false, "the corrupt file is not left where the next write would land");
	});

	it("reports corruption through the constructor so the caller can fall back", () => {
		const path = at("tasks.json");
		writeFileSync(path, JSON.stringify({ hello: "valid json, wrong shape" }), "utf-8");
		assert.throws(() => new TaskStore(path), TaskStoreCorruptionError);
	});

	it("reads its own format back on the second pass", async () => {
		const path = at("tasks.json");
		const first = new TaskStore(path);
		await first.create("Written by pass one", { priority: "high" });

		const second = new TaskStore(path);
		assert.equal(second.list()[0]!.content, "Written by pass one");
		await second.update("t1", { status: "completed" });

		const third = new TaskStore(path);
		assert.equal(third.list()[0]!.status, "completed");
		assert.equal(read(path).nextId, 2);
	});

	it("adopts ids a foreign writer already used", async () => {
		const path = at("tasks.json");
		writeFileSync(path, handWritten([{ id: "t7", content: "from another tool" }]), "utf-8");

		const store = new TaskStore(path);
		const mine = await store.create("Mine");
		assert.equal(mine.id, "t8", "the counter must move past the ids already in the file");
		assert.equal(store.list().length, 2);
	});

	it("keeps an unknown status readable by falling back to pending", async () => {
		const path = at("tasks.json");
		writeFileSync(path, handWritten([{ id: "t1", status: "waiting-for-review" as never }]), "utf-8");

		const store = new TaskStore(path);
		assert.equal(store.list()[0]!.status, "pending", "a newer vocabulary must not make the list unreadable");
	});

	it("reports a directory in the store's place without moving it", () => {
		const path = at("tasks.json");
		mkdirSync(path);
		writeFileSync(join(path, "precious.txt"), "not a task list", "utf-8");

		assert.throws(() => new TaskStore(path), TaskStoreCorruptionError);
		assert.equal(existsSync(join(path, "precious.txt")), true, "a directory belongs to the human, not to this extension");
	});

	it("clears completed work, then leaves no file behind when the list empties", async () => {
		const path = at("tasks.json");
		const store = new TaskStore(path);
		await store.createMany([{ content: "A" }, { content: "B" }]);
		await store.update("t1", { status: "completed" });

		assert.equal(await store.clearCompleted(), 1);
		assert.equal(read(path).tasks.length, 1);
		assert.equal(store.deleteFileIfEmpty(), false, "one open task is a reason to keep the file");

		assert.equal(await store.clearAll(), 1);
		assert.equal(existsSync(path), true, "clearing is not deleting the file");
		assert.equal(store.deleteFileIfEmpty(), true);
		assert.equal(existsSync(path), false);
	});
});

describe("concurrent writers", () => {
	it("serialises two stores over one file", async () => {
		const path = at("tasks.json");
		const a = new TaskStore(path);
		const b = new TaskStore(path);

		const [one, two] = await Promise.all([a.create("From A"), b.create("From B")]);
		assert.notEqual(one.id, two.id, "each writer must see the other's ids");
		assert.equal(read(path).tasks.length, 2);
	});

	it("sees another session's change on the next read", async () => {
		const path = at("tasks.json");
		const a = new TaskStore(path);
		const b = new TaskStore(path);

		await a.create("Written by A");
		assert.equal(b.list().length, 1, "a shared list must not be served from a stale copy");
		await b.update("t1", { status: "completed" });
		assert.equal(a.get("t1")!.status, "completed");
	});

	it("breaks a lock whose owner is gone", async () => {
		const path = at("tasks.json");
		writeFileSync(`${path}.lock`, "999999", "utf-8");

		const store = new TaskStore(path);
		const created = await store.create("After a crashed session");
		assert.equal(created.id, "t1");
		assert.equal(existsSync(`${path}.lock`), false, "a stolen lock is released like any other");
	});

	it("waits rather than writing through a live lock", async () => {
		const path = at("tasks.json");
		writeFileSync(`${path}.lock`, String(process.pid), "utf-8");
		const store = new TaskStore(path);

		const write = store.create("Held up");
		let settled = false;
		void write.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(settled, false, "a running session's lock is respected, not stolen");

		unlinkSync(`${path}.lock`);
		assert.equal((await write).id, "t1", "and the write goes through once it is released");
	});
});

describe("cleanup", () => {
	it("waits for in-flight writes, then leaves only the record", async () => {
		const path = at("tasks.json");
		const store = new TaskStore(path);
		await Promise.all([store.create("A"), store.create("B"), store.create("C")]);
		await store.cleanup();

		assert.equal(read(path).tasks.length, 3, "cleanup must not cut a queued write short");
		assert.equal(existsSync(`${path}.lock`), false);
		assert.equal(existsSync(path), true, "cleanup removes locks, never the record");
	});
});
