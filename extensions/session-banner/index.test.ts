/**
 * session-banner extension behavior suite — ported from the standalone
 * repo's index.test.vitest.ts to node:test.
 *
 * Porting notes (the assertions below mirror the vitest suite 1:1):
 *  - describe/it/expect → node:test + a small matcher subset (matches())
 *  - vi.mock() module mocks → the null-gated test seams in implementation.ts
 *    (Node 26 removed ESM module mocking); complete/execFile/fs are stubbed
 *    through those seams, truncateToWidth uses the real pi-tui function
 *  - vi.useFakeTimers/advanceTimersByTimeAsync → mock.timers enable/tick
 *    (Date is faked too, exactly as vi.setSystemTime did)
 *  - vi.getTimerCount() → behavioral assertions (no further paint activity)
 *  - vi.resetModules() + re-import (cmux/env tests) → not needed: the
 *    implementation now reads the PROVIDER/MODEL/CMUX env vars lazily
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import sessionBanner from "./index.ts";
import {
	setCompleteForTesting,
	setExecFileForTesting,
	setFsForTesting,
} from "./implementation.ts";
import { paneRegistry } from "./panes.ts";

// ─── Stub channels (wired into implementation.ts's test seams) ───────────

interface StubState {
	completeCalls: unknown[][];
	completeOnce: unknown[]; // resolved values | Errors | promises
	execFileCalls: unknown[][];
	execFileImpl: ((...args: unknown[]) => unknown) | null;
	readFileSyncCalls: unknown[][];
	readFileSyncValue: unknown; // string | Error
	mkdirCalls: unknown[][];
	mkdirImpl: ((...args: unknown[]) => Promise<unknown>) | null;
	writeFileCalls: unknown[][];
	writeFileImpl: ((...args: unknown[]) => Promise<unknown>) | null;
}

const stubs: StubState = {
	completeCalls: [],
	completeOnce: [],
	execFileCalls: [],
	execFileImpl: null,
	readFileSyncCalls: [],
	readFileSyncValue: null,
	mkdirCalls: [],
	mkdirImpl: null,
	writeFileCalls: [],
	writeFileImpl: null,
};

function resetStubs(): void {
	stubs.completeCalls.length = 0;
	stubs.completeOnce.length = 0;
	stubs.execFileCalls.length = 0;
	// Default: every CLI call succeeds with empty output (like the vitest suite).
	stubs.execFileImpl = (command, args, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
		callback?.(null, "", "");
		return {} as never;
	};
	stubs.readFileSyncCalls.length = 0;
	stubs.readFileSyncValue = new Error("no state file");
	stubs.mkdirCalls.length = 0;
	stubs.mkdirImpl = async () => undefined;
	stubs.writeFileCalls.length = 0;
	stubs.writeFileImpl = async () => undefined;
}

setCompleteForTesting(async (...args: unknown[]) => {
	stubs.completeCalls.push(args);
	const once = stubs.completeOnce.shift();
	if (once instanceof Error) throw once;
	return (once ?? { content: [] }) as never;
});

setExecFileForTesting((...args: unknown[]) => {
	stubs.execFileCalls.push(args);
	return stubs.execFileImpl!(...args);
});

setFsForTesting({
	readFileSync: (...args: unknown[]) => {
		stubs.readFileSyncCalls.push(args);
		if (stubs.readFileSyncValue instanceof Error) throw stubs.readFileSyncValue;
		return stubs.readFileSyncValue;
	},
	promises: {
		mkdir: (...args: unknown[]) => {
			stubs.mkdirCalls.push(args);
			return stubs.mkdirImpl!(...args);
		},
		writeFile: (...args: unknown[]) => {
			stubs.writeFileCalls.push(args);
			return stubs.writeFileImpl!(...args);
		},
	},
} as unknown as Parameters<typeof setFsForTesting>[0]);

// ─── Matcher subset (vitest expect → node:assert) ─────────────────────────

const ANY_FN = Symbol("anyFn");
const ANYTHING = Symbol("anything");
// Strip-compatible: no parameter properties (Node has no --experimental-transform-types).
class Matcher {
	kind: "contains" | "matching" | "arrayContaining";
	value: unknown;
	constructor(kind: "contains" | "matching" | "arrayContaining", value: unknown) {
		this.kind = kind;
		this.value = value;
	}
}
const anyFn = () => ANY_FN;
const anything = () => ANYTHING;
const stringContaining = (value: string) => new Matcher("contains", value);
const stringMatching = (value: RegExp) => new Matcher("matching", value);
const arrayContaining = (value: unknown[]) => new Matcher("arrayContaining", value);

function matches(expected: unknown, actual: unknown): boolean {
	if (expected === ANY_FN) return typeof actual === "function";
	if (expected === ANYTHING) return actual !== undefined && actual !== null;
	if (expected instanceof Matcher) {
		if (expected.kind === "contains") return typeof actual === "string" && actual.includes(String(expected.value));
		if (expected.kind === "matching") return typeof actual === "string" && (expected.value as RegExp).test(actual);
		return Array.isArray(actual) && (expected.value as unknown[]).every((e) => actual.some((a) => matches(e, a)));
	}
	if (Array.isArray(expected)) {
		return Array.isArray(actual) && expected.length === actual.length && expected.every((e, i) => matches(e, (actual as unknown[])[i]));
	}
	if (expected !== null && typeof expected === "object") {
		if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
		const e = expected as Record<string, unknown>;
		const a = actual as Record<string, unknown>;
		return Object.keys(e).every((k) => k in a && matches(e[k], a[k]));
	}
	try {
		assert.deepStrictEqual(expected, actual);
		return true;
	} catch {
		return false;
	}
}

const jsonReplacer = (_k: string, v: unknown) => (typeof v === "function" ? "[fn]" : v);

function describeCalls(calls: unknown[][]): string {
	return `calls=${JSON.stringify(calls.slice(-3), jsonReplacer)}`;
}

function expectCalledWith(calls: unknown[][], name: string, ...args: unknown[]): void {
	const found = calls.some((c) => args.every((a, i) => matches(a, c[i])));
	assert.ok(found, `${name}: expected ${JSON.stringify(args, jsonReplacer)} among ${describeCalls(calls)}`);
}

function expectNotCalledWith(calls: unknown[][], name: string, ...args: unknown[]): void {
	const found = calls.some((c) => args.every((a, i) => matches(a, c[i])));
	assert.ok(!found, `${name}: did not expect ${JSON.stringify(args, jsonReplacer)} among ${describeCalls(calls)}`);
}

function expectLastCalledWith(calls: unknown[][], name: string, ...args: unknown[]): void {
	const last = calls.at(-1);
	const found = last !== undefined && args.every((a, i) => matches(a, (last as unknown[])[i]));
	assert.ok(found, `${name}: expected last call ${JSON.stringify(args, jsonReplacer)} but last was ${JSON.stringify(last, jsonReplacer)}`);
}

function expectCallCount(calls: unknown[][], name: string, n: number): void {
	assert.equal(calls.length, n, `${name}: expected ${n} call(s), got ${calls.length} — ${describeCalls(calls)}`);
}

// ─── Test scaffolding ─────────────────────────────────────────────────────

// A vi.fn()-style callable: the function IS the spy, with .calls/.queue and a
// live .impl accessor attached.
type SpyFn = ((...args: unknown[]) => unknown) & {
	calls: unknown[][];
	queue: unknown[];
	impl: ((...args: unknown[]) => unknown) | null;
};

function spy(initial?: (...args: unknown[]) => unknown): SpyFn {
	const calls: unknown[][] = [];
	const queue: unknown[] = [];
	let impl: ((...args: unknown[]) => unknown) | null = initial ?? null;
	const fn = ((...args: unknown[]) => {
		calls.push(args);
		if (queue.length > 0) {
			const next = queue.shift()!;
			if (typeof next === "function") return (next as (...a: unknown[]) => unknown)(...args);
			if (next instanceof Error) throw next;
			return next;
		}
		return impl ? impl(...args) : undefined;
	}) as SpyFn;
	fn.calls = calls;
	fn.queue = queue;
	Object.defineProperty(fn, "impl", {
		get: () => impl,
		set: (v) => {
			impl = v ?? null;
		},
		configurable: true,
	});
	return fn;
}

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;
type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

function createMockPi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	let sessionName = "";
	const on = spy((event: string, handler: Handler) => {
		if (!handlers.has(event)) handlers.set(event, []);
		handlers.get(event)!.push(handler);
	}) as SpyFn;
	const registerCommand = spy((name: string, def: { handler: CommandHandler }) => {
		commands.set(name, def.handler);
	}) as SpyFn;
	const setSessionName = spy((name: string) => {
		sessionName = name;
	}) as SpyFn;
	const getSessionName = spy(() => sessionName) as SpyFn;
	return {
		on,
		registerCommand,
		setSessionName,
		getSessionName,
		async fire(event: string, ctx?: unknown, eventData?: Record<string, unknown>): Promise<void> {
			for (const h of handlers.get(event) ?? []) {
				await h({ type: event, ...(eventData ?? {}) }, ctx);
			}
		},
		async runCommand(name: string, args: string, ctx?: unknown): Promise<void> {
			const handler = commands.get(name);
			if (!handler) throw new Error(`No command registered: ${name}`);
			await handler(args, ctx);
		},
	};
}

interface MockCtxOptions {
	cwd?: string;
	hasUI?: boolean;
	branch?: unknown[];
	findModel?: SpyFn;
	getApiKeyAndHeaders?: SpyFn | null;
	getApiKey?: SpyFn;
}

function createMockCtx(opts: MockCtxOptions = {}) {
	const ui = {
		setTitle: spy(),
		setWidget: spy(),
		notify: spy(),
	};
	const modelRegistry: Record<string, unknown> = {
		find: opts.findModel ?? spy(() => ({ id: "claude-haiku-4-5", provider: "anthropic" })),
	};
	if (opts.getApiKeyAndHeaders !== null) {
		modelRegistry.getApiKeyAndHeaders = opts.getApiKeyAndHeaders ?? spy(async () => ({ ok: true, apiKey: "test-key", headers: {} }));
	}
	if (opts.getApiKey) modelRegistry.getApiKey = opts.getApiKey;
	return {
		hasUI: opts.hasUI ?? true,
		cwd: opts.cwd ?? "/Users/me/world/trees/root/src/areas/core/myapp",
		ui,
		sessionManager: { getBranch: spy(() => opts.branch ?? []) },
		modelRegistry,
	};
}

function userMsg(text: string) {
	return { type: "message", message: { role: "user", content: text } };
}
function assistantMsg(text: string) {
	return { type: "message", message: { role: "assistant", content: text } };
}

/** Wait for fire-and-forget promise chains in agent_end to settle. */
function flushMicrotasks(times = 20): Promise<void> {
	let p = Promise.resolve();
	for (let i = 0; i < times; i++) p = p.then(() => undefined);
	return p;
}

function mockHaikuResponse(text: string) {
	stubs.completeOnce.push({
		content: [
			{ type: "text", text },
			{ type: "tool_use", input: {} },
		],
	});
}

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function mockCmuxTree(panes: unknown[], workspaceRef = "workspace:7", callerWorkspaceRef = workspaceRef) {
	mockCmuxTreeOutput(
		JSON.stringify({
			caller: { workspace_ref: callerWorkspaceRef },
			windows: [{ workspaces: [{ ref: workspaceRef, panes }] }],
		}),
	);
}

function mockCmuxTreeOutput(stdout: string, error: Error | null = null) {
	stubs.execFileImpl = (command, args, callback?: ExecFileCallback) => {
		if (command === "cmux" && Array.isArray(args) && args[0] === "--json" && args[1] === "tree") {
			callback?.(error, stdout, "");
		} else {
			callback?.(null, "", "");
		}
		return {} as never;
	};
}

function cmuxRenameCalls() {
	return stubs.execFileCalls.filter(([, args]) => Array.isArray(args) && args[0] === "rename-workspace");
}

function herdrTabRenameCalls() {
	return stubs.execFileCalls.filter(
		([command, args]) => command === "herdr" && Array.isArray(args) && args[0] === "tab" && args[1] === "rename",
	);
}

