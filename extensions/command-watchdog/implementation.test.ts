import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { test } from "node:test";
import watchdog from "./index.ts";

function harness({ hasUI = true, throws = false, env = {} as NodeJS.ProcessEnv } = {}) {
	const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const notes: Array<[string, string]> = [];
	const ctx = { hasUI, ui: { notify(message: string, level: string) {
		if (throws) throw new Error("UI unavailable");
		notes.push([message, level]);
	} } } as ExtensionContext;
	watchdog({ on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
		hooks.set(name, handler);
	} } as ExtensionAPI, env);
	function call(input: { command: string; timeout?: number }, toolCallId = "one", parentToolCallId?: string) {
		const event = { type: "tool_call", toolName: "bash", toolCallId, parentToolCallId, input } satisfies ToolCallEvent;
		hooks.get("tool_call")!(event, ctx);
		return input;
	}
	return { call, notes, hooks,
		emit: (name: string, fields: object = {}) => hooks.get(name)?.({ type: name, ...fields }, ctx),
		end: (id: string, durationMs?: number) => hooks.get("tool_execution_end")!({ type: "tool_execution_end", toolName: "bash", toolCallId: id, durationMs }, ctx),
	};
}

test("defaults only agent bash and leaves explicit arguments intact", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	assert.equal(h.call({ command: "x" }).timeout, 300);
	assert.equal(h.call({ command: "x", timeout: 2 }, "short").timeout, 2);
	assert.equal(h.call({ command: "x", timeout: 900 }, "long").timeout, 900);
	for (const [type, toolName] of [["tool_call", "read"], ["tool_call", "ask"], ["tool_call", "powershell"], ["user_bash", "bash"]]) {
		const input = { command: "x" };
		h.emit(type, { toolName, toolCallId: "ignored", input });
		assert.deepEqual(input, { command: "x" });
	}
	t.mock.timers.tick(61_000);
	assert.equal(h.notes.length, 2, "only the default and long-deadline calls warn");
});

test("warns once after 60 seconds with a bounded single-line command preview", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	h.call({ command: "impeccable\n\x1b[31m\t live-server status | head -10 " + "q".repeat(200) });
	t.mock.timers.tick(59_999);
	assert.deepEqual([...h.notes], []);
	t.mock.timers.tick(1);
	t.mock.timers.tick(120_000);
	assert.equal(h.notes.length, 1);
	const [[message, level]] = h.notes;
	assert.equal(level, "warning");
	assert.match(message, /60 seconds/);
	assert.match(message, /live-server status \| head -10/);
	assert.doesNotMatch(message, /[\n\t\x1b]/);
	assert.ok(message.length < 220);
});

test("completion and blocked preflights clear only the matching timer, including nested calls", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	h.call({ command: "finished" }, "one");
	h.call({ command: "blocked" }, "two");
	h.call({ command: "nested" }, "parent/1", "parent");
	h.end("one", 5);
	h.end("two");
	h.emit("tool_execution_end", { toolName: "codemode", toolCallId: "parent" });
	t.mock.timers.tick(60_000);
	assert.equal(h.notes.length, 1);
	assert.match(h.notes[0][0], /nested/);
});

test("session shutdown clears all pending warnings and is idempotent", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	h.call({ command: "one" });
	h.call({ command: "two" }, "two");
	h.emit("session_shutdown");
	h.emit("session_shutdown");
	t.mock.timers.tick(60_000);
	assert.deepEqual(h.notes, []);
});

test("headless Pi still gets a deadline, and a throwing UI cannot break execution", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const headless = harness({ hasUI: false });
	assert.equal(headless.call({ command: "headless" }).timeout, 300);
	const broken = harness({ throws: true });
	assert.equal(broken.call({ command: "broken UI" }).timeout, 300);
	assert.doesNotThrow(() => t.mock.timers.tick(60_000));
	assert.deepEqual(headless.notes, []);
});

test("valid configured thresholds apply and invalid values fall back", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness({ env: { PI_COMMAND_WATCHDOG_TIMEOUT: "0.8", PI_COMMAND_WATCHDOG_WARN_AFTER: "0.2" } });
	assert.equal(h.call({ command: "quick" }).timeout, 0.8);
	t.mock.timers.tick(199);
	assert.deepEqual(h.notes, []);
	t.mock.timers.tick(1);
	assert.equal(h.notes.length, 1);
	for (const invalid of ["", "NaN", "-1", "0", "0.0001", "Infinity", "2147484"]) {
		const bad = harness({ env: { PI_COMMAND_WATCHDOG_TIMEOUT: invalid, PI_COMMAND_WATCHDOG_WARN_AFTER: invalid } });
		assert.equal(bad.call({ command: "fallback" }).timeout, 300);
		t.mock.timers.tick(59_999);
		assert.deepEqual(bad.notes, []);
		t.mock.timers.tick(1);
		assert.equal(bad.notes.length, 1);
	}
});
