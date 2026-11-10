/**
 * Where the list lives, as a pure function of cwd, session id, environment and
 * config file. The whole matrix is testable without a running Pi, which is the
 * point of keeping it out of the extension: a wrong path here either loses a
 * session's work or writes it where another session will read it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { ENV_VAR, loadTodoConfig, resolveStorePath, safeListName, saveTodoConfig } from "./config.ts";

let cwd = "";
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "todos-config-"));
});
after(() => {
	rmSync(cwd, { recursive: true, force: true });
});

const HOME = "/home/tester";

describe("resolveStorePath", () => {
	it("keeps a memory list in the process", () => {
		assert.equal(resolveStorePath({ cwd, sessionId: "abc", config: { taskScope: "memory" }, homeDir: HOME }), undefined);
	});

	it("gives each session its own file by default", () => {
		const first = resolveStorePath({ cwd, sessionId: "abc", homeDir: HOME });
		const second = resolveStorePath({ cwd, sessionId: "def", homeDir: HOME });
		assert.equal(first, join(cwd, ".pi", "tasks", "tasks-abc.json"));
		assert.notEqual(first, second, "two sessions must not share one list by accident");
	});

	it("has no file before a session exists, so nothing is written to an unknown id", () => {
		assert.equal(resolveStorePath({ cwd, homeDir: HOME }), undefined);
	});

	it("shares one file across sessions in project scope", () => {
		const path = resolveStorePath({ cwd, sessionId: "abc", config: { taskScope: "project" }, homeDir: HOME });
		assert.equal(path, join(cwd, ".pi", "tasks", "tasks.json"));
	});

	it("drops a nonsense scope instead of guessing", () => {
		assert.equal(
			resolveStorePath({ cwd, sessionId: "abc", config: { taskScope: "everything" as never }, homeDir: HOME }),
			join(cwd, ".pi", "tasks", "tasks-abc.json"),
		);
	});

	it("turns a bare PI_TODOS value into a named list under home", () => {
		assert.equal(
			resolveStorePath({ cwd, sessionId: "abc", env: { [ENV_VAR]: "sprint-1" }, homeDir: HOME }),
			join(HOME, ".pi", "tasks", "sprint-1.json"),
			"a shared name is how two machines' sessions meet",
		);
	});

	it("reads off PI_TODOS=off, so CI never writes a task file", () => {
		assert.equal(resolveStorePath({ cwd, sessionId: "abc", config: { taskScope: "project" }, env: { [ENV_VAR]: "off" }, homeDir: HOME }), undefined);
	});

	it("takes PI_TODOS as a file when it looks like one", () => {
		assert.equal(
			resolveStorePath({ cwd, env: { [ENV_VAR]: "/tmp/board.json" }, homeDir: HOME }),
			"/tmp/board.json",
		);
		assert.equal(
			resolveStorePath({ cwd, env: { [ENV_VAR]: "./board.json" }, homeDir: HOME }),
			join(cwd, "board.json"),
		);
		assert.equal(
			resolveStorePath({ cwd, env: { [ENV_VAR]: "~/board.json" }, homeDir: HOME }),
			join(HOME, "board.json"),
			"a tilde means the home directory, not the filesystem root",
		);
		assert.equal(
			resolveStorePath({ cwd, env: { [ENV_VAR]: "~" }, homeDir: HOME }),
			join(HOME, ".pi", "tasks", "default.json"),
			"a bare tilde still has to name a file",
		);
	});

	it("wins over the config file, because the shell is the more specific instruction", () => {
		assert.equal(
			resolveStorePath({ cwd, sessionId: "abc", config: { taskScope: "memory" }, env: { [ENV_VAR]: "sprint-1" }, homeDir: HOME }),
			join(HOME, ".pi", "tasks", "sprint-1.json"),
		);
	});
});

describe("safeListName", () => {
	it("keeps a derived filename inside the directory it belongs to", () => {
		for (const hostile of ["../../etc/passwd", "/absolute/name", "..", ".", "  ", "a/b/c"]) {
			const name = safeListName(hostile);
			assert.ok(!name.includes("/") && !name.includes("\\"), `${hostile} produced a path`);
			assert.ok(!name.startsWith("."), `${hostile} produced a hidden file`);
			assert.ok(name.length <= 64);
		}
		assert.equal(safeListName("../../etc/passwd"), "passwd");
		assert.equal(safeListName(".."), "default");
	});

	it("keeps the readable characters a list name has", () => {
		assert.equal(safeListName("sprint-1.final_v2"), "sprint-1.final_v2");
		assert.equal(safeListName("Sprint 1").includes(" "), false);
		assert.equal(safeListName("board.json"), "board", "the extension is what adds the suffix");
	});
});

describe("the config file", () => {
	it("round-trips through loadTodoConfig", () => {
		saveTodoConfig(cwd, { taskScope: "project", autoClearCompleted: "never" });
		assert.deepEqual(loadTodoConfig(cwd), { taskScope: "project", autoClearCompleted: "never" });
		assert.ok(readFileSync(join(cwd, ".pi", "tasks-config.json"), "utf-8").includes("project"));
	});

	it("drops values it does not know instead of trusting the file", () => {
		saveTodoConfig(cwd, { taskScope: "galactic" as never, autoClearCompleted: "always" as never });
		assert.deepEqual(loadTodoConfig(cwd), {});
	});

	it("returns nothing when there is no file, and when the file is not an object", () => {
		assert.deepEqual(loadTodoConfig(cwd), {});
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "tasks-config.json"), "[1,2,3]", "utf-8");
		assert.deepEqual(loadTodoConfig(cwd), {});
		writeFileSync(join(cwd, ".pi", "tasks-config.json"), "{ broken", "utf-8");
		assert.deepEqual(loadTodoConfig(cwd), {}, "a hand-edited typo must not break the session");
	});

	it("keeps planNudge as a boolean and drops anything else", () => {
		saveTodoConfig(cwd, { planNudge: false });
		assert.deepEqual(loadTodoConfig(cwd), { planNudge: false });

		saveTodoConfig(cwd, { planNudge: "no" as never });
		assert.deepEqual(loadTodoConfig(cwd), {}, "an absent flag means on, so a typo must not read as off");
	});
});