function herdrTabGetOutput(label: unknown): string {
	return JSON.stringify({
		id: "cli:tab:get",
		result: { tab: { label }, type: "tab_info" },
	});
}

function mockHerdrCliLabel(initialLabel: string) {
	let currentLabel = initialLabel;
	stubs.execFileImpl = (command, args, callback?: ExecFileCallback) => {
		if (command === "herdr" && Array.isArray(args) && args[0] === "tab" && args[1] === "get") {
			callback?.(null, herdrTabGetOutput(currentLabel), "");
		} else if (command === "herdr" && Array.isArray(args) && args[0] === "tab" && args[1] === "rename") {
			currentLabel = String(args[3] ?? "");
			callback?.(null, "", "");
		} else {
			callback?.(null, "", "");
		}
		return {} as never;
	};
	return {
		setLabel(label: string) {
			currentLabel = label;
		},
		getLabel() {
			return currentLabel;
		},
	};
}

// ─── Per-test lifecycle ───────────────────────────────────────────────────

const BANNER_ENV_KEYS = [
	"PI_SESSION_BANNER_WIDGET",
	"PI_SESSION_BANNER_TITLE_ORDER",
	"PI_SESSION_BANNER_PROVIDER",
	"PI_SESSION_BANNER_MODEL",
	"CMUX_WORKSPACE_ID",
	"HERDR_ENV",
	"HERDR_TAB_ID",
	"HERDR_SOCKET_PATH",
];
const originalRandom = Math.random;

function withFakeTimers(run: (tick: (ms: number) => void) => Promise<void>): Promise<void> {
	return (async () => {
		// "Date" must be faked too (vi.setSystemTime equivalent): the extension
		// compares Date.now() against its last-paint timestamps.
		mock.timers.enable({ apis: ["setTimeout", "setInterval", "setImmediate", "Date"], now: 1_000_000 });
		try {
			await run((ms) => mock.timers.tick(ms));
		} finally {
			mock.timers.reset();
		}
	})();
}

beforeEach(() => {
	resetStubs();
	for (const key of BANNER_ENV_KEYS) delete process.env[key];
	// Make randomEmoji / randomTitleColor deterministic.
	Math.random = () => 0;
	// Fresh pane registry per test (the implementation and this file share the
	// globalThis singleton via ./panes.ts).
	delete (globalThis as Record<string, unknown>).__piRichEditorPanes;
});

afterEach(() => {
	Math.random = originalRandom;
	for (const key of BANNER_ENV_KEYS) delete process.env[key];
	// Detach any host a test attached so later tests aren't affected by leakage.
	paneRegistry().setHost(null);
});

// ─── Tests ───────────────────────────────────────────────────────────────

test("session-banner: registers /title and the lifecycle hooks", () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	expectCalledWith(pi.registerCommand.calls, "registerCommand", "title", anything());
	const events = pi.on.calls.map((c) => c[0]);
	const expected = ["session_start", "session_shutdown", "session_switch", "session_fork", "before_agent_start", "agent_end"];
	assert.ok(expected.every((e) => events.includes(e)), `expected ${JSON.stringify(expected)} among ${JSON.stringify(events)}`);
});

test("session-banner > rich-editor host: defers to the host and drops its own widget when a pane host is attached", async () => {
	const reg = paneRegistry();
	const requestRender = spy();
	reg.setHost({ requestRender: requestRender, onPanesChanged: spy() });
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F680} ship the release";
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);

	// No standalone widget — the host composes our banner pane instead — and
	// the host is asked to repaint so the restored title lands immediately.
	expectCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", undefined);
	expectNotCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", anyFn());
	assert.ok(requestRender.calls.length >= 1, "host should be asked to repaint");

	// The winning banner pane (order -10) renders the restored title.
	const pane = reg.banner();
	assert.equal(pane?.id, "session-banner:banner");
	assert.equal(pane?.order, -10);
	const rendered = pane?.render(ctx as never) as { slot: string; emoji: string; label: string; color: string } | null;
	assert.ok(rendered !== null, "banner pane should render the restored title");
	assert.equal(rendered!.slot, "banner");
	assert.equal(rendered!.emoji, "\u{1F680}");
	assert.equal(rendered!.label, "ship the release");
	assert.equal(typeof rendered!.color, "string");
});

test("session-banner > rich-editor host: banner pane renders null while the session is unnamed", async () => {
	const reg = paneRegistry();
	reg.setHost({ requestRender: spy(), onPanesChanged: spy() });
	const pi = createMockPi();
	pi.getSessionName.impl = () => "";
	sessionBanner(pi as never);
	await pi.fire("session_start", createMockCtx());
	assert.equal(reg.banner()?.render(createMockCtx() as never), null);
});

test("session-banner > rich-editor host: banner pane renders null when PI_SESSION_BANNER_WIDGET=off", async () => {
	process.env.PI_SESSION_BANNER_WIDGET = "off";
	const reg = paneRegistry();
	reg.setHost({ requestRender: spy(), onPanesChanged: spy() });
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F680} ship the release";
	sessionBanner(pi as never);
	await pi.fire("session_start", createMockCtx());
	assert.equal(reg.banner()?.render(createMockCtx() as never), null);
});

test("session-banner > rich-editor host: unregisters its banner pane on quit so no dead closure survives", async () => {
	const reg = paneRegistry();
	reg.setHost({ requestRender: spy(), onPanesChanged: spy() });
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F680} ship it";
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);
	assert.equal(reg.banner()?.id, "session-banner:banner");

	await pi.fire("session_shutdown", ctx, { reason: "quit" });
	assert.equal(reg.banner(), null);
});

test("session-banner > rich-editor host: keeps its banner pane on a non-quit shutdown (session replacement)", async () => {
	const reg = paneRegistry();
	reg.setHost({ requestRender: spy(), onPanesChanged: spy() });
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F680} ship it";
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);

	await pi.fire("session_shutdown", ctx, { reason: "new" });
	assert.equal(reg.banner()?.id, "session-banner:banner");
});

test("session-banner > rich-editor host: unregisters its banner pane on reload so a disabled/failed reload leaves no stale closure", async () => {
	const reg = paneRegistry();
	reg.setHost({ requestRender: spy(), onPanesChanged: spy() });
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F680} ship it";
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);
	assert.equal(reg.banner()?.id, "session-banner:banner");

	await pi.fire("session_shutdown", ctx, { reason: "reload" });
	assert.equal(reg.banner(), null);
});

test("session-banner > rich-editor host: hands off to a host that attaches after session_start (80ms recheck)", async () => {
	await withFakeTimers(async (tick) => {
		const reg = paneRegistry();
		// No host yet when session_start fires: a named session draws its own
		// standalone widget.
		const pi = createMockPi();
		pi.getSessionName.impl = () => "\u{1F680} ship it";
		sessionBanner(pi as never);
		const ctx = createMockCtx();
		await pi.fire("session_start", ctx);
		expectLastCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", anyFn());

		// The editor host attaches during the first paint (after session_start).
		// The 80ms recheck re-evaluates and hands the banner to the host.
		const requestRender = spy();
		reg.setHost({ requestRender: requestRender, onPanesChanged: spy() });
		tick(80);
		await flushMicrotasks();

		expectLastCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", undefined);
		assert.ok(requestRender.calls.length >= 1, "host should be asked to repaint");
	});
});

test("session-banner > rich-editor host: keeps polling and hands off to a host that attaches several paints later", async () => {
	await withFakeTimers(async (tick) => {
		const reg = paneRegistry();
		const pi = createMockPi();
		pi.getSessionName.impl = () => "\u{1F680} ship it";
		sessionBanner(pi as never);
		const ctx = createMockCtx();
		await pi.fire("session_start", ctx);
		expectLastCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", anyFn());

		// A few rechecks pass with still no host (the widget stays put)…
		tick(240);
		await flushMicrotasks();
		expectLastCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", anyFn());

		// …then the editor host finally attaches and the next tick hands off.
		const requestRender = spy();
		reg.setHost({ requestRender: requestRender, onPanesChanged: spy() });
		tick(80);
		await flushMicrotasks();
		expectLastCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", undefined);
		assert.ok(requestRender.calls.length >= 1, "host should be asked to repaint");
	});
});

test("session-banner > rich-editor host: gives up polling after the window when no host ever attaches (stays standalone)", async () => {
	await withFakeTimers(async (tick) => {
		const pi = createMockPi();
		pi.getSessionName.impl = () => "\u{1F680} ship it";
		sessionBanner(pi as never);
		const ctx = createMockCtx();
		await pi.fire("session_start", ctx);
		expectLastCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", anyFn());

		// Poll for the full window (25 * 80ms) with no host, then give up.
		tick(25 * 80);
		await flushMicrotasks();
		// vi.getTimerCount() has no node:test equivalent — assert the behavior:
		// no further timer-driven paint activity happens after the window.
		const widgetCalls = ctx.ui.setWidget.calls.length;
		const titleCalls = ctx.ui.setTitle.calls.length;
		tick(2000);
		await flushMicrotasks();
		assert.equal(ctx.ui.setWidget.calls.length, widgetCalls, "recheck timer should have stopped");
		assert.equal(ctx.ui.setTitle.calls.length, titleCalls, "recheck timer should have stopped");
		// The standalone widget was never cleared to undefined.
		expectNotCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", undefined);
	});
});

test("session-banner > title re-asserts: re-asserts the title on the deferred schedule after session_start", async () => {
	await withFakeTimers(async (tick) => {
		const pi = createMockPi();
		pi.getSessionName.impl = () => "🔮 fix bug";
		sessionBanner(pi as never);
		const ctx = createMockCtx();
		await pi.fire("session_start", ctx);
		ctx.ui.setTitle.calls.length = 0;

		tick(150);
		expectCalledWith(ctx.ui.setTitle.calls, "setTitle", "π root //areas/core/myapp — 🔮 fix bug");

		ctx.ui.setTitle.calls.length = 0;
		tick(900);
		expectCalledWith(ctx.ui.setTitle.calls, "setTitle", "π root //areas/core/myapp — 🔮 fix bug");
	});
});

test("session-banner > title re-asserts: adopts a session name that loads after session_start ran", async () => {
	await withFakeTimers(async (tick) => {
		const pi = createMockPi();
		pi.getSessionName.impl = () => "";
		sessionBanner(pi as never);
		const ctx = createMockCtx();
		await pi.fire("session_start", ctx);
		ctx.ui.setTitle.calls.length = 0;

		// Session info (and its name) delivered asynchronously after start.
		pi.getSessionName.impl = () => "🧭 late name";
		tick(150);
		await flushMicrotasks();

		expectCalledWith(ctx.ui.setTitle.calls, "setTitle", stringContaining("🧭 late name"));
	});
});

test("session-banner > title re-asserts: cancels pending re-asserts on session_shutdown", async () => {
	await withFakeTimers(async (tick) => {
		const pi = createMockPi();
		pi.getSessionName.impl = () => "🔮 fix bug";
		sessionBanner(pi as never);
		const ctx = createMockCtx();
		await pi.fire("session_start", ctx);
		await pi.fire("session_shutdown", ctx, { reason: "quit" });
		ctx.ui.setTitle.calls.length = 0;

		tick(2000);
		await flushMicrotasks();
		assert.equal(ctx.ui.setTitle.calls.length, 0, "pending re-asserts must be canceled");
	});
});

test("session-banner > title re-asserts: re-arms the deferred re-asserts after a rename (core repaints on session_info_changed)", async () => {
	await withFakeTimers(async (tick) => {
		const pi = createMockPi();
		sessionBanner(pi as never);
		const ctx = createMockCtx();
		await pi.fire("session_start", ctx);
		tick(2000); // drain the boot re-asserts
		await flushMicrotasks();

		// Renames trigger a core repaint mid-idle; the rename's render
		// must re-arm the deferred re-asserts.
		await pi.runCommand("title", "shiny new name", ctx);

		ctx.ui.setTitle.calls.length = 0;
		tick(150);
		await flushMicrotasks();
		expectCalledWith(ctx.ui.setTitle.calls, "setTitle", stringContaining("shiny new name"));
	});
});

test("session-banner > title re-asserts: cancels the previous session's pending re-asserts on session_switch", async () => {
	await withFakeTimers(async (tick) => {
		const pi = createMockPi();
		pi.getSessionName.impl = () => "🅰️ session a";
		sessionBanner(pi as never);
		const ctx = createMockCtx();
		await pi.fire("session_start", ctx); // arms re-asserts at t=150/t=1000

		tick(100); // t=100: nothing fired yet
		pi.getSessionName.impl = () => "🅱️ session b";
		await pi.fire("session_switch", ctx); // must cancel A's timers

		// Window where A's leaked timer (t=150) would fire but B's first
		// re-assert has not. A leaked timer paints with post-switch state, so
		// content-based assertions can't catch it — only the timing window can.
		ctx.ui.setTitle.calls.length = 0;
		tick(120); // t=220: only B's deferred restore (t=150) should paint
		assert.equal(ctx.ui.setTitle.calls.length, 1, "a leaked A timer would make this 2");

		// Node's mock.timers: a timer scheduled inside a tick callback is due
		// at tickTarget + delay (fakeNow is the target during the tick), so B's
		// first re-assert (restore at t=220 + 150ms) lands at t=370 — tick past
		// it strictly (vitest's boundary-exact firing is not replicated).
		ctx.ui.setTitle.calls.length = 0;
		tick(200); // t=420: B's first re-assert (t=370) fires
		expectCalledWith(ctx.ui.setTitle.calls, "setTitle", stringContaining("🅱️ session b"));
	});
});

test("session-banner > title re-asserts: re-asserts the title after the deferred session_switch restore", async () => {
	await withFakeTimers(async (tick) => {
		const pi = createMockPi();
		pi.getSessionName.impl = () => "⚡ other session";
		sessionBanner(pi as never);
		const ctx = createMockCtx();
		await pi.fire("session_switch", ctx);

		tick(50); // deferred restore paints
		await flushMicrotasks();
		ctx.ui.setTitle.calls.length = 0;
		tick(150); // first scheduled re-assert
		await flushMicrotasks();
		expectCalledWith(ctx.ui.setTitle.calls, "setTitle", stringContaining("⚡ other session"));
	});
});

test("session-banner > agent turns: does not double-paint when an externally changed name was adopted", async () => {
	const pi = createMockPi();
	pi.getSessionName.impl = () => "🔮 fix bug";
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);

	// Name changed externally between turns (e.g. another tool renamed it).
	pi.getSessionName.impl = () => "⚡ renamed";
	ctx.ui.setTitle.calls.length = 0;

	await pi.fire("before_agent_start", ctx, { prompt: "next" });

	// Adoption renders exactly once; the handler skips its own repaint.
	expectCallCount(ctx.ui.setTitle.calls, "setTitle", 1);
	expectCalledWith(ctx.ui.setTitle.calls, "setTitle", stringContaining("⚡ renamed"));
});

test("session-banner > agent turns: repaints the terminal title on before_agent_start for an already-named session", async () => {
	const pi = createMockPi();
	pi.getSessionName.impl = () => "🔮 fix bug";
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);
	ctx.ui.setTitle.calls.length = 0;

	await pi.fire("before_agent_start", ctx, { prompt: "next step" });

	expectCalledWith(ctx.ui.setTitle.calls, "setTitle", "π root //areas/core/myapp — 🔮 fix bug");
});

test("session-banner > agent turns: repaints the terminal title on agent_end for an already-named session", async () => {
	const pi = createMockPi();
	pi.getSessionName.impl = () => "🔮 fix bug";
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);
	ctx.ui.setTitle.calls.length = 0;

	await pi.fire("agent_end", ctx);
	await flushMicrotasks();

	expectCalledWith(ctx.ui.setTitle.calls, "setTitle", "π root //areas/core/myapp — 🔮 fix bug");
});

test("session-banner > agent turns: respects PI_SESSION_BANNER_TITLE_ORDER=label-first when repainting on agent_end", async () => {
	process.env.PI_SESSION_BANNER_TITLE_ORDER = "label-first";
	const pi = createMockPi();
	pi.getSessionName.impl = () => "🔮 fix bug";
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);
	ctx.ui.setTitle.calls.length = 0;

	await pi.fire("agent_end", ctx);
	await flushMicrotasks();

	expectCalledWith(ctx.ui.setTitle.calls, "setTitle", "π 🔮 fix bug — root //areas/core/myapp");
});

test("session-banner > session_start: sets terminal title and hides widget when there is no existing label", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);
	expectCalledWith(ctx.ui.setTitle.calls, "setTitle", "π root //areas/core/myapp");
	expectCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", undefined);
});

test("session-banner > session_start: restores label + emoji from existing session name and renders the banner widget", async () => {
	const pi = createMockPi();
	pi.getSessionName.impl = () => "🔮 fix bug";
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);

	expectCalledWith(ctx.ui.setTitle.calls, "setTitle", "π root //areas/core/myapp — 🔮 fix bug");
	const widgetCall = ctx.ui.setWidget.calls.find((c) => typeof c[1] === "function");
	assert.ok(widgetCall !== undefined, "expected a widget factory registration");
	const factory = widgetCall![1] as (tui: unknown, theme: { fg: (c: string, s: string) => string; bold: (s: string) => string }) => any;
	const theme = {
		fg: (_color: string, s: string) => s,
		bold: (s: string) => s,
	};
	const widget = factory({}, theme);
	const lines = widget.render(20);
	assert.equal(lines.length, 3);
	assert.ok(String(lines[1]).includes("🔮"));
	assert.ok(String(lines[1]).includes("fix bug"));
	// invalidate is a no-op but exists
	assert.doesNotThrow(() => widget.invalidate());
});

test("session-banner > session_start: does nothing when hasUI is false", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ hasUI: false });
	await pi.fire("session_start", ctx);
	assert.equal(ctx.ui.setTitle.calls.length, 0);
	assert.equal(ctx.ui.setWidget.calls.length, 0);
});

test("session-banner > PI_SESSION_BANNER_WIDGET: hides the banner widget but keeps the terminal title when set to off", async () => {
	process.env.PI_SESSION_BANNER_WIDGET = "off";
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F52E} fix bug";
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);

	// Terminal/tab title (and the pi session name) still flow through.
	expectCalledWith(ctx.ui.setTitle.calls, "setTitle", "\u03C0 root //areas/core/myapp \u2014 \u{1F52E} fix bug");
	// No widget factory is ever registered; the widget is explicitly cleared.
	const widgetFactoryCall = ctx.ui.setWidget.calls.find((c) => typeof c[1] === "function");
	assert.equal(widgetFactoryCall, undefined);
	expectCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", undefined);
});

test("session-banner > PI_SESSION_BANNER_WIDGET: renders the banner widget by default when the env var is unset", async () => {
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F52E} fix bug";
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);
	const widgetFactoryCall = ctx.ui.setWidget.calls.find((c) => typeof c[1] === "function");
	assert.ok(widgetFactoryCall !== undefined);
});

test("session-banner > PI_SESSION_BANNER_TITLE_ORDER: puts the label first and tree/zone context last when set to label-first", async () => {
	process.env.PI_SESSION_BANNER_TITLE_ORDER = "label-first";
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F52E} fix bug";
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);

	expectCalledWith(ctx.ui.setTitle.calls, "setTitle", "\u03C0 \u{1F52E} fix bug \u2014 root //areas/core/myapp");
});

test("session-banner > PI_SESSION_BANNER_TITLE_ORDER: keeps the context-only title unchanged for unnamed sessions in label-first", async () => {
	process.env.PI_SESSION_BANNER_TITLE_ORDER = "label-first";
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);

	expectCalledWith(ctx.ui.setTitle.calls, "setTitle", "\u03C0 root //areas/core/myapp");
});

test("session-banner > PI_SESSION_BANNER_TITLE_ORDER: defaults to zone-first when the env var is unset", async () => {
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F52E} fix bug";
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);

	expectCalledWith(ctx.ui.setTitle.calls, "setTitle", "\u03C0 root //areas/core/myapp \u2014 \u{1F52E} fix bug");
});

test("session-banner > PI_SESSION_BANNER_TITLE_ORDER: falls back to zone-first on unrecognized values", async () => {
	process.env.PI_SESSION_BANNER_TITLE_ORDER = "labelfirst";
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F52E} fix bug";
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);

	expectCalledWith(ctx.ui.setTitle.calls, "setTitle", "\u03C0 root //areas/core/myapp \u2014 \u{1F52E} fix bug");
});

test("session-banner > session_switch: defers and re-renders for the new session", async () => {
	await withFakeTimers(async (tick) => {
		const pi = createMockPi();
		pi.getSessionName.impl = () => "⚡ other session";
		sessionBanner(pi as never);
		const ctx = createMockCtx();

		await pi.fire("session_switch", ctx);
		// Hasn't fired yet — deferred 50ms
		assert.equal(ctx.ui.setTitle.calls.length, 0);

		tick(50);
		await flushMicrotasks();
		expectCalledWith(ctx.ui.setTitle.calls, "setTitle", stringContaining("⚡ other session"));
	});
});

test("session-banner > session_switch: cancels a pending deferred render when another session switch happens", async () => {
	await withFakeTimers(async (tick) => {
		const pi = createMockPi();
		sessionBanner(pi as never);
		const firstCtx = createMockCtx({ cwd: "/Users/me/world/trees/root/src/areas/core/myapp" });
		const secondCtx = createMockCtx({ cwd: "/Users/me/world/trees/root/src/areas/apps/flow" });

		await pi.fire("session_switch", firstCtx);
		await pi.fire("session_switch", secondCtx);
		tick(50);
		await flushMicrotasks();

		assert.equal(firstCtx.ui.setTitle.calls.length, 0);
		expectCalledWith(secondCtx.ui.setTitle.calls, "setTitle", "π root //areas/apps/flow");
	});
});

test("session-banner > session_switch: cancels a pending deferred render when the session is forked", async () => {
	await withFakeTimers(async (tick) => {
		const pi = createMockPi();
		sessionBanner(pi as never);
		const switchCtx = createMockCtx({ cwd: "/Users/me/world/trees/root/src/areas/core/myapp" });
		const forkCtx = createMockCtx({ cwd: "/Users/me/world/trees/root/src/areas/platforms/agent-server" });

		await pi.fire("session_switch", switchCtx);
		await pi.fire("session_fork", forkCtx);
		tick(50);
		await flushMicrotasks();

		assert.equal(switchCtx.ui.setTitle.calls.length, 0);
		expectCalledWith(forkCtx.ui.setTitle.calls, "setTitle", "π root //areas/platforms/agent-server");
	});
});

test("session-banner > session_fork: re-arms auto-naming when an unnamed new branch follows a named session", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("forked work title");
	const ctx = createMockCtx({ branch: [] });
	pi.getSessionName.impl = () => "\u{1F52E} parent task";
	await pi.fire("session_start", ctx);
	pi.getSessionName.impl = () => "";

	await pi.fire("session_fork", ctx);
	expectLastCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", undefined);

	// Unnamed fork -> auto-naming proceeds on the next turn.
	await pi.fire("before_agent_start", ctx, { prompt: "specific forked prompt" });
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 1);
	expectCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ forked work title$/));
});

test("session-banner > session_fork: renders an inherited parent name and does not re-auto-name when a fork carries it", async () => {
	// Forking after an auto-name landed: Pi copies the parent's session_info
	// (name) into the branched session, so getSessionName() is non-empty.
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F52E} parent task";
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [userMsg("do the parent task")] });
	await pi.fire("session_fork", ctx);

	// Banner shows the inherited name instead of being hidden.
	expectCalledWith(ctx.ui.setTitle.calls, "setTitle", stringContaining("\u{1F52E} parent task"));
	const widgetCall = ctx.ui.setWidget.calls.find((c) => typeof c[1] === "function");
	assert.ok(widgetCall !== undefined);

	// Auto-naming stays off — the fork keeps the inherited name (no back-off wedge).
	await pi.fire("before_agent_start", ctx, { prompt: "do the parent task" });
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();
	assert.equal(stubs.completeCalls.length, 0);
});

test("session-banner > session_branch (OMP): re-arms auto-naming when an unnamed new branch follows a named session", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("branched OMP work title");
	const ctx = createMockCtx({ branch: [] });
	pi.getSessionName.impl = () => "\u{1F52E} parent task";
	await pi.fire("session_start", ctx);
	pi.getSessionName.impl = () => "";

	await pi.fire("session_branch", ctx);
	expectLastCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", undefined);

	await pi.fire("before_agent_start", ctx, { prompt: "specific OMP branch prompt" });
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 1);
	expectCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ branched OMP work title$/));
});
test("session-banner > headless: session_switch does nothing when there is no UI", async () => {
	await withFakeTimers(async (tick) => {
		const pi = createMockPi();
		pi.getSessionName.impl = () => "\u26A1 other session";
		sessionBanner(pi as never);
		const ctx = createMockCtx({ hasUI: false });

		await pi.fire("session_switch", ctx);
		tick(50);

		expectCallCount(ctx.ui.setTitle.calls, "setTitle", 0);
		expectCallCount(ctx.ui.setWidget.calls, "setWidget", 0);
	});
});

test("session-banner > headless: session_fork does nothing when there is no UI", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("forked work title");
	const ctx = createMockCtx({ hasUI: false, branch: [] });

	await pi.fire("session_fork", ctx);
	await pi.fire("before_agent_start", ctx, { prompt: "specific forked prompt" });
	await flushMicrotasks();

	expectCallCount(ctx.ui.setWidget.calls, "setWidget", 0);
	expectCallCount(stubs.completeCalls, "complete", 0);
});

test("session-banner > headless: before_agent_start does not auto-name when there is no UI", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("headless title");
	const ctx = createMockCtx({ hasUI: false });

	await pi.fire("before_agent_start", ctx, { prompt: "fix the checkout tax bug" });
	await flushMicrotasks();

	expectCallCount(stubs.completeCalls, "complete", 0);
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
});

// Legacy runtimes report hasUI === undefined. The strict `=== false` guard
// lets them through (conservative fallback), and paintBanner's own `!hasUI`
// check is what keeps a headless legacy session from touching the title.
test("session-banner > headless: session_start with undefined hasUI passes the guard but paintBanner still no-ops", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	(ctx as Record<string, unknown>).hasUI = undefined;

	await pi.fire("session_start", ctx);

	expectCallCount(ctx.ui.setTitle.calls, "setTitle", 0);
	expectCallCount(ctx.ui.setWidget.calls, "setWidget", 0);
});

test("session-banner > shutdown: clears the terminal title on a real quit so it doesn't linger after pi exits", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	ctx.ui.setTitle.calls.length = 0;

	await pi.fire("session_shutdown", ctx, { reason: "quit" });

	expectCalledWith(ctx.ui.setTitle.calls, "setTitle", "");
});

test("session-banner > shutdown: clears the title when shutdown carries no reason (older SDK fires it only on exit)", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	ctx.ui.setTitle.calls.length = 0;

	await pi.fire("session_shutdown", ctx);

	expectCalledWith(ctx.ui.setTitle.calls, "setTitle", "");
});

test("session-banner > shutdown: clears the title on reload so a reload-to-disabled doesn't leave a stale title", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	ctx.ui.setTitle.calls.length = 0;

	await pi.fire("session_shutdown", ctx, { reason: "reload" });

	expectCalledWith(ctx.ui.setTitle.calls, "setTitle", "");
});

for (const reason of ["new", "resume", "fork"]) {
	test(`session-banner > shutdown: does not clear the title on a ${reason} replacement (the same instance's session_switch re-sets it)`, async () => {
		const pi = createMockPi();
		sessionBanner(pi as never);
		const ctx = createMockCtx();
		ctx.ui.setTitle.calls.length = 0;

		await pi.fire("session_shutdown", ctx, { reason });

		expectCallCount(ctx.ui.setTitle.calls, "setTitle", 0);
	});
}

test("session-banner > shutdown: does not touch the title on quit when there is no UI (print mode)", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ hasUI: false });
	ctx.ui.setTitle.calls.length = 0;

	await pi.fire("session_shutdown", ctx, { reason: "quit" });

	expectCallCount(ctx.ui.setTitle.calls, "setTitle", 0);
});

test("session-banner > shutdown: does not throw when the shutdown event is malformed (null) and treats it as a quit", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	ctx.ui.setTitle.calls.length = 0;

	const shutdownHandler = pi.on.calls.find((c) => c[0] === "session_shutdown")?.[1] as Handler;
	assert.ok(shutdownHandler !== undefined, "session_shutdown handler should be registered");

	assert.equal(await shutdownHandler(null, ctx), undefined);
	expectCalledWith(ctx.ui.setTitle.calls, "setTitle", "");
});

test("session-banner > auto-naming: calls Haiku, sets the session name with emoji, and renders the banner (agent_end path)", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("fix flaky pagination test");
	const ctx = createMockCtx({ branch: [userMsg("help me debug a flaky test")] });

	await pi.fire("session_start", ctx);
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();

	expectCallCount(stubs.completeCalls, "complete", 1);
	expectCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ fix flaky pagination test$/));
});

test("session-banner > auto-naming: uses the contextual emoji the model prefixes onto the title", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("\u{1F41B} fix checkout tax bug");
	const ctx = createMockCtx({ branch: [userMsg("the checkout tax is wrong")] });

	await pi.fire("session_start", ctx);
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();

	expectCalledWith(pi.setSessionName.calls, "setSessionName", "\u{1F41B} fix checkout tax bug");
});

test("session-banner > auto-naming: falls back to a random emoji when the model omits one", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	// Math.random is mocked to 0 -> SESSION_EMOJI[0] = \u{1F52E}.
	mockHaikuResponse("plain title no emoji");
	const ctx = createMockCtx({ branch: [userMsg("do the thing")] });

	await pi.fire("session_start", ctx);
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();

	expectCalledWith(pi.setSessionName.calls, "setSessionName", "\u{1F52E} plain title no emoji");
});

test("session-banner > auto-naming: uses the contextual emoji + label from the model when naming", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("\u{1F9EA} add test coverage");
	const ctx = createMockCtx({ branch: [] });

	await pi.fire("session_start", ctx);
	await pi.fire("before_agent_start", ctx, { prompt: "add some tests" });
	await flushMicrotasks();
	expectLastCalledWith(pi.setSessionName.calls, "setSessionName", "\u{1F9EA} add test coverage");
});

test("session-banner > auto-naming: locks the name after the first confident auto-name; a later turn does not overwrite it", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("\u{1F9EA} add test coverage");
	const ctx = createMockCtx({ branch: [] });

	await pi.fire("session_start", ctx);
	await pi.fire("before_agent_start", ctx, { prompt: "add some tests" });
	await flushMicrotasks();
	expectLastCalledWith(pi.setSessionName.calls, "setSessionName", "\u{1F9EA} add test coverage");
	expectCallCount(stubs.completeCalls, "complete", 1);

	// A later turn about a follow-up must NOT re-name the session — the
	// original intent stays locked in. Haiku is never called again.
	mockHaikuResponse("\u{1F41B} fix failing test");
	ctx.sessionManager.getBranch.impl = () => [userMsg("add some tests")];
	await pi.fire("before_agent_start", ctx, { prompt: "now also fix the failing one" });
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 1);
	expectLastCalledWith(pi.setSessionName.calls, "setSessionName", "\u{1F9EA} add test coverage");
});

test("session-banner > auto-naming: names from the very first user message via before_agent_start, before agent_end fires", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("fix checkout tax bug");
	// Branch is empty at before_agent_start time — the new prompt isn't persisted yet.
	const ctx = createMockCtx({ branch: [] });

	await pi.fire("session_start", ctx);
	await pi.fire("before_agent_start", ctx, { prompt: "fix the checkout tax bug in checkout_tax.rb" });
	await flushMicrotasks();

	expectCallCount(stubs.completeCalls, "complete", 1);
	expectCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ fix checkout tax bug$/));

	// The prompt is spliced into the conversation context sent to Haiku.
	const completeArgs = stubs.completeCalls[0] as unknown[];
	const userText = ((completeArgs[1] as { messages: { content: { text: string }[] }[] }).messages[0].content[0].text) as string;
	assert.ok(userText.includes("fix the checkout tax bug in checkout_tax.rb"), `userText=${userText}`);
});

test("session-banner > auto-naming: does not re-name on agent_end after a successful early naming (locked)", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("first naming");
	const ctx = createMockCtx({ branch: [] });

	await pi.fire("session_start", ctx);
	await pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 1);
	expectLastCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ first naming$/));

	// agent_end fires after the early call already named the session — the
	// late backstop must be a no-op now, not a second Haiku call that churns
	// the title.
	mockHaikuResponse("refined naming");
	ctx.sessionManager.getBranch.impl = () => [userMsg("specific opening prompt")];
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 1);
	expectLastCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ first naming$/));
});

test("session-banner > auto-naming: early SKIP defers naming, agent_end retries with assistant context", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	// Early call: vague prompt — Haiku skips.
	mockHaikuResponse("SKIP");
	// Late call: assistant reply now in context, Haiku produces a title.
	mockHaikuResponse("investigate flaky checkout test");

	const ctx = createMockCtx({ branch: [] });
	await pi.fire("session_start", ctx);
	await pi.fire("before_agent_start", ctx, { prompt: "help" });
	await flushMicrotasks();
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);

	ctx.sessionManager.getBranch.impl = () => [
		userMsg("help"),
		{ type: "message", message: { role: "assistant", content: "Sure — what specifically?" } },
	];
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();

	expectCallCount(stubs.completeCalls, "complete", 2);
	expectCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ investigate flaky checkout test$/));
});

test("session-banner > auto-naming: successive SKIPs across turns wait until a turn produces a title", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [] });
	await pi.fire("session_start", ctx);

	// Turn 1 early: vague prompt — Haiku skips.
	mockHaikuResponse("SKIP");
	await pi.fire("before_agent_start", ctx, { prompt: "hi" });
	await flushMicrotasks();

	// Turn 1 late: assistant has now replied. Branch has user + assistant.
	// Haiku is still not sure — SKIP again.
	mockHaikuResponse("SKIP");
	ctx.sessionManager.getBranch.impl = () => [
		userMsg("hi"),
		{ type: "message", message: { role: "assistant", content: "What do you want to do?" } },
	];
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
	expectCallCount(stubs.completeCalls, "complete", 2);

	// Turn 2 early: a specific prompt — Haiku names it.
	mockHaikuResponse("add bandit dashboard");
	await pi.fire("before_agent_start", ctx, {
		prompt: "add a bandit dashboard for the f_storefront_agent rollout",
	});
	await flushMicrotasks();
	expectCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ add bandit dashboard$/));
});

test("session-banner > auto-naming: stops retrying an unnamed session after MAX_AUTO_TURNS (3) user turns", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [userMsg("hi")] });

	await pi.fire("session_start", ctx);
	// Every turn stays vague, so Haiku keeps SKIPping and the session stays
	// unnamed — this is the only case where the per-turn cap matters (a
	// confident name would lock and stop retrying regardless).
	for (let i = 0; i < 3; i++) {
		mockHaikuResponse("SKIP");
		await pi.fire("before_agent_start", ctx, { prompt: `turn ${i}` });
		await flushMicrotasks();
	}
	expectCallCount(stubs.completeCalls, "complete", 3);
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);

	// 4th turn — past the cap, should not call Haiku again from either hook.
	mockHaikuResponse("too late to name");
	await pi.fire("before_agent_start", ctx, { prompt: "turn 4" });
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 3);
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
});

test("session-banner > auto-naming: early call uses the SKIP-allowed system prompt; late call uses the SKIP-suppressed one", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [] });
	await pi.fire("session_start", ctx);

	// Early call SKIPs, so the session stays unnamed and the late backstop
	// still runs — letting us assert both system prompts.
	mockHaikuResponse("SKIP");
	await pi.fire("before_agent_start", ctx, { prompt: "vague prompt" });
	await flushMicrotasks();
	const earlyPrompt = (stubs.completeCalls[0][1] as { systemPrompt: string }).systemPrompt;
	assert.ok(earlyPrompt.includes("SKIP rule"), `earlyPrompt missing SKIP rule`);

	// Late call.
	mockHaikuResponse("late title");
	ctx.sessionManager.getBranch.impl = () => [
		userMsg("vague prompt"),
		{ type: "message", message: { role: "assistant", content: "Here's what I'll do." } },
	];
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();
	const latePrompt = (stubs.completeCalls[1][1] as { systemPrompt: string }).systemPrompt;
	assert.ok(!latePrompt.includes("SKIP rule"), "late prompt must not allow SKIP");
	assert.ok(latePrompt.includes("Always emit a title"), `latePrompt missing "Always emit a title"`);
});

test("session-banner > auto-naming: in-flight early call prevents agent_end from racing in the same turn", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [] });

	let resolveFirst: (v: unknown) => void;
	stubs.completeOnce.push(
		new Promise((r) => {
			resolveFirst = r as (v: unknown) => void;
		}),
	);
	await pi.fire("session_start", ctx);
	await pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });

	// agent_end fires before Haiku resolves — should not start a parallel call.
	await pi.fire("agent_end", ctx);
	expectCallCount(stubs.completeCalls, "complete", 1);

	// Now resolve the early call with a title. The queued late backstop is dropped.
	resolveFirst!({ content: [{ type: "text", text: "opening title" }] });
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 1);
	expectCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ opening title$/));
});

test("session-banner > auto-naming: runs a queued late backstop when the in-flight early call skips", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [] });

	let resolveFirst: (v: unknown) => void;
	stubs.completeOnce.push(
		new Promise((r) => {
			resolveFirst = r as (v: unknown) => void;
		}),
	);
	await pi.fire("session_start", ctx);
	await pi.fire("before_agent_start", ctx, { prompt: "help" });

	ctx.sessionManager.getBranch.impl = () => [
		userMsg("help"),
		{ type: "message", message: { role: "assistant", content: "Let's debug the flaky checkout test." } },
	];
	mockHaikuResponse("debug flaky checkout test");
	await pi.fire("agent_end", ctx);
	expectCallCount(stubs.completeCalls, "complete", 1);

	resolveFirst!({ content: [{ type: "text", text: "SKIP" }] });
	await flushMicrotasks();

	expectCallCount(stubs.completeCalls, "complete", 2);
	const latePrompt = (stubs.completeCalls[1][1] as { systemPrompt: string }).systemPrompt;
	assert.ok(latePrompt.includes("Always emit a title"), "late prompt must force a title");
	expectCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ debug flaky checkout test$/));
});

test("session-banner > auto-naming: does not queue another early attempt while a generation is in flight", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [] });

	let resolveFirst: (v: unknown) => void;
	stubs.completeOnce.push(
		new Promise((r) => {
			resolveFirst = r as (v: unknown) => void;
		}),
	);
	await pi.fire("session_start", ctx);
	await pi.fire("before_agent_start", ctx, { prompt: "first prompt" });
	await pi.fire("before_agent_start", ctx, { prompt: "second prompt" });
	expectCallCount(stubs.completeCalls, "complete", 1);

	resolveFirst!({ content: [{ type: "text", text: "SKIP" }] });
	await flushMicrotasks();

	expectCallCount(stubs.completeCalls, "complete", 1);
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
});

test("session-banner > auto-naming: backs off if the current name differs from the last auto-applied name", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("auto generated");
	const ctx = createMockCtx({ branch: [userMsg("specific opening prompt")] });

	await pi.fire("session_start", ctx);
	await pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 1);

	pi.getSessionName.impl = () => "user picked this";
	mockHaikuResponse("should not apply");
	await pi.fire("before_agent_start", ctx, { prompt: "another specific prompt" });
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();

	expectCallCount(stubs.completeCalls, "complete", 1);
	expectCallCount(pi.setSessionName.calls, "setSessionName", 1);
	expectLastCalledWith(ctx.ui.setTitle.calls, "setTitle", "\u03C0 root //areas/core/myapp \u2014 \u{1F52E} user picked this");
	expectLastCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", anyFn());
});

test("session-banner > auto-naming: adopts an externally cleared session name by hiding the banner", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("auto generated");
	const ctx = createMockCtx({ branch: [userMsg("specific opening prompt")] });

	await pi.fire("session_start", ctx);
	await pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });
	await flushMicrotasks();
	expectCallCount(pi.setSessionName.calls, "setSessionName", 1);

	pi.setSessionName.calls.length = 0;
	pi.getSessionName.impl = () => "";
	await pi.fire("before_agent_start", ctx, { prompt: "another specific prompt" });
	await flushMicrotasks();

	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
	expectLastCalledWith(ctx.ui.setTitle.calls, "setTitle", "\u03C0 root //areas/core/myapp");
	expectLastCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", undefined);
});

test("session-banner > auto-naming: continues adopting external renames after auto-naming backs off", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [userMsg("hi")] });

	await pi.fire("session_start", ctx);
	pi.getSessionName.impl = () => "first manual name";
	await pi.fire("before_agent_start", ctx, { prompt: "hi" });
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 0);
	expectLastCalledWith(ctx.ui.setTitle.calls, "setTitle", "\u03C0 root //areas/core/myapp \u2014 \u{1F52E} first manual name");

	pi.getSessionName.impl = () => "second manual name";
	await pi.fire("before_agent_start", ctx, { prompt: "hi again" });
	await flushMicrotasks();

	expectCallCount(stubs.completeCalls, "complete", 0);
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
	expectLastCalledWith(ctx.ui.setTitle.calls, "setTitle", "\u03C0 root //areas/core/myapp \u2014 \u{1F52E} second manual name");
	expectLastCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", anyFn());
});

test("session-banner > auto-naming: drops stale auto-name results after session_shutdown so stale `pi` handles are never touched", async () => {
	// When pi replaces the session (newSession / fork / switchSession / reload),
	// the OLD extension instance receives `session_shutdown` and its captured
	// `pi` / `ctx` become stale. A Haiku call still in flight must early-return
	// before calling `pi.getSessionName()` or `pi.setSessionName()`, otherwise
	// loader.assertActive throws and crashes pi. We assert that by failing the
	// captured `pi` after shutdown and confirming the late resolution does not
	// touch it.
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [] });
	let resolveAutoName: (v: unknown) => void;
	stubs.completeOnce.push(
		new Promise((r) => {
			resolveAutoName = r as (v: unknown) => void;
		}),
	);

	await pi.fire("session_start", ctx);
	await pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });
	await pi.fire("session_shutdown", ctx, { reason: "new" });

	// Simulate the captured `pi` becoming stale post-shutdown: any call to
	// getSessionName / setSessionName after this point would crash pi in
	// production with loader.assertActive.
	pi.getSessionName.calls.length = 0;
	pi.setSessionName.calls.length = 0;
	pi.getSessionName.impl = () => {
		throw new Error("stale ctx after session replacement");
	};
	pi.setSessionName.impl = () => {
		throw new Error("stale ctx after session replacement");
	};

	resolveAutoName!({ content: [{ type: "text", text: "late title" }] });
	await flushMicrotasks();

	// The epoch bump in session_shutdown gates the .then() so neither getter
	// nor setter is invoked after the session was replaced.
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
	expectCallCount(pi.getSessionName.calls, "getSessionName", 0);
});

test("session-banner > auto-naming: drops stale auto-name results after a session switch", async () => {
	await withFakeTimers(async (tick) => {
		const pi = createMockPi();
		sessionBanner(pi as never);
		const ctx = createMockCtx({ branch: [] });
		let resolveAutoName: (v: unknown) => void;
		stubs.completeOnce.push(
			new Promise((r) => {
				resolveAutoName = r as (v: unknown) => void;
			}),
		);

		await pi.fire("session_start", ctx);
		await pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });
		await pi.fire("session_switch", ctx);

		resolveAutoName!({ content: [{ type: "text", text: "stale title" }] });
		await flushMicrotasks();
		expectCallCount(pi.setSessionName.calls, "setSessionName", 0);

		tick(50);
	});
});

test("session-banner > auto-naming: drops a stale auto-name result after /title sets a manual name", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [] });
	let resolveAutoName: (v: unknown) => void;
	stubs.completeOnce.push(
		new Promise((r) => {
			resolveAutoName = r as (v: unknown) => void;
		}),
	);

	await pi.fire("session_start", ctx);
	await pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });
	await pi.runCommand("title", "manual title", ctx);

	resolveAutoName!({ content: [{ type: "text", text: "stale title" }] });
	await flushMicrotasks();

	expectCallCount(pi.setSessionName.calls, "setSessionName", 1);
	expectLastCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ manual title$/));
});

test("session-banner > auto-naming: clears in-flight state when generateName rejects before a stale request exists", async () => {
	const pi = createMockPi();
	const findModel = spy(() => ({ id: "claude-haiku-4-5", provider: "anthropic" }));
	findModel.queue.push(() => {
		throw new Error("model registry exploded");
	});
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [userMsg("hi")], findModel });

	await pi.fire("session_start", ctx);
	await pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });
	await flushMicrotasks();

	mockHaikuResponse("retry title");
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();

	expectCallCount(stubs.completeCalls, "complete", 1);
	expectCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ retry title$/));
});

test("session-banner > auto-naming: leaves newer state alone when a stale generateName rejection arrives", async () => {
	const pi = createMockPi();
	const findModel = spy(() => {
		throw new Error("model registry exploded");
	});
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [], findModel });

	await pi.fire("session_start", ctx);
	const firstAutoName = pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });
	await pi.runCommand("title", "manual title", ctx);
	await firstAutoName;
	await flushMicrotasks();

	expectCallCount(pi.setSessionName.calls, "setSessionName", 1);
	expectLastCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ manual title$/));
});

test("session-banner > auto-naming: stays backed off across subsequent turns once we've stopped", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [userMsg("hi")] });

	await pi.fire("session_start", ctx);
	// Turn 1: external rename triggers permanent back-off.
	pi.getSessionName.impl = () => "user picked this";
	await pi.fire("before_agent_start", ctx, { prompt: "hi" });
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 0);

	// Turn 2: even if the user clears the name, we stay backed off.
	pi.getSessionName.impl = () => "";
	await pi.fire("before_agent_start", ctx, { prompt: "hi" });
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 0);
});

test("session-banner > auto-naming: does not auto-name when the session already has a name on session_start (e.g. /resume)", async () => {
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F52E} resumed session";
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [userMsg("hi")] });

	await pi.fire("session_start", ctx);
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 0);
});

test("session-banner > auto-naming: skips when the conversation is empty", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [] });

	await pi.fire("session_start", ctx);
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 0);
});

test("session-banner > auto-naming: returns null and does not setSessionName when the model is not registered", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const findModel = spy(() => undefined);
	const ctx = createMockCtx({
		branch: [userMsg("hi")],
		findModel,
	});

	await pi.fire("session_start", ctx);
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 0);
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
});

test("session-banner > auto-naming: returns null and does not setSessionName when no API key is available", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const getApiKeyAndHeaders = spy(async () => ({ ok: false, error: "no creds" }));
	const ctx = createMockCtx({
		branch: [userMsg("hi")],
		getApiKeyAndHeaders,
	});

	await pi.fire("session_start", ctx);
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 0);
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
});

test("session-banner > auto-naming: returns null and does not setSessionName when auth lookup throws", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const getApiKeyAndHeaders = spy(async () => {
		throw new Error("auth backend down");
	});
	const ctx = createMockCtx({
		branch: [userMsg("hi")],
		getApiKeyAndHeaders,
	});

	await pi.fire("session_start", ctx);
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 0);
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
});

test("session-banner > auto-naming: falls back to getApiKey when getApiKeyAndHeaders is unavailable", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("fallback auth title");
	const getApiKey = spy(async () => "fallback-key");
	const ctx = createMockCtx({
		branch: [userMsg("hi")],
		getApiKeyAndHeaders: null,
		getApiKey,
	});

	await pi.fire("session_start", ctx);
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();

	expectCallCount(getApiKey.calls, "getApiKey", 1);
	expectCalledWith(stubs.completeCalls, "complete", anything(), anything(), { apiKey: "fallback-key" });
	expectCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ fallback auth title$/));
});

test("session-banner > auto-naming: gives up cleanly when getApiKey fallback returns no key", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const getApiKey = spy(async () => undefined);
	const ctx = createMockCtx({
		branch: [userMsg("hi")],
		getApiKeyAndHeaders: null,
		getApiKey,
	});

	await pi.fire("session_start", ctx);
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();

	expectCallCount(getApiKey.calls, "getApiKey", 1);
	expectCallCount(stubs.completeCalls, "complete", 0);
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
});

test("session-banner > auto-naming: gives up cleanly when the model registry exposes no auth method", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({
		branch: [userMsg("hi")],
		getApiKeyAndHeaders: null,
	});

	await pi.fire("session_start", ctx);
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();

	expectCallCount(stubs.completeCalls, "complete", 0);
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
});

test("session-banner > auto-naming: handles auth.ok=true with a missing apiKey by giving up cleanly", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const getApiKeyAndHeaders = spy(async () => ({ ok: true, headers: {} }));
	const ctx = createMockCtx({
		branch: [userMsg("hi")],
		getApiKeyAndHeaders,
	});

	await pi.fire("session_start", ctx);
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 0);
});

test("session-banner > auto-naming: swallows complete() failures", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	stubs.completeOnce.push(new Error("api down"));
	const ctx = createMockCtx({ branch: [userMsg("hi")] });

	await pi.fire("session_start", ctx);
	assert.equal(await pi.fire("agent_end", ctx), undefined);
	await flushMicrotasks();
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
});

test("session-banner > auto-naming: ignores empty/cleaned-to-null Haiku responses", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("###  "); // cleanGeneratedName returns null
	const ctx = createMockCtx({ branch: [userMsg("hi")] });

	await pi.fire("session_start", ctx);
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
});

test("session-banner > auto-naming: aborts the rename if the session was renamed externally while Haiku was running", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [userMsg("hi")] });
	mockHaikuResponse("auto generated");

	// session_start (restoreState) and agent_end (pre-Haiku check) both call
	// getSessionName — return empty so the auto-namer fires. Then the .then()
	// callback after Haiku resolves sees an externally-set name and bails.
	await pi.fire("session_start", ctx);
	pi.getSessionName.queue.push("", "user override"); // pre-Haiku / post-Haiku checks
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();

	expectCallCount(stubs.completeCalls, "complete", 1);
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
	expectLastCalledWith(ctx.ui.setTitle.calls, "setTitle", "\u03C0 root //areas/core/myapp \u2014 \u{1F52E} user override");
	expectLastCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", anyFn());
});

test("session-banner > auto-naming: backs off when the pre-Haiku check sees an external rename", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [userMsg("hi")] });

	await pi.fire("session_start", ctx);
	// Before Haiku is called, getSessionName already shows an external rename.
	pi.getSessionName.impl = () => "user override";
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();
	expectCallCount(stubs.completeCalls, "complete", 0);
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
	expectLastCalledWith(ctx.ui.setTitle.calls, "setTitle", "\u03C0 root //areas/core/myapp \u2014 \u{1F52E} user override");
	expectLastCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", anyFn());
});
test("session-banner > herdr: renames the current herdr tab when a session name is applied", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);
	await pi.runCommand("title", "fix checkout tax bug", ctx);
	await flushMicrotasks();

	const calls = herdrTabRenameCalls();
	expectCallCount(calls, "herdr rename", 2);
	assert.deepEqual(calls[0]?.[1], ["tab", "rename", "w3:t1", "\u{1F4ED} Open"]);
	assert.ok(Array.isArray(calls[1]?.[1]) && (calls[1]?.[1] as string[])[3].endsWith(" fix checkout tax bug"), `second rename=${JSON.stringify(calls[1])}`);
});

test("session-banner > herdr: renames the current herdr tab when restoring an existing session name", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F52E} restored session";
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);
	await flushMicrotasks();

	expectCallCount(herdrTabRenameCalls(), "herdr rename", 1);
	expectCalledWith(stubs.execFileCalls, "execFile", "herdr", ["tab", "rename", "w3:t1", "\u{1F52E} restored session"], anyFn());
});

test("session-banner > herdr: persists Herdr ownership after a successful write", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	mockHerdrCliLabel("1");
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F52E} restored session";
	sessionBanner(pi as never);
	const ctx = createMockCtx();

	await pi.fire("session_start", ctx);
	await flushMicrotasks();

	expectCalledWith(stubs.mkdirCalls, "mkdir", stringContaining(".pi/agent/config/session-banner"), { recursive: true });
	expectCalledWith(
		stubs.writeFileCalls,
		"writeFile",
		stringContaining(".pi/agent/config/session-banner/herdr-titles.json"),
		`${JSON.stringify({ "w3:t1": "\u{1F52E} restored session" }, null, 2)}\n`,
		{ mode: 0o600 },
	);
});

test("session-banner > herdr: does not claim ownership when writing the open placeholder fails", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	stubs.execFileImpl = (command, args, callback?: ExecFileCallback) => {
		if (command === "herdr" && Array.isArray(args) && args[0] === "tab" && args[1] === "rename") {
			callback?.(new Error("rename failed"), "", "");
		} else {
			callback?.(null, "", "");
		}
		return {} as never;
	};
	const pi = createMockPi();
	sessionBanner(pi as never);

	await pi.fire("session_start", createMockCtx());
	await flushMicrotasks();

	expectCallCount(herdrTabRenameCalls(), "herdr rename", 1);
	expectCallCount(stubs.writeFileCalls, "writeFile", 0);
});

test("session-banner > herdr: serializes Herdr ownership persistence with queued successful renames", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	mockHerdrCliLabel("1");
	const writes: Array<{ payload: string; resolve: () => void }> = [];
	stubs.writeFileImpl = (async (_path: unknown, data: unknown) => {
		await new Promise<void>((resolve) => writes.push({ payload: String(data), resolve }));
	}) as never;
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();

	await pi.runCommand("title", "first persistence title", ctx);
	await pi.runCommand("title", "second persistence title", ctx);
	await flushMicrotasks();

	expectCallCount(writes, "writes", 1);
	assert.ok(writes[0]?.payload.includes("first persistence title"), `payload=${writes[0]?.payload}`);
	expectCallCount(herdrTabRenameCalls(), "herdr rename", 1);

	writes[0]!.resolve();
	await flushMicrotasks();

	expectCallCount(writes, "writes", 2);
	assert.ok(writes[1]?.payload.includes("second persistence title"), `payload=${writes[1]?.payload}`);
	expectCallCount(herdrTabRenameCalls(), "herdr rename", 2);

	writes[1]!.resolve();
	await flushMicrotasks();

	const finalPayload = JSON.parse(writes.at(-1)?.payload ?? "{}") as Record<string, string>;
	assert.ok(finalPayload["w3:t1"].includes("second persistence title"), `final=${writes.at(-1)?.payload}`);
});

test("session-banner > herdr: prunes persisted Herdr ownership to recent tabs", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	const oldEntries = Object.fromEntries(
		Array.from({ length: 55 }, (_, index) => [`old:${index}`, `title ${index}`]),
	);
	stubs.readFileSyncValue = JSON.stringify(oldEntries);
	mockHerdrCliLabel("1");
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F52E} newest session";
	sessionBanner(pi as never);
	const ctx = createMockCtx();

	await pi.fire("session_start", ctx);
	await flushMicrotasks();

	const lastWrite = stubs.writeFileCalls.at(-1);
	const payload = JSON.parse(String(lastWrite?.[1])) as Record<string, string>;
	assert.equal(Object.keys(payload).length, 50, `pruned to 50 keys, got ${Object.keys(payload).length}`);
	assert.equal(payload["old:0"], undefined);
	assert.equal(payload["old:54"], "title 54");
	assert.equal(payload["w3:t1"], "\u{1F52E} newest session");
});

test("session-banner > herdr: ignores Herdr ownership persistence failures after a successful tab write", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	stubs.mkdirImpl = async () => {
		throw new Error("mkdir failed");
	};
	mockHerdrCliLabel("1");
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F52E} restored session";
	sessionBanner(pi as never);
	const ctx = createMockCtx();

	await pi.fire("session_start", ctx);
	await flushMicrotasks();

	expectCallCount(herdrTabRenameCalls(), "herdr rename", 1);
	expectCallCount(stubs.writeFileCalls, "writeFile", 0);
});

test("session-banner > herdr: continues the Herdr rename queue when persistence write fails", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	let failedOnce = false;
	stubs.writeFileImpl = async () => {
		if (!failedOnce) {
			failedOnce = true;
			throw new Error("write failed");
		}
	};
	mockHerdrCliLabel("1");
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();

	await pi.runCommand("title", "first persistence failure", ctx);
	await pi.runCommand("title", "second after failure", ctx);
	await flushMicrotasks(100);

	expectCallCount(herdrTabRenameCalls(), "herdr rename", 2);
	expectCallCount(stubs.writeFileCalls, "writeFile", 2);
	const persistedPayloads = stubs.writeFileCalls.map((call) => String(call[1]));
	assert.ok(persistedPayloads[0].includes("first persistence failure"), `p0=${persistedPayloads[0]}`);
	assert.ok(persistedPayloads[1].includes("second after failure"), `p1=${persistedPayloads[1]}`);
});

test("session-banner > herdr: treats persisted ownership as owned on a fresh extension instance", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	stubs.readFileSyncValue = JSON.stringify({ "w3:t1": "\u{1F52E} previous session" });
	const herdr = mockHerdrCliLabel("\u{1F52E} previous session");
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();

	await pi.fire("session_start", ctx);
	await flushMicrotasks();

	expectCallCount(herdrTabRenameCalls(), "herdr rename", 1);
	assert.deepEqual(herdrTabRenameCalls()[0]?.[1], ["tab", "rename", "w3:t1", "\u{1F4ED} Open"]);
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
	assert.equal(herdr.getLabel(), "\u{1F4ED} Open");
});

test("session-banner > herdr: replaces a stale non-numeric Herdr label for a new session", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	const herdr = mockHerdrCliLabel("\u{1F52E} stale previous run");
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();

	await pi.fire("session_start", ctx);
	await flushMicrotasks();
	assert.equal(herdr.getLabel(), "\u{1F4ED} Open");

	await pi.runCommand("title", "new session title", ctx);
	await flushMicrotasks();

	expectCallCount(herdrTabRenameCalls(), "herdr rename", 2);
	expectCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/ new session title$/));
	expectCallCount(pi.setSessionName.calls, "setSessionName", 1);
	assert.match(herdr.getLabel(), / new session title$/);
});

test("session-banner > herdr: preserves an unowned manual Herdr label for an existing unnamed conversation", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	const herdr = mockHerdrCliLabel("Manual tab name");
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [userMsg("existing conversation")] });

	await pi.fire("session_start", ctx);
	await flushMicrotasks();

	expectCallCount(herdrTabRenameCalls(), "herdr rename", 0);
	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
	assert.equal(herdr.getLabel(), "Manual tab name");
});

test("session-banner > herdr: keeps prior ownership after a failed Herdr write and still writes owned labels later", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	let currentLabel = "1";
	let failNextRename = false;
	stubs.execFileImpl = (command, args, callback?: ExecFileCallback) => {
		if (command === "herdr" && Array.isArray(args) && args[0] === "tab" && args[1] === "get") {
			callback?.(null, herdrTabGetOutput(currentLabel), "");
		} else if (command === "herdr" && Array.isArray(args) && args[0] === "tab" && args[1] === "rename") {
			if (failNextRename) {
				failNextRename = false;
				callback?.(new Error("rename failed"), "", "");
			} else {
				currentLabel = String(args[3] ?? "");
				callback?.(null, "", "");
			}
		} else {
			callback?.(null, "", "");
		}
		return {} as never;
	};
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F52E} owned title";
	sessionBanner(pi as never);
	const ctx = createMockCtx();

	await pi.fire("session_start", ctx);
	await flushMicrotasks();
	assert.equal(currentLabel, "\u{1F52E} owned title");

	failNextRename = true;
	await pi.runCommand("title", "failed write", ctx);
	await flushMicrotasks();
	assert.equal(currentLabel, "\u{1F52E} owned title");
	expectCallCount(stubs.writeFileCalls, "writeFile", 1);

	await pi.runCommand("title", "successful after failure", ctx);
	await flushMicrotasks();

	expectCallCount(herdrTabRenameCalls(), "herdr rename", 3);
	assert.match(currentLabel, / successful after failure$/);
	expectLastCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/ successful after failure$/));
	const persistedPayloads = stubs.writeFileCalls.map((call) => String(call[1]));
	assert.ok(!persistedPayloads.join("\n").includes("failed write"), "failed write must not be persisted");
	assert.ok(String(persistedPayloads.at(-1)).includes("successful after failure"), `last=${persistedPayloads.at(-1)}`);
});

test("session-banner > herdr: adopts a manual Herdr rename on a fresh instance when persisted ownership diverges", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	stubs.readFileSyncValue = JSON.stringify({ "w3:t1": "\u{1F52E} previous title" });
	const herdr = mockHerdrCliLabel("Manual GUI Name");
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();

	await pi.runCommand("title", "new title", ctx);
	await flushMicrotasks();

	expectCallCount(herdrTabRenameCalls(), "herdr rename", 0);
	expectCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/ new title$/));
	expectLastCalledWith(pi.setSessionName.calls, "setSessionName", "Manual GUI Name");
	assert.equal(pi.getSessionName(), "Manual GUI Name");
	assert.equal(herdr.getLabel(), "Manual GUI Name");
});

test("session-banner > herdr: renames the current herdr tab when adopting an external session name", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [userMsg("hi")] });

	await pi.fire("session_start", ctx);
	pi.getSessionName.impl = () => "external rename";
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();

	const calls = herdrTabRenameCalls();
	expectCallCount(calls, "herdr rename", 2);
	assert.deepEqual(calls[0]?.[1], ["tab", "rename", "w3:t1", ""]);
	assert.deepEqual(calls[1]?.[1], ["tab", "rename", "w3:t1", "external rename"]);
});

test("session-banner > herdr: renames after session_switch when the Herdr tab still shows the previous auto title", async () => {
	await withFakeTimers(async (tick) => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_TAB_ID = "w3:t1";
		const herdr = mockHerdrCliLabel("1");
		const pi = createMockPi();
		pi.getSessionName.impl = () => "\u{1F52E} previous session";
		sessionBanner(pi as never);
		const ctx = createMockCtx();

		await pi.fire("session_start", ctx);
		await flushMicrotasks();
		assert.equal(herdr.getLabel(), "\u{1F52E} previous session");

		pi.getSessionName.impl = () => "\u26A1 switched session";
		await pi.fire("session_switch", ctx);
		tick(50);
		await flushMicrotasks();

		let calls = herdrTabRenameCalls();
		expectCallCount(calls, "herdr rename", 2);
		assert.deepEqual(calls[1]?.[1], ["tab", "rename", "w3:t1", "\u26A1 switched session"]);
		assert.equal(herdr.getLabel(), "\u26A1 switched session");

		await pi.runCommand("title", "manual after switch", ctx);
		await flushMicrotasks();
		calls = herdrTabRenameCalls();
		expectCallCount(calls, "herdr rename", 3);
		assert.ok(Array.isArray(calls[2]?.[1]) && (calls[2]?.[1] as string[])[3].endsWith(" manual after switch"), `third rename=${JSON.stringify(calls[2])}`);
	});
});

test("session-banner > herdr: renames after session_fork when the Herdr tab still shows the previous auto title", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	const herdr = mockHerdrCliLabel("1");
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F52E} previous session";
	sessionBanner(pi as never);
	const firstCtx = createMockCtx({ cwd: "/Users/me/world/trees/root/src/areas/core/myapp" });
	const forkCtx = createMockCtx({ cwd: "/Users/me/world/trees/root/src/areas/apps/flow" });

	await pi.fire("session_start", firstCtx);
	await flushMicrotasks();
	assert.equal(herdr.getLabel(), "\u{1F52E} previous session");

	pi.getSessionName.impl = () => "\u26A1 forked session";
	await pi.fire("session_fork", forkCtx);
	await flushMicrotasks();

	let calls = herdrTabRenameCalls();
	expectCallCount(calls, "herdr rename", 2);
	assert.deepEqual(calls[1]?.[1], ["tab", "rename", "w3:t1", "\u26A1 forked session"]);
	assert.equal(herdr.getLabel(), "\u26A1 forked session");

	await pi.runCommand("title", "manual after fork", forkCtx);
	await flushMicrotasks();
	calls = herdrTabRenameCalls();
	expectCallCount(calls, "herdr rename", 3);
	assert.ok(Array.isArray(calls[2]?.[1]) && (calls[2]?.[1] as string[])[3].endsWith(" manual after fork"), `third rename=${JSON.stringify(calls[2])}`);
});

test("session-banner > herdr: backs off permanently when the current Herdr label looks GUI-renamed", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	const herdr = mockHerdrCliLabel("1");
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();

	await pi.fire("session_start", ctx);
	await flushMicrotasks();
	expectCallCount(herdrTabRenameCalls(), "herdr rename", 1);
	assert.equal(herdr.getLabel(), "\u{1F4ED} Open");

	herdr.setLabel("\u{1F504} Tab Rename Behavior Issue");
	await pi.runCommand("title", "fix checkout tax bug", ctx);
	await pi.runCommand("title", "queued title after backoff", ctx);
	await flushMicrotasks();
	expectCallCount(herdrTabRenameCalls(), "herdr rename", 1);
	assert.equal(herdr.getLabel(), "\u{1F504} Tab Rename Behavior Issue");

	await pi.runCommand("title", "another generated title", ctx);
	await flushMicrotasks();
	expectCallCount(herdrTabRenameCalls(), "herdr rename", 1);
	assert.equal(herdr.getLabel(), "\u{1F504} Tab Rename Behavior Issue");
});

test("session-banner > herdr: adopts a manual Herdr GUI rename as the Pi session name without writing back", async () => {
	await withFakeTimers(async (tick) => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_TAB_ID = "w3:t1";
		const herdr = mockHerdrCliLabel("1");
		const pi = createMockPi();
		sessionBanner(pi as never);
		const ctx = createMockCtx({ branch: [userMsg("specific task")] });

		await pi.fire("session_start", ctx);
		await flushMicrotasks();
		expectCallCount(herdrTabRenameCalls(), "herdr rename", 1);

		herdr.setLabel("\u{1F504} Tab Rename Behavior Issue");
		pi.setSessionName.calls.length = 0;
		ctx.ui.setTitle.calls.length = 0;
		await pi.runCommand("title", "fix checkout tax bug", ctx);
		await flushMicrotasks();

		expectCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/ fix checkout tax bug$/));
		expectLastCalledWith(pi.setSessionName.calls, "setSessionName", "\u{1F504} Tab Rename Behavior Issue");
		assert.equal(pi.getSessionName(), "\u{1F504} Tab Rename Behavior Issue");
		expectCallCount(herdrTabRenameCalls(), "herdr rename", 1);
		assert.equal(herdr.getLabel(), "\u{1F504} Tab Rename Behavior Issue");
		expectLastCalledWith(ctx.ui.setTitle.calls, "setTitle", "\u03C0 root //areas/core/myapp \u2014 \u{1F504} Tab Rename Behavior Issue");
		expectLastCalledWith(ctx.ui.setWidget.calls, "setWidget", "session-banner", anyFn());
		const rendered = paneRegistry().banner()?.render(ctx as never) as { slot: string; emoji: string; label: string; color: string } | null;
		assert.ok(rendered !== null, "banner pane should render");
		assert.equal(rendered!.slot, "banner");
		assert.equal(rendered!.emoji, "\u{1F504}");
		assert.equal(rendered!.label, "Tab Rename Behavior Issue");
		assert.equal(typeof rendered!.color, "string");

		stubs.completeCalls.length = 0;
		tick(1000);
		ctx.ui.setTitle.calls.length = 0;
		await pi.fire("agent_end", ctx);
		expectCallCount(stubs.completeCalls, "complete", 0);
		ctx.ui.setTitle.calls.length = 0;
		tick(1000);
		expectCallCount(ctx.ui.setTitle.calls, "setTitle", 0);
	});
});

test("session-banner > herdr: drops manual Herdr adoption when the rename epoch changes mid-flight", async () => {
	await withFakeTimers(async () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_TAB_ID = "w3:t1";
		let getCallback: ExecFileCallback | undefined;
		stubs.execFileImpl = (command, args, callback?: ExecFileCallback) => {
			if (command === "herdr" && Array.isArray(args) && args[0] === "tab" && args[1] === "get") {
				getCallback = callback;
			} else {
				callback?.(null, "", "");
			}
			return {} as never;
		};
		const pi = createMockPi();
		sessionBanner(pi as never);
		const ctx = createMockCtx();

		await pi.runCommand("title", "fix checkout tax bug", ctx);
		await flushMicrotasks();
		assert.ok(getCallback !== undefined, "tab get callback should have been captured");

		pi.setSessionName.calls.length = 0;
		pi.setSessionName.impl = () => {
			throw new Error("stale session handle");
		};
		await pi.fire("session_switch", ctx);
		getCallback?.(null, herdrTabGetOutput("Manual GUI Name"), "");
		await flushMicrotasks();

		expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
	});
});

test("session-banner > herdr: swallows a stale session handle while adopting a manual Herdr rename", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	stubs.readFileSyncValue = JSON.stringify({ "w3:t1": "\u{1F52E} previous title" });
	mockHerdrCliLabel("Manual GUI Name");
	const pi = createMockPi();
	const originalSetSessionName = pi.setSessionName.impl!;
	pi.setSessionName.queue.push(originalSetSessionName, () => {
		throw new Error("stale session handle");
	});
	sessionBanner(pi as never);
	const ctx = createMockCtx();

	await pi.runCommand("title", "new generated title", ctx);
	await flushMicrotasks();

	expectCallCount(pi.setSessionName.calls, "setSessionName", 2);
	expectCallCount(herdrTabRenameCalls(), "herdr rename", 0);
});

test("session-banner > herdr: skips manual Herdr adoption when no UI context was captured", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	stubs.readFileSyncValue = JSON.stringify({ "w3:t1": "\u{1F52E} previous title" });
	mockHerdrCliLabel("Manual GUI Name");
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ hasUI: false });

	await pi.runCommand("title", "headless title", ctx);
	pi.setSessionName.calls.length = 0;
	await flushMicrotasks();

	expectCallCount(pi.setSessionName.calls, "setSessionName", 0);
	expectCallCount(herdrTabRenameCalls(), "herdr rename", 0);
});

test("session-banner > herdr: fails open and writes when herdr tab get returns an error", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	stubs.execFileImpl = (command, args, callback?: ExecFileCallback) => {
		if (command === "herdr" && Array.isArray(args) && args[0] === "tab" && args[1] === "get") {
			callback?.(new Error("herdr unavailable"), "", "");
		} else {
			callback?.(null, "", "");
		}
		return {} as never;
	};
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [userMsg("existing conversation")] });

	await pi.fire("session_start", ctx);
	await flushMicrotasks();

	expectCallCount(herdrTabRenameCalls(), "herdr rename", 1);
	expectCalledWith(stubs.execFileCalls, "execFile", "herdr", ["tab", "rename", "w3:t1", ""], anyFn());
});

test("session-banner > herdr: fails open and writes when herdr tab get returns a missing label", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	stubs.execFileImpl = (command, args, callback?: ExecFileCallback) => {
		if (command === "herdr" && Array.isArray(args) && args[0] === "tab" && args[1] === "get") {
			callback?.(null, herdrTabGetOutput(7), "");
		} else {
			callback?.(null, "", "");
		}
		return {} as never;
	};
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [userMsg("existing conversation")] });

	await pi.fire("session_start", ctx);
	await flushMicrotasks();

	expectCallCount(herdrTabRenameCalls(), "herdr rename", 1);
});

test("session-banner > herdr: drops a queued open rename after a session lifecycle reset", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	const pi = createMockPi();
	sessionBanner(pi as never);
	const firstCtx = createMockCtx({ cwd: "/Users/me/world/trees/root/src/areas/core/myapp" });
	const forkCtx = createMockCtx({ cwd: "/Users/me/world/trees/root/src/areas/apps/flow" });

	const startingSession = pi.fire("session_start", firstCtx);
	const forkingSession = pi.fire("session_fork", forkCtx);
	await Promise.all([startingSession, forkingSession]);
	await flushMicrotasks();

	expectCallCount(herdrTabRenameCalls(), "herdr rename", 1);
	assert.deepEqual(herdrTabRenameCalls()[0]?.[1], ["tab", "rename", "w3:t1", "\u{1F4ED} Open"]);
});

test("session-banner > herdr: does not rename herdr tabs when not running inside herdr", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);
	await pi.runCommand("title", "manual name", ctx);
	await flushMicrotasks();

	expectCallCount(herdrTabRenameCalls(), "herdr rename", 0);
});

test("session-banner > herdr: does not rename the parent tab from a headless (subagent) session_start", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	const pi = createMockPi();
	pi.getSessionName.impl = () => "general-purpose#5fb88e30";
	sessionBanner(pi as never);

	await pi.fire("session_start", createMockCtx({ hasUI: false }));
	await flushMicrotasks();

	expectCallCount(herdrTabRenameCalls(), "herdr rename", 0);
});

test("session-banner > herdr: does not rename the parent tab from a headless agent_end", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	const pi = createMockPi();
	pi.getSessionName.impl = () => "general-purpose#5fb88e30";
	sessionBanner(pi as never);
	const ctx = createMockCtx({ hasUI: false, branch: [userMsg("do the subtask")] });

	await pi.fire("agent_end", ctx);
	await flushMicrotasks();

	expectCallCount(herdrTabRenameCalls(), "herdr rename", 0);
});

test("session-banner > herdr: marks the current herdr tab open when starting an unnamed session", async () => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w3:t1";
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);
	await flushMicrotasks();

	expectCallCount(herdrTabRenameCalls(), "herdr rename", 1);
	expectCalledWith(stubs.execFileCalls, "execFile", "herdr", ["tab", "rename", "w3:t1", "\u{1F4ED} Open"], anyFn());
});

test("session-banner > cmux: does not invoke cmux when CMUX_WORKSPACE_ID is unset", async () => {
	delete process.env.CMUX_WORKSPACE_ID;
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);
	await pi.runCommand("title", "manual name", ctx);
	expectCallCount(stubs.execFileCalls, "execFile", 0);
});

test("session-banner > cmux: checks the caller workspace tree for a single cmux tab before renaming", async () => {
	process.env.CMUX_WORKSPACE_ID = "workspace:7";
	mockCmuxTree([{ surfaces: [{ ref: "surface:1" }] }]);
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);
	await pi.runCommand("title", "fix checkout tax bug", ctx);
	mockCmuxTree([{ surface_refs: ["surface:1"] }]);
	await pi.runCommand("title", "fix checkout tax bug again", ctx);
	mockCmuxTree([{ surface_count: 1 }]);
	await pi.runCommand("title", "fix checkout tax bug a third time", ctx);
	mockCmuxTreeOutput(JSON.stringify({ windows: [{ workspaces: [{ panes: [{ surface_count: 1 }] }] }] }));
	await pi.runCommand("title", "fix checkout tax bug a fourth time", ctx);

	expectCalledWith(stubs.execFileCalls, "execFile", "cmux", ["--json", "tree", "--workspace", "workspace:7"], anyFn());
	expectCallCount(cmuxRenameCalls(), "cmux rename", 4);
	expectCalledWith(stubs.execFileCalls, "execFile", "cmux", ["rename-workspace", "--workspace", "workspace:7", "--", stringMatching(/ fix checkout tax bug$/)], anyFn());
});

test("session-banner > cmux: does not rename the cmux workspace when an existing session name is only rendered", async () => {
	process.env.CMUX_WORKSPACE_ID = "workspace:7";
	const pi = createMockPi();
	pi.getSessionName.impl = () => "\u{1F52E} restored session";
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);

	expectCallCount(stubs.execFileCalls, "execFile", 0);
});

test("session-banner > cmux: does not rename the cmux workspace when multiple tabs are present", async () => {
	process.env.CMUX_WORKSPACE_ID = "workspace:7";
	mockCmuxTree([{ surfaces: [{ ref: "surface:1" }, { ref: "surface:2" }] }]);
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);
	await pi.runCommand("title", "fix checkout tax bug", ctx);
	mockCmuxTree([{ surface_refs: ["surface:1"] }, { surface_count: 1 }]);
	await pi.runCommand("title", "fix checkout tax bug again", ctx);

	expectCalledWith(stubs.execFileCalls, "execFile", "cmux", ["--json", "tree", "--workspace", "workspace:7"], anyFn());
	expectCallCount(cmuxRenameCalls(), "cmux rename", 0);
});

test("session-banner > cmux: ignores docked panes when counting cmux tabs", async () => {
	process.env.CMUX_WORKSPACE_ID = "workspace:7";
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);

	// One real tab + a global dock terminal (cmux reports dock panes inside
	// every workspace) → still a single-tab workspace, rename proceeds.
	mockCmuxTree([
		{ surfaces: [{ ref: "surface:15" }] },
		{ dock_scope: "global", surfaces: [{ ref: "surface:6" }] },
	]);
	await pi.runCommand("title", "fix checkout tax bug", ctx);
	expectCallCount(cmuxRenameCalls(), "cmux rename", 1);

	// Two real tabs alongside a dock pane → still skipped.
	mockCmuxTree([
		{ dock_scope: "global", surfaces: [{ ref: "surface:6" }] },
		{ surfaces: [{ ref: "surface:1" }] },
		{ surfaces: [{ ref: "surface:2" }] },
	]);
	await pi.runCommand("title", "fix checkout tax bug again", ctx);
	expectCallCount(cmuxRenameCalls(), "cmux rename", 1);
});

test("session-banner > cmux: renames the cmux workspace when tree output does not prove multiple tabs", async () => {
	process.env.CMUX_WORKSPACE_ID = "workspace:7";
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);

	mockCmuxTreeOutput("not-json");
	await pi.runCommand("title", "first title", ctx);
	mockCmuxTreeOutput("{}");
	await pi.runCommand("title", "second title", ctx);
	mockCmuxTreeOutput(JSON.stringify({ caller: { workspace_ref: "workspace:7" }, windows: [{}] }));
	await pi.runCommand("title", "third title", ctx);
	mockCmuxTree([{}]);
	await pi.runCommand("title", "fourth title", ctx);

	expectCallCount(cmuxRenameCalls(), "cmux rename", 4);
});

test("session-banner > cmux: does not rename the cmux workspace when cmux tree fails", async () => {
	process.env.CMUX_WORKSPACE_ID = "workspace:7";
	mockCmuxTreeOutput("", new Error("cmux unavailable"));
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);
	await pi.runCommand("title", "fix checkout tax bug", ctx);

	expectCallCount(cmuxRenameCalls(), "cmux rename", 0);
});

test("session-banner > cmux: does not call cmux during render when there is no label yet", async () => {
	process.env.CMUX_WORKSPACE_ID = "workspace:7";
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);
	expectCallCount(stubs.execFileCalls, "execFile", 0);
});

test("session-banner > /title: sets the name directly when given args", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx();
	await pi.fire("session_start", ctx);
	await pi.runCommand("title", "  fix checkout tax bug  ", ctx);

	expectCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ fix checkout tax bug$/));
	expectCalledWith(ctx.ui.notify.calls, "notify", stringContaining("fix checkout tax bug"), "info");
});

test("session-banner > /title: does not let background auto-naming overwrite a manual /title", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("auto title");
	const ctx = createMockCtx({ branch: [userMsg("specific opening prompt")] });

	await pi.fire("session_start", ctx);
	await pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });
	await flushMicrotasks();
	await pi.runCommand("title", "manual title", ctx);

	mockHaikuResponse("should not apply");
	await pi.fire("before_agent_start", ctx, { prompt: "another specific prompt" });
	await pi.fire("agent_end", ctx);
	await flushMicrotasks();

	expectCallCount(stubs.completeCalls, "complete", 1);
	expectLastCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ manual title$/));
});

test("session-banner > /title: regenerates via Haiku when called without args", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("regenerated title");
	const ctx = createMockCtx({ branch: [userMsg("a real conversation")] });
	await pi.fire("session_start", ctx);

	await pi.runCommand("title", "", ctx);
	expectCallCount(stubs.completeCalls, "complete", 1);
	expectCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ regenerated title$/));
	expectCalledWith(ctx.ui.notify.calls, "notify", stringContaining("regenerated title"), "info");
});

test("session-banner > /title: keeps auto-naming active after a successful no-arg regeneration", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("regenerated title");
	const ctx = createMockCtx({ branch: [userMsg("a real conversation")] });
	await pi.fire("session_start", ctx);

	await pi.runCommand("title", "", ctx);
	mockHaikuResponse("automatic refinement");
	await pi.fire("before_agent_start", ctx, { prompt: "add one more detail" });
	await flushMicrotasks();

	expectCallCount(stubs.completeCalls, "complete", 2);
	expectLastCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ automatic refinement$/));
});

test("session-banner > /title: warns and does nothing when there is no conversation to summarize", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [] });
	await pi.fire("session_start", ctx);
	await pi.runCommand("title", "", ctx);
	expectCallCount(stubs.completeCalls, "complete", 0);
	expectCalledWith(ctx.ui.notify.calls, "notify", "No conversation to name yet", "warning");
});

test("session-banner > /title: warns when Haiku regeneration fails", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("###"); // cleans to null
	const ctx = createMockCtx({ branch: [userMsg("hi")] });
	await pi.fire("session_start", ctx);
	await pi.runCommand("title", "", ctx);
	expectCalledWith(ctx.ui.notify.calls, "notify", stringContaining("Failed to generate name"), "warning");
});

test("session-banner > /title: restores auto-naming when no-arg regeneration hits a registry error", async () => {
	const pi = createMockPi();
	const findModel = spy(() => ({ id: "claude-haiku-4-5", provider: "anthropic" }));
	findModel.queue.push(() => {
		throw new Error("model registry exploded");
	});
	sessionBanner(pi as never);
	const ctx = createMockCtx({ branch: [userMsg("hi")], findModel });
	await pi.fire("session_start", ctx);

	await pi.runCommand("title", "", ctx);
	expectCalledWith(ctx.ui.notify.calls, "notify", stringContaining("Failed to generate name"), "warning");

	mockHaikuResponse("recovered auto title");
	await pi.fire("before_agent_start", ctx, { prompt: "specific follow-up" });
	await flushMicrotasks();

	expectCallCount(stubs.completeCalls, "complete", 1);
	expectCalledWith(pi.setSessionName.calls, "setSessionName", stringMatching(/^.+ recovered auto title$/));
});

test("session-banner > /title: respects PI_SESSION_BANNER_PROVIDER / PI_SESSION_BANNER_MODEL env vars in the failure message", async () => {
	process.env.PI_SESSION_BANNER_PROVIDER = "openai";
	process.env.PI_SESSION_BANNER_MODEL = "gpt-test";
	// The implementation reads these lazily — no re-import needed.
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("###"); // cleans to null
	const ctx = createMockCtx({ branch: [userMsg("hi")] });
	await pi.fire("session_start", ctx);
	await pi.runCommand("title", "", ctx);
	expectCalledWith(ctx.ui.notify.calls, "notify", stringContaining("provider=openai, model=gpt-test"), "warning");
});

test("session-banner > /title: ignores an args-only string that is whitespace and falls through to regenerate", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("from whitespace");
	const ctx = createMockCtx({ branch: [userMsg("hi")] });
	await pi.fire("session_start", ctx);
	await pi.runCommand("title", "   ", ctx);
	expectCallCount(stubs.completeCalls, "complete", 1);
});

test("session-banner > /title: treats a missing args string the same as empty args", async () => {
	const pi = createMockPi();
	sessionBanner(pi as never);
	mockHaikuResponse("from undefined");
	const ctx = createMockCtx({ branch: [userMsg("hi")] });
	await pi.fire("session_start", ctx);
	await pi.runCommand("title", undefined as unknown as string, ctx);
	expectCallCount(stubs.completeCalls, "complete", 1);
});
