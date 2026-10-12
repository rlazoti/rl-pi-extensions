import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Module mocks ─────────────────────────────────────────────────────────

vi.mock("@mariozechner/pi-ai", () => ({
	complete: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({}));

vi.mock("@mariozechner/pi-tui", () => ({
	truncateToWidth: (s: string, _width: number) => s,
}));

vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(),
    promises: {
      mkdir: vi.fn(),
      writeFile: vi.fn(),
    },
  },
}));

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import fs from "node:fs";
import { complete } from "@mariozechner/pi-ai";
import sessionBanner from "./index.js";
import { paneRegistry } from "./panes.js";

const completeMock = vi.mocked(complete);
const execFileMock = vi.mocked(execFile);

// ─── Test scaffolding ────────────────────────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;
type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

interface MockPi {
	on: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	setSessionName: ReturnType<typeof vi.fn>;
	getSessionName: ReturnType<typeof vi.fn>;
	fire(event: string, ctx?: unknown, eventData?: Record<string, unknown>): Promise<void>;
	runCommand(name: string, args: string, ctx?: unknown): Promise<void>;
}

function createMockPi(): MockPi {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();

	const on = vi.fn((event: string, handler: Handler) => {
		if (!handlers.has(event)) handlers.set(event, []);
		handlers.get(event)!.push(handler);
	});

	const registerCommand = vi.fn((name: string, def: { handler: CommandHandler }) => {
		commands.set(name, def.handler);
	});

	let sessionName = "";
	const setSessionName = vi.fn((name: string) => {
		sessionName = name;
	});
	const getSessionName = vi.fn(() => sessionName);

	return {
		on,
		registerCommand,
		setSessionName,
		getSessionName,
		async fire(event, ctx, eventData) {
			for (const h of handlers.get(event) ?? []) {
				await h({ type: event, ...(eventData as object | undefined) }, ctx);
			}
		},
		async runCommand(name, args, ctx) {
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
	findModel?: ReturnType<typeof vi.fn>;
	getApiKeyAndHeaders?: ReturnType<typeof vi.fn> | null;
	getApiKey?: ReturnType<typeof vi.fn>;
}

function createMockCtx(opts: MockCtxOptions = {}) {
	const ui = {
		setTitle: vi.fn(),
		setWidget: vi.fn(),
		notify: vi.fn(),
	};
	const modelRegistry: Record<string, unknown> = {
		find: opts.findModel ?? vi.fn(() => ({ id: "claude-haiku-4-5", provider: "anthropic" })),
	};
	if (opts.getApiKeyAndHeaders !== null) {
		modelRegistry.getApiKeyAndHeaders =
			opts.getApiKeyAndHeaders ?? vi.fn(async () => ({ ok: true, apiKey: "test-key", headers: {} }));
	}
	if (opts.getApiKey) modelRegistry.getApiKey = opts.getApiKey;
	return {
		hasUI: opts.hasUI ?? true,
		cwd: opts.cwd ?? "/Users/me/world/trees/root/src/areas/core/myapp",
		ui,
		sessionManager: { getBranch: vi.fn(() => opts.branch ?? []) },
		modelRegistry,
	};
}

function userMsg(text: string) {
	return { type: "message", message: { role: "user", content: text } };
}

/** Wait for fire-and-forget promise chains in agent_end to settle. */
function flushMicrotasks(times = 20): Promise<void> {
	let p = Promise.resolve();
	for (let i = 0; i < times; i++) p = p.then(() => undefined);
	return p;
}

function mockHaikuResponse(text: string) {
	completeMock.mockResolvedValueOnce({
		content: [
			{ type: "text", text },
			{ type: "tool_use", input: {} } as any,
		],
	} as any);
}

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function mockCmuxTree(panes: unknown[], workspaceRef = "workspace:7", callerWorkspaceRef = workspaceRef) {
  mockCmuxTreeOutput(JSON.stringify({
    caller: { workspace_ref: callerWorkspaceRef },
    windows: [{ workspaces: [{ ref: workspaceRef, panes }] }],
  }));
}

function mockCmuxTreeOutput(stdout: string, error: Error | null = null) {
  execFileMock.mockImplementation(((command: string, args?: readonly string[], callback?: ExecFileCallback) => {
    if (command === "cmux" && Array.isArray(args) && args[0] === "--json" && args[1] === "tree") {
      callback?.(error, stdout, "");
    } else {
      callback?.(null, "", "");
    }
    return {} as ReturnType<typeof execFile>;
  }) as typeof execFile);
}

function cmuxRenameCalls() {
  return execFileMock.mock.calls.filter(([, args]) => Array.isArray(args) && args[0] === "rename-workspace");
}

function herdrTabRenameCalls() {
  return execFileMock.mock.calls.filter(
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
  execFileMock.mockImplementation(((command: string, args?: readonly string[], callback?: ExecFileCallback) => {
    if (command === "herdr" && Array.isArray(args) && args[0] === "tab" && args[1] === "get") {
      callback?.(null, herdrTabGetOutput(currentLabel), "");
    } else if (command === "herdr" && Array.isArray(args) && args[0] === "tab" && args[1] === "rename") {
      currentLabel = String(args[3] ?? "");
      callback?.(null, "", "");
    } else {
      callback?.(null, "", "");
    }
    return {} as ReturnType<typeof execFile>;
  }) as typeof execFile);
  return {
    setLabel(label: string) {
      currentLabel = label;
    },
    getLabel() {
      return currentLabel;
    },
  };
}

const OLD_ENV = { ...process.env };

beforeEach(() => {
	vi.clearAllMocks();
	// `mockResolvedValueOnce` queues survive `clearAllMocks` — reset explicitly
	// so an unconsumed Haiku response from one test doesn't leak into the next.
	completeMock.mockReset();
  execFileMock.mockReset();
  execFileMock.mockImplementation(((command: string, args?: readonly string[], callback?: ExecFileCallback) => {
    callback?.(null, "", "");
    return {} as ReturnType<typeof execFile>;
  }) as typeof execFile);
  vi.mocked(fs.readFileSync).mockReset();
  vi.mocked(fs.readFileSync).mockImplementation(() => {
    throw new Error("no state file");
  });
  vi.mocked(fs.promises.mkdir).mockReset();
  vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined);
  vi.mocked(fs.promises.writeFile).mockReset();
  vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);
	process.env = { ...OLD_ENV };
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_TAB_ID;
  delete process.env.HERDR_SOCKET_PATH;
	// Make randomEmoji / randomTitleColor deterministic.
	vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
	process.env = { ...OLD_ENV };
	vi.restoreAllMocks();
	// The pane registry lives on globalThis and is shared across tests; detach any
	// host a test attached so standalone-path tests aren't affected by leakage.
	paneRegistry().setHost(null);
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe("session-banner extension", () => {
	it("registers /title and the lifecycle hooks", () => {
		const pi = createMockPi();
		sessionBanner(pi as any);
		expect(pi.registerCommand).toHaveBeenCalledWith("title", expect.any(Object));
		const events = pi.on.mock.calls.map((c) => c[0]);
		expect(events).toEqual(
			expect.arrayContaining([
				"session_start",
				"session_shutdown",
				"session_switch",
				"session_fork",
				"before_agent_start",
				"agent_end",
			]),
		);
	});

	describe("rich-editor host integration", () => {
		it("defers to the host and drops its own widget when a pane host is attached", async () => {
			const reg = paneRegistry();
			const requestRender = vi.fn();
			reg.setHost({ requestRender, onPanesChanged: vi.fn() });
			const pi = createMockPi();
			pi.getSessionName.mockReturnValue("\u{1F680} ship the release");
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			await pi.fire("session_start", ctx);

			// No standalone widget — the host composes our banner pane instead — and
			// the host is asked to repaint so the restored title lands immediately.
			expect(ctx.ui.setWidget).toHaveBeenCalledWith("session-banner", undefined);
			expect(ctx.ui.setWidget).not.toHaveBeenCalledWith("session-banner", expect.any(Function));
			expect(requestRender).toHaveBeenCalled();

			// The winning banner pane (order -10) renders the restored title.
			const pane = reg.banner();
			expect(pane?.id).toBe("session-banner:banner");
			expect(pane?.order).toBe(-10);
			expect(pane?.render(ctx as any)).toEqual({
				slot: "banner",
				emoji: "\u{1F680}",
				label: "ship the release",
				color: expect.any(String),
			});
		});

		it("banner pane renders null while the session is unnamed", async () => {
			const reg = paneRegistry();
			reg.setHost({ requestRender: vi.fn(), onPanesChanged: vi.fn() });
			const pi = createMockPi();
			pi.getSessionName.mockReturnValue("");
			sessionBanner(pi as any);
			await pi.fire("session_start", createMockCtx());
			expect(reg.banner()?.render(createMockCtx() as any)).toBeNull();
		});

		it("banner pane renders null when PI_SESSION_BANNER_WIDGET=off", async () => {
			process.env.PI_SESSION_BANNER_WIDGET = "off";
			const reg = paneRegistry();
			reg.setHost({ requestRender: vi.fn(), onPanesChanged: vi.fn() });
			const pi = createMockPi();
			pi.getSessionName.mockReturnValue("\u{1F680} ship the release");
			sessionBanner(pi as any);
			await pi.fire("session_start", createMockCtx());
			expect(reg.banner()?.render(createMockCtx() as any)).toBeNull();
		});

		it("unregisters its banner pane on quit so no dead closure survives", async () => {
			const reg = paneRegistry();
			reg.setHost({ requestRender: vi.fn(), onPanesChanged: vi.fn() });
			const pi = createMockPi();
			pi.getSessionName.mockReturnValue("\u{1F680} ship it");
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			await pi.fire("session_start", ctx);
			expect(reg.banner()?.id).toBe("session-banner:banner");

			await pi.fire("session_shutdown", ctx, { reason: "quit" });
			expect(reg.banner()).toBeNull();
		});

		it("keeps its banner pane on a non-quit shutdown (session replacement)", async () => {
			const reg = paneRegistry();
			reg.setHost({ requestRender: vi.fn(), onPanesChanged: vi.fn() });
			const pi = createMockPi();
			pi.getSessionName.mockReturnValue("\u{1F680} ship it");
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			await pi.fire("session_start", ctx);

			await pi.fire("session_shutdown", ctx, { reason: "new" });
			expect(reg.banner()?.id).toBe("session-banner:banner");
		});

		it("unregisters its banner pane on reload so a disabled/failed reload leaves no stale closure", async () => {
			const reg = paneRegistry();
			reg.setHost({ requestRender: vi.fn(), onPanesChanged: vi.fn() });
			const pi = createMockPi();
			pi.getSessionName.mockReturnValue("\u{1F680} ship it");
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			await pi.fire("session_start", ctx);
			expect(reg.banner()?.id).toBe("session-banner:banner");

			await pi.fire("session_shutdown", ctx, { reason: "reload" });
			expect(reg.banner()).toBeNull();
		});

		it("hands off to a host that attaches after session_start (80ms recheck)", async () => {
			vi.useFakeTimers();
			try {
				const reg = paneRegistry();
				// No host yet when session_start fires: a named session draws its own
				// standalone widget.
				const pi = createMockPi();
				pi.getSessionName.mockReturnValue("\u{1F680} ship it");
				sessionBanner(pi as any);
				const ctx = createMockCtx();
				await pi.fire("session_start", ctx);
				expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("session-banner", expect.any(Function));

				// The editor host attaches during the first paint (after session_start).
				// The 80ms recheck re-evaluates and hands the banner to the host.
				const requestRender = vi.fn();
				reg.setHost({ requestRender, onPanesChanged: vi.fn() });
				await vi.advanceTimersByTimeAsync(80);

				expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("session-banner", undefined);
				expect(requestRender).toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it("keeps polling and hands off to a host that attaches several paints later", async () => {
			vi.useFakeTimers();
			try {
				const reg = paneRegistry();
				const pi = createMockPi();
				pi.getSessionName.mockReturnValue("\u{1F680} ship it");
				sessionBanner(pi as any);
				const ctx = createMockCtx();
				await pi.fire("session_start", ctx);
				expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("session-banner", expect.any(Function));

				// A few rechecks pass with still no host (the widget stays put)…
				await vi.advanceTimersByTimeAsync(240);
				expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("session-banner", expect.any(Function));

				// …then the editor host finally attaches and the next tick hands off.
				const requestRender = vi.fn();
				reg.setHost({ requestRender, onPanesChanged: vi.fn() });
				await vi.advanceTimersByTimeAsync(80);
				expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("session-banner", undefined);
				expect(requestRender).toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it("gives up polling after the window when no host ever attaches (stays standalone)", async () => {
			vi.useFakeTimers();
			try {
				const pi = createMockPi();
				pi.getSessionName.mockReturnValue("\u{1F680} ship it");
				sessionBanner(pi as any);
				const ctx = createMockCtx();
				await pi.fire("session_start", ctx);
				expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("session-banner", expect.any(Function));

				// Poll for the full window (25 * 80ms) with no host, then give up.
				await vi.advanceTimersByTimeAsync(25 * 80);
				expect(vi.getTimerCount()).toBe(0); // recheck timer stopped, none rescheduled
				// The standalone widget was never cleared to undefined.
				expect(ctx.ui.setWidget).not.toHaveBeenCalledWith("session-banner", undefined);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("terminal title re-assertion after session_start", () => {
		// Core paints its own title after session_start; the deferred
		// re-asserts must win the boot race.
		it("re-asserts the title on the deferred schedule after session_start", async () => {
			vi.useFakeTimers();
			try {
				const pi = createMockPi();
				pi.getSessionName.mockReturnValue("🔮 fix bug");
				sessionBanner(pi as any);
				const ctx = createMockCtx();
				await pi.fire("session_start", ctx);
				ctx.ui.setTitle.mockClear();

				vi.advanceTimersByTime(150);
				expect(ctx.ui.setTitle).toHaveBeenCalledWith("π root //areas/core/myapp — 🔮 fix bug");

				ctx.ui.setTitle.mockClear();
				vi.advanceTimersByTime(900);
				expect(ctx.ui.setTitle).toHaveBeenCalledWith("π root //areas/core/myapp — 🔮 fix bug");
			} finally {
				vi.useRealTimers();
			}
		});

		it("adopts a session name that loads after session_start ran", async () => {
			vi.useFakeTimers();
			try {
				const pi = createMockPi();
				pi.getSessionName.mockReturnValue("");
				sessionBanner(pi as any);
				const ctx = createMockCtx();
				await pi.fire("session_start", ctx);
				ctx.ui.setTitle.mockClear();

				// Session info (and its name) delivered asynchronously after start.
				pi.getSessionName.mockReturnValue("🧭 late name");
				vi.advanceTimersByTime(150);

				expect(ctx.ui.setTitle).toHaveBeenCalledWith(expect.stringContaining("🧭 late name"));
			} finally {
				vi.useRealTimers();
			}
		});

		it("cancels pending re-asserts on session_shutdown", async () => {
			vi.useFakeTimers();
			try {
				const pi = createMockPi();
				pi.getSessionName.mockReturnValue("🔮 fix bug");
				sessionBanner(pi as any);
				const ctx = createMockCtx();
				await pi.fire("session_start", ctx);
				await pi.fire("session_shutdown", ctx, { reason: "quit" });
				ctx.ui.setTitle.mockClear();

				vi.advanceTimersByTime(2000);
				expect(ctx.ui.setTitle).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it("re-arms the deferred re-asserts after a rename (core repaints on session_info_changed)", async () => {
			vi.useFakeTimers();
			try {
				const pi = createMockPi();
				sessionBanner(pi as any);
				const ctx = createMockCtx();
				await pi.fire("session_start", ctx);
				vi.advanceTimersByTime(2000); // drain the boot re-asserts

				// Renames trigger a core repaint mid-idle; the rename's render
				// must re-arm the deferred re-asserts.
				await pi.runCommand("title", "shiny new name", ctx);

				ctx.ui.setTitle.mockClear();
				vi.advanceTimersByTime(150);
				expect(ctx.ui.setTitle).toHaveBeenCalledWith(expect.stringContaining("shiny new name"));
			} finally {
				vi.useRealTimers();
			}
		});

		it("cancels the previous session's pending re-asserts on session_switch", async () => {
			vi.useFakeTimers();
			try {
				const pi = createMockPi();
				pi.getSessionName.mockReturnValue("🅰️ session a");
				sessionBanner(pi as any);
				const ctx = createMockCtx();
				await pi.fire("session_start", ctx); // arms re-asserts at t=150/t=1000

				vi.advanceTimersByTime(100); // t=100: nothing fired yet
				pi.getSessionName.mockReturnValue("🅱️ session b");
				await pi.fire("session_switch", ctx); // must cancel A's timers

				// Window where A's leaked timer (t=150) would fire but B's first
				// re-assert (switch t=100 + restore 50ms + 150ms = t=300) has not.
				// A leaked timer paints with post-switch state, so content-based
				// assertions can't catch it — only the timing window can.
				ctx.ui.setTitle.mockClear();
				vi.advanceTimersByTime(120); // t=220: only B's deferred restore (t=150) should paint
				expect(ctx.ui.setTitle).toHaveBeenCalledTimes(1); // a leaked A timer would make this 2

				ctx.ui.setTitle.mockClear();
				vi.advanceTimersByTime(80); // t=300: B's first re-assert fires
				expect(ctx.ui.setTitle).toHaveBeenCalledWith(expect.stringContaining("🅱️ session b"));
			} finally {
				vi.useRealTimers();
			}
		});

		it("re-asserts the title after the deferred session_switch restore", async () => {
			vi.useFakeTimers();
			try {
				const pi = createMockPi();
				pi.getSessionName.mockReturnValue("⚡ other session");
				sessionBanner(pi as any);
				const ctx = createMockCtx();
				await pi.fire("session_switch", ctx);

				vi.advanceTimersByTime(50); // deferred restore paints
				ctx.ui.setTitle.mockClear();
				vi.advanceTimersByTime(150); // first scheduled re-assert
				expect(ctx.ui.setTitle).toHaveBeenCalledWith(expect.stringContaining("⚡ other session"));
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("terminal title re-assertion on agent turns", () => {
		it("does not double-paint when an externally changed name was adopted", async () => {
			const pi = createMockPi();
			pi.getSessionName.mockReturnValue("🔮 fix bug");
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			await pi.fire("session_start", ctx);

			// Name changed externally between turns (e.g. another tool renamed it).
			pi.getSessionName.mockReturnValue("⚡ renamed");
			ctx.ui.setTitle.mockClear();

			await pi.fire("before_agent_start", ctx, { prompt: "next" });

			// Adoption renders exactly once; the handler skips its own repaint.
			expect(ctx.ui.setTitle).toHaveBeenCalledTimes(1);
			expect(ctx.ui.setTitle).toHaveBeenCalledWith(expect.stringContaining("⚡ renamed"));
		});

		it("repaints the terminal title on before_agent_start for an already-named session", async () => {
			const pi = createMockPi();
			pi.getSessionName.mockReturnValue("🔮 fix bug");
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			await pi.fire("session_start", ctx);
			ctx.ui.setTitle.mockClear();

			await pi.fire("before_agent_start", ctx, { prompt: "next step" });

			expect(ctx.ui.setTitle).toHaveBeenCalledWith("π root //areas/core/myapp — 🔮 fix bug");
		});

		it("repaints the terminal title on agent_end for an already-named session", async () => {
			const pi = createMockPi();
			pi.getSessionName.mockReturnValue("🔮 fix bug");
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			await pi.fire("session_start", ctx);
			ctx.ui.setTitle.mockClear();

			await pi.fire("agent_end", ctx);
			await flushMicrotasks();

			expect(ctx.ui.setTitle).toHaveBeenCalledWith("π root //areas/core/myapp — 🔮 fix bug");
		});

		it("respects PI_SESSION_BANNER_TITLE_ORDER=label-first when repainting on agent_end", async () => {
			process.env.PI_SESSION_BANNER_TITLE_ORDER = "label-first";
			try {
				const pi = createMockPi();
				pi.getSessionName.mockReturnValue("🔮 fix bug");
				sessionBanner(pi as any);
				const ctx = createMockCtx();
				await pi.fire("session_start", ctx);
				ctx.ui.setTitle.mockClear();

				await pi.fire("agent_end", ctx);
				await flushMicrotasks();

				expect(ctx.ui.setTitle).toHaveBeenCalledWith("π 🔮 fix bug — root //areas/core/myapp");
			} finally {
				delete process.env.PI_SESSION_BANNER_TITLE_ORDER;
			}
		});
	});

	describe("session_start", () => {
		it("sets terminal title and hides widget when there is no existing label", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			await pi.fire("session_start", ctx);
			expect(ctx.ui.setTitle).toHaveBeenCalledWith("π root //areas/core/myapp");
			expect(ctx.ui.setWidget).toHaveBeenCalledWith("session-banner", undefined);
		});

		it("restores label + emoji from existing session name and renders the banner widget", async () => {
			const pi = createMockPi();
			pi.getSessionName.mockReturnValue("🔮 fix bug");
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			await pi.fire("session_start", ctx);

			expect(ctx.ui.setTitle).toHaveBeenCalledWith("π root //areas/core/myapp — 🔮 fix bug");
			const widgetCall = ctx.ui.setWidget.mock.calls.find((c) => typeof c[1] === "function");
			expect(widgetCall).toBeDefined();
			const factory = widgetCall![1] as (tui: unknown, theme: any) => any;
			const theme = {
				fg: (_color: string, s: string) => s,
				bold: (s: string) => s,
			};
			const widget = factory({}, theme);
			const lines = widget.render(20);
			expect(lines).toHaveLength(3);
			expect(lines[1]).toContain("🔮");
			expect(lines[1]).toContain("fix bug");
			// invalidate is a no-op but exists
			expect(() => widget.invalidate()).not.toThrow();
		});

		it("does nothing when hasUI is false", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({ hasUI: false });
			await pi.fire("session_start", ctx);
			expect(ctx.ui.setTitle).not.toHaveBeenCalled();
			expect(ctx.ui.setWidget).not.toHaveBeenCalled();
		});
	});

	describe("PI_SESSION_BANNER_WIDGET", () => {
		it("hides the banner widget but keeps the terminal title when set to off", async () => {
			process.env.PI_SESSION_BANNER_WIDGET = "off";
			const pi = createMockPi();
			pi.getSessionName.mockReturnValue("\u{1F52E} fix bug");
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			await pi.fire("session_start", ctx);

			// Terminal/tab title (and the pi session name) still flow through.
			expect(ctx.ui.setTitle).toHaveBeenCalledWith("\u03C0 root //areas/core/myapp \u2014 \u{1F52E} fix bug");
			// No widget factory is ever registered; the widget is explicitly cleared.
			const widgetFactoryCall = ctx.ui.setWidget.mock.calls.find((c) => typeof c[1] === "function");
			expect(widgetFactoryCall).toBeUndefined();
			expect(ctx.ui.setWidget).toHaveBeenCalledWith("session-banner", undefined);
		});

		it("renders the banner widget by default when the env var is unset", async () => {
			delete process.env.PI_SESSION_BANNER_WIDGET;
			const pi = createMockPi();
			pi.getSessionName.mockReturnValue("\u{1F52E} fix bug");
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			await pi.fire("session_start", ctx);
			const widgetFactoryCall = ctx.ui.setWidget.mock.calls.find((c) => typeof c[1] === "function");
			expect(widgetFactoryCall).toBeDefined();
		});
	});

	describe("PI_SESSION_BANNER_TITLE_ORDER", () => {
		afterEach(() => {
			delete process.env.PI_SESSION_BANNER_TITLE_ORDER;
		});

		it("puts the label first and tree/zone context last when set to label-first", async () => {
			process.env.PI_SESSION_BANNER_TITLE_ORDER = "label-first";
			const pi = createMockPi();
			pi.getSessionName.mockReturnValue("\u{1F52E} fix bug");
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			await pi.fire("session_start", ctx);

			expect(ctx.ui.setTitle).toHaveBeenCalledWith("\u03C0 \u{1F52E} fix bug \u2014 root //areas/core/myapp");
		});

		it("keeps the context-only title unchanged for unnamed sessions in label-first", async () => {
			process.env.PI_SESSION_BANNER_TITLE_ORDER = "label-first";
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			await pi.fire("session_start", ctx);

			expect(ctx.ui.setTitle).toHaveBeenCalledWith("\u03C0 root //areas/core/myapp");
		});

		it("defaults to zone-first when the env var is unset", async () => {
			delete process.env.PI_SESSION_BANNER_TITLE_ORDER;
			const pi = createMockPi();
			pi.getSessionName.mockReturnValue("\u{1F52E} fix bug");
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			await pi.fire("session_start", ctx);

			expect(ctx.ui.setTitle).toHaveBeenCalledWith("\u03C0 root //areas/core/myapp \u2014 \u{1F52E} fix bug");
		});

		it("falls back to zone-first on unrecognized values", async () => {
			process.env.PI_SESSION_BANNER_TITLE_ORDER = "labelfirst";
			const pi = createMockPi();
			pi.getSessionName.mockReturnValue("\u{1F52E} fix bug");
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			await pi.fire("session_start", ctx);

			expect(ctx.ui.setTitle).toHaveBeenCalledWith("\u03C0 root //areas/core/myapp \u2014 \u{1F52E} fix bug");
		});
	});

	describe("session_switch", () => {
		it("defers and re-renders for the new session", async () => {
			vi.useFakeTimers();
			try {
				const pi = createMockPi();
				pi.getSessionName.mockReturnValue("⚡ other session");
				sessionBanner(pi as any);
				const ctx = createMockCtx();

				await pi.fire("session_switch", ctx);
				// Hasn't fired yet — deferred 50ms
				expect(ctx.ui.setTitle).not.toHaveBeenCalled();

				await vi.advanceTimersByTimeAsync(50);
				expect(ctx.ui.setTitle).toHaveBeenCalledWith(expect.stringContaining("⚡ other session"));
			} finally {
				vi.useRealTimers();
			}
		});

		it("cancels a pending deferred render when another session switch happens", async () => {
			vi.useFakeTimers();
			try {
				const pi = createMockPi();
				sessionBanner(pi as any);
				const firstCtx = createMockCtx({ cwd: "/Users/me/world/trees/root/src/areas/core/myapp" });
				const secondCtx = createMockCtx({ cwd: "/Users/me/world/trees/root/src/areas/apps/flow" });

				await pi.fire("session_switch", firstCtx);
				await pi.fire("session_switch", secondCtx);
				await vi.advanceTimersByTimeAsync(50);

				expect(firstCtx.ui.setTitle).not.toHaveBeenCalled();
				expect(secondCtx.ui.setTitle).toHaveBeenCalledWith("π root //areas/apps/flow");
			} finally {
				vi.useRealTimers();
			}
		});

		it("cancels a pending deferred render when the session is forked", async () => {
			vi.useFakeTimers();
			try {
				const pi = createMockPi();
				sessionBanner(pi as any);
				const switchCtx = createMockCtx({ cwd: "/Users/me/world/trees/root/src/areas/core/myapp" });
				const forkCtx = createMockCtx({ cwd: "/Users/me/world/trees/root/src/areas/platforms/agent-server" });

				await pi.fire("session_switch", switchCtx);
				await pi.fire("session_fork", forkCtx);
				await vi.advanceTimersByTimeAsync(50);

				expect(switchCtx.ui.setTitle).not.toHaveBeenCalled();
				expect(forkCtx.ui.setTitle).toHaveBeenCalledWith("π root //areas/platforms/agent-server");
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("session_fork", () => {
		it("re-arms auto-naming when an unnamed new branch follows a named session", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("forked work title");
			const ctx = createMockCtx({ branch: [] });
			pi.getSessionName.mockReturnValue("\u{1F52E} parent task");
			await pi.fire("session_start", ctx);
			pi.getSessionName.mockReturnValue("");

			await pi.fire("session_fork", ctx);
			expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("session-banner", undefined);

			// Unnamed fork -> auto-naming proceeds on the next turn.
			await pi.fire("before_agent_start", ctx, { prompt: "specific forked prompt" });
			await flushMicrotasks();
			expect(completeMock).toHaveBeenCalledTimes(1);
			expect(pi.setSessionName).toHaveBeenCalledWith(expect.stringMatching(/^.+ forked work title$/));
		});

		it("renders an inherited parent name and does not re-auto-name when a fork carries it", async () => {
			// Forking after an auto-name landed: Pi copies the parent's session_info
			// (name) into the branched session, so getSessionName() is non-empty.
			const pi = createMockPi();
			pi.getSessionName.mockReturnValue("\u{1F52E} parent task");
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [userMsg("do the parent task")] });
			await pi.fire("session_fork", ctx);

			// Banner shows the inherited name instead of being hidden.
			expect(ctx.ui.setTitle).toHaveBeenCalledWith(expect.stringContaining("\u{1F52E} parent task"));
			const widgetCall = ctx.ui.setWidget.mock.calls.find((c) => typeof c[1] === "function");
			expect(widgetCall).toBeDefined();

			// Auto-naming stays off — the fork keeps the inherited name (no back-off wedge).
			await pi.fire("before_agent_start", ctx, { prompt: "do the parent task" });
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();
			expect(completeMock).not.toHaveBeenCalled();
		});
	});

	describe("session_branch (OMP)", () => {
		it("re-arms auto-naming when an unnamed new branch follows a named session", async () => {
			const pi = createMockPi();
			sessionBanner(pi as unknown as Parameters<typeof sessionBanner>[0]);
			mockHaikuResponse("branched OMP work title");
			const ctx = createMockCtx({ branch: [] });
			pi.getSessionName.mockReturnValue("\u{1F52E} parent task");
			await pi.fire("session_start", ctx);
			pi.getSessionName.mockReturnValue("");

			await pi.fire("session_branch", ctx);
			expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("session-banner", undefined);

			await pi.fire("before_agent_start", ctx, { prompt: "specific OMP branch prompt" });
			await flushMicrotasks();
			expect(completeMock).toHaveBeenCalledTimes(1);
			expect(pi.setSessionName).toHaveBeenCalledWith(
				expect.stringMatching(/^.+ branched OMP work title$/),
			);
		});
	});

	describe("headless sessions skip lifecycle work (hasUI === false)", () => {
		it("session_switch does nothing when there is no UI", async () => {
			vi.useFakeTimers();
			try {
				const pi = createMockPi();
				pi.getSessionName.mockReturnValue("\u26A1 other session");
				sessionBanner(pi as any);
				const ctx = createMockCtx({ hasUI: false });

				await pi.fire("session_switch", ctx);
				await vi.advanceTimersByTimeAsync(50);

				expect(ctx.ui.setTitle).not.toHaveBeenCalled();
				expect(ctx.ui.setWidget).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it("session_fork does nothing when there is no UI", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("forked work title");
			const ctx = createMockCtx({ hasUI: false, branch: [] });

			await pi.fire("session_fork", ctx);
			await pi.fire("before_agent_start", ctx, { prompt: "specific forked prompt" });
			await flushMicrotasks();

			expect(ctx.ui.setWidget).not.toHaveBeenCalled();
			expect(completeMock).not.toHaveBeenCalled();
		});

		it("before_agent_start does not auto-name when there is no UI", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("headless title");
			const ctx = createMockCtx({ hasUI: false });

			await pi.fire("before_agent_start", ctx, { prompt: "fix the checkout tax bug" });
			await flushMicrotasks();

			expect(completeMock).not.toHaveBeenCalled();
			expect(pi.setSessionName).not.toHaveBeenCalled();
		});

		// Legacy runtimes report hasUI === undefined. The strict `=== false` guard
		// lets them through (conservative fallback), and paintBanner's own `!hasUI`
		// check is what keeps a headless legacy session from touching the title.
		it("session_start with undefined hasUI passes the guard but paintBanner still no-ops", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			(ctx as any).hasUI = undefined;

			await pi.fire("session_start", ctx);

			expect(ctx.ui.setTitle).not.toHaveBeenCalled();
			expect(ctx.ui.setWidget).not.toHaveBeenCalled();
		});
	});

	describe("session_shutdown title cleanup", () => {
		it("clears the terminal title on a real quit so it doesn't linger after pi exits", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			ctx.ui.setTitle.mockClear();

			await pi.fire("session_shutdown", ctx, { reason: "quit" });

			expect(ctx.ui.setTitle).toHaveBeenCalledWith("");
		});

		it("clears the title when shutdown carries no reason (older SDK fires it only on exit)", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			ctx.ui.setTitle.mockClear();

			await pi.fire("session_shutdown", ctx);

			expect(ctx.ui.setTitle).toHaveBeenCalledWith("");
		});

		it("clears the title on reload so a reload-to-disabled doesn't leave a stale title", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			ctx.ui.setTitle.mockClear();

			await pi.fire("session_shutdown", ctx, { reason: "reload" });

			expect(ctx.ui.setTitle).toHaveBeenCalledWith("");
		});

		it.each(["new", "resume", "fork"])(
			"does not clear the title on a %s replacement (the same instance's session_switch re-sets it)",
			async (reason) => {
				const pi = createMockPi();
				sessionBanner(pi as any);
				const ctx = createMockCtx();
				ctx.ui.setTitle.mockClear();

				await pi.fire("session_shutdown", ctx, { reason });

				expect(ctx.ui.setTitle).not.toHaveBeenCalled();
			},
		);

		it("does not touch the title on quit when there is no UI (print mode)", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({ hasUI: false });
			ctx.ui.setTitle.mockClear();

			await pi.fire("session_shutdown", ctx, { reason: "quit" });

			expect(ctx.ui.setTitle).not.toHaveBeenCalled();
		});

		it("does not throw when the shutdown event is malformed (null) and treats it as a quit", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			ctx.ui.setTitle.mockClear();

			const shutdownHandler = pi.on.mock.calls.find(
				(c) => c[0] === "session_shutdown",
			)?.[1] as Handler;
			expect(shutdownHandler).toBeDefined();

			await expect(shutdownHandler(null, ctx)).resolves.toBeUndefined();
			expect(ctx.ui.setTitle).toHaveBeenCalledWith("");
		});
	});

	describe("auto-naming", () => {
		it("calls Haiku, sets the session name with emoji, and renders the banner (agent_end path)", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("fix flaky pagination test");
			const ctx = createMockCtx({ branch: [userMsg("help me debug a flaky test")] });

			await pi.fire("session_start", ctx);
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();

			expect(completeMock).toHaveBeenCalledTimes(1);
			expect(pi.setSessionName).toHaveBeenCalledWith(expect.stringMatching(/^.+ fix flaky pagination test$/));
		});

		it("uses the contextual emoji the model prefixes onto the title", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("\u{1F41B} fix checkout tax bug");
			const ctx = createMockCtx({ branch: [userMsg("the checkout tax is wrong")] });

			await pi.fire("session_start", ctx);
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();

			expect(pi.setSessionName).toHaveBeenCalledWith("\u{1F41B} fix checkout tax bug");
		});

		it("falls back to a random emoji when the model omits one", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			// Math.random is mocked to 0 -> SESSION_EMOJI[0] = \u{1F52E}.
			mockHaikuResponse("plain title no emoji");
			const ctx = createMockCtx({ branch: [userMsg("do the thing")] });

			await pi.fire("session_start", ctx);
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();

			expect(pi.setSessionName).toHaveBeenCalledWith("\u{1F52E} plain title no emoji");
		});

		it("uses the contextual emoji + label from the model when naming", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("\u{1F9EA} add test coverage");
			const ctx = createMockCtx({ branch: [] });

			await pi.fire("session_start", ctx);
			await pi.fire("before_agent_start", ctx, { prompt: "add some tests" });
			await flushMicrotasks();
			expect(pi.setSessionName).toHaveBeenLastCalledWith("\u{1F9EA} add test coverage");
		});

		it("locks the name after the first confident auto-name; a later turn does not overwrite it", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("\u{1F9EA} add test coverage");
			const ctx = createMockCtx({ branch: [] });

			await pi.fire("session_start", ctx);
			await pi.fire("before_agent_start", ctx, { prompt: "add some tests" });
			await flushMicrotasks();
			expect(pi.setSessionName).toHaveBeenLastCalledWith("\u{1F9EA} add test coverage");
			expect(completeMock).toHaveBeenCalledTimes(1);

			// A later turn about a follow-up must NOT re-name the session — the
			// original intent stays locked in. Haiku is never called again.
			mockHaikuResponse("\u{1F41B} fix failing test");
			ctx.sessionManager.getBranch.mockReturnValue([userMsg("add some tests")]);
			await pi.fire("before_agent_start", ctx, { prompt: "now also fix the failing one" });
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();
			expect(completeMock).toHaveBeenCalledTimes(1);
			expect(pi.setSessionName).toHaveBeenLastCalledWith("\u{1F9EA} add test coverage");
		});

		it("names from the very first user message via before_agent_start, before agent_end fires", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("fix checkout tax bug");
			// Branch is empty at before_agent_start time — the new prompt isn't persisted yet.
			const ctx = createMockCtx({ branch: [] });

			await pi.fire("session_start", ctx);
			await pi.fire("before_agent_start", ctx, { prompt: "fix the checkout tax bug in checkout_tax.rb" });
			await flushMicrotasks();

			expect(completeMock).toHaveBeenCalledTimes(1);
			expect(pi.setSessionName).toHaveBeenCalledWith(
				expect.stringMatching(/^.+ fix checkout tax bug$/),
			);

			// The prompt is spliced into the conversation context sent to Haiku.
			const userText = (completeMock.mock.calls[0]![1] as any).messages[0].content[0].text as string;
			expect(userText).toContain("fix the checkout tax bug in checkout_tax.rb");
		});

		it("does not re-name on agent_end after a successful early naming (locked)", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("first naming");
			const ctx = createMockCtx({ branch: [] });

			await pi.fire("session_start", ctx);
			await pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });
			await flushMicrotasks();
			expect(completeMock).toHaveBeenCalledTimes(1);
			expect(pi.setSessionName).toHaveBeenLastCalledWith(expect.stringMatching(/^.+ first naming$/));

			// agent_end fires after the early call already named the session — the
			// late backstop must be a no-op now, not a second Haiku call that churns
			// the title.
			mockHaikuResponse("refined naming");
			ctx.sessionManager.getBranch.mockReturnValue([userMsg("specific opening prompt")]);
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();
			expect(completeMock).toHaveBeenCalledTimes(1);
			expect(pi.setSessionName).toHaveBeenLastCalledWith(expect.stringMatching(/^.+ first naming$/));
		});

		it("early SKIP defers naming, agent_end retries with assistant context", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			// Early call: vague prompt — Haiku skips.
			mockHaikuResponse("SKIP");
			// Late call: assistant reply now in context, Haiku produces a title.
			mockHaikuResponse("investigate flaky checkout test");

			const ctx = createMockCtx({ branch: [] });
			await pi.fire("session_start", ctx);
			await pi.fire("before_agent_start", ctx, { prompt: "help" });
			await flushMicrotasks();
			expect(pi.setSessionName).not.toHaveBeenCalled();

			ctx.sessionManager.getBranch.mockReturnValue([
				userMsg("help"),
				{ type: "message", message: { role: "assistant", content: "Sure — what specifically?" } },
			]);
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();

			expect(completeMock).toHaveBeenCalledTimes(2);
			expect(pi.setSessionName).toHaveBeenCalledWith(
				expect.stringMatching(/^.+ investigate flaky checkout test$/),
			);
		});

		it("successive SKIPs across turns wait until a turn produces a title", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [] });
			await pi.fire("session_start", ctx);

			// Turn 1 early: vague prompt — Haiku skips.
			mockHaikuResponse("SKIP");
			await pi.fire("before_agent_start", ctx, { prompt: "hi" });
			await flushMicrotasks();

			// Turn 1 late: assistant has now replied. Branch has user + assistant.
			// Haiku is still not sure — SKIP again.
			mockHaikuResponse("SKIP");
			ctx.sessionManager.getBranch.mockReturnValue([
				userMsg("hi"),
				{ type: "message", message: { role: "assistant", content: "What do you want to do?" } },
			]);
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();
			expect(pi.setSessionName).not.toHaveBeenCalled();
			expect(completeMock).toHaveBeenCalledTimes(2);

			// Turn 2 early: a specific prompt — Haiku names it.
			mockHaikuResponse("add bandit dashboard");
			await pi.fire("before_agent_start", ctx, {
				prompt: "add a bandit dashboard for the f_storefront_agent rollout",
			});
			await flushMicrotasks();
			expect(pi.setSessionName).toHaveBeenCalledWith(expect.stringMatching(/^.+ add bandit dashboard$/));
		});

		it("stops retrying an unnamed session after MAX_AUTO_TURNS (3) user turns", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
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
			expect(completeMock).toHaveBeenCalledTimes(3);
			expect(pi.setSessionName).not.toHaveBeenCalled();

			// 4th turn — past the cap, should not call Haiku again from either hook.
			mockHaikuResponse("too late to name");
			await pi.fire("before_agent_start", ctx, { prompt: "turn 4" });
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();
			expect(completeMock).toHaveBeenCalledTimes(3);
			expect(pi.setSessionName).not.toHaveBeenCalled();
		});

		it("early call uses the SKIP-allowed system prompt; late call uses the SKIP-suppressed one", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [] });
			await pi.fire("session_start", ctx);

			// Early call SKIPs, so the session stays unnamed and the late backstop
			// still runs — letting us assert both system prompts.
			mockHaikuResponse("SKIP");
			await pi.fire("before_agent_start", ctx, { prompt: "vague prompt" });
			await flushMicrotasks();
			const earlyPrompt = (completeMock.mock.calls[0]![1] as any).systemPrompt as string;
			expect(earlyPrompt).toContain("SKIP rule");

			// Late call.
			mockHaikuResponse("late title");
			ctx.sessionManager.getBranch.mockReturnValue([
				userMsg("vague prompt"),
				{ type: "message", message: { role: "assistant", content: "Here's what I'll do." } },
			]);
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();
			const latePrompt = (completeMock.mock.calls[1]![1] as any).systemPrompt as string;
			expect(latePrompt).not.toContain("SKIP rule");
			expect(latePrompt).toContain("Always emit a title");
		});

		it("in-flight early call prevents agent_end from racing in the same turn", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [] });

			let resolveFirst!: (v: any) => void;
			completeMock.mockReturnValueOnce(
				new Promise((r) => {
					resolveFirst = r;
				}) as any,
			);
			await pi.fire("session_start", ctx);
			await pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });

			// agent_end fires before Haiku resolves — should not start a parallel call.
			await pi.fire("agent_end", ctx);
			expect(completeMock).toHaveBeenCalledTimes(1);

			// Now resolve the early call with a title. The queued late backstop is dropped.
			resolveFirst({ content: [{ type: "text", text: "opening title" }] });
			await flushMicrotasks();
			expect(completeMock).toHaveBeenCalledTimes(1);
			expect(pi.setSessionName).toHaveBeenCalledWith(expect.stringMatching(/^.+ opening title$/));
		});

		it("runs a queued late backstop when the in-flight early call skips", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [] });

			let resolveFirst!: (v: any) => void;
			completeMock.mockReturnValueOnce(
				new Promise((r) => {
					resolveFirst = r;
				}) as any,
			);
			await pi.fire("session_start", ctx);
			await pi.fire("before_agent_start", ctx, { prompt: "help" });

			ctx.sessionManager.getBranch.mockReturnValue([
				userMsg("help"),
				{ type: "message", message: { role: "assistant", content: "Let's debug the flaky checkout test." } },
			]);
			mockHaikuResponse("debug flaky checkout test");
			await pi.fire("agent_end", ctx);
			expect(completeMock).toHaveBeenCalledTimes(1);

			resolveFirst({ content: [{ type: "text", text: "SKIP" }] });
			await flushMicrotasks();

			expect(completeMock).toHaveBeenCalledTimes(2);
			const latePrompt = (completeMock.mock.calls[1]![1] as any).systemPrompt as string;
			expect(latePrompt).toContain("Always emit a title");
			expect(pi.setSessionName).toHaveBeenCalledWith(
				expect.stringMatching(/^.+ debug flaky checkout test$/),
			);
		});

		it("does not queue another early attempt while a generation is in flight", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [] });

			let resolveFirst!: (v: any) => void;
			completeMock.mockReturnValueOnce(
				new Promise((r) => {
					resolveFirst = r;
				}) as any,
			);
			await pi.fire("session_start", ctx);
			await pi.fire("before_agent_start", ctx, { prompt: "first prompt" });
			await pi.fire("before_agent_start", ctx, { prompt: "second prompt" });
			expect(completeMock).toHaveBeenCalledTimes(1);

			resolveFirst({ content: [{ type: "text", text: "SKIP" }] });
			await flushMicrotasks();

			expect(completeMock).toHaveBeenCalledTimes(1);
			expect(pi.setSessionName).not.toHaveBeenCalled();
		});

		it("backs off if the current name differs from the last auto-applied name", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("auto generated");
			const ctx = createMockCtx({ branch: [userMsg("specific opening prompt")] });

			await pi.fire("session_start", ctx);
			await pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });
			await flushMicrotasks();
			expect(completeMock).toHaveBeenCalledTimes(1);

			pi.getSessionName.mockReturnValue("user picked this");
			mockHaikuResponse("should not apply");
			await pi.fire("before_agent_start", ctx, { prompt: "another specific prompt" });
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();

			expect(completeMock).toHaveBeenCalledTimes(1);
			expect(pi.setSessionName).toHaveBeenCalledTimes(1);
			expect(ctx.ui.setTitle).toHaveBeenLastCalledWith("π root //areas/core/myapp — 🔮 user picked this");
			expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("session-banner", expect.any(Function));
		});

		it("adopts an externally cleared session name by hiding the banner", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("auto generated");
			const ctx = createMockCtx({ branch: [userMsg("specific opening prompt")] });

			await pi.fire("session_start", ctx);
			await pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });
			await flushMicrotasks();
			expect(pi.setSessionName).toHaveBeenCalledTimes(1);

			pi.setSessionName.mockClear();
			pi.getSessionName.mockReturnValue("");
			await pi.fire("before_agent_start", ctx, { prompt: "another specific prompt" });
			await flushMicrotasks();

			expect(pi.setSessionName).not.toHaveBeenCalled();
			expect(ctx.ui.setTitle).toHaveBeenLastCalledWith("π root //areas/core/myapp");
			expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("session-banner", undefined);
		});

		it("continues adopting external renames after auto-naming backs off", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [userMsg("hi")] });

			await pi.fire("session_start", ctx);
			pi.getSessionName.mockReturnValue("first manual name");
			await pi.fire("before_agent_start", ctx, { prompt: "hi" });
			await flushMicrotasks();
			expect(completeMock).not.toHaveBeenCalled();
			expect(ctx.ui.setTitle).toHaveBeenLastCalledWith("π root //areas/core/myapp — 🔮 first manual name");

			pi.getSessionName.mockReturnValue("second manual name");
			await pi.fire("before_agent_start", ctx, { prompt: "hi again" });
			await flushMicrotasks();

			expect(completeMock).not.toHaveBeenCalled();
			expect(pi.setSessionName).not.toHaveBeenCalled();
			expect(ctx.ui.setTitle).toHaveBeenLastCalledWith("π root //areas/core/myapp — 🔮 second manual name");
			expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("session-banner", expect.any(Function));
		});

		it("drops stale auto-name results after session_shutdown so stale `pi` handles are never touched", async () => {
			// When pi replaces the session (newSession / fork / switchSession / reload),
			// the OLD extension instance receives `session_shutdown` and its captured
			// `pi` / `ctx` become stale. A Haiku call still in flight must early-return
			// before calling `pi.getSessionName()` or `pi.setSessionName()`, otherwise
			// loader.assertActive throws and crashes pi. We assert that by failing the
			// captured `pi` after shutdown and confirming the late resolution does not
			// touch it.
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [] });
			let resolveAutoName!: (v: any) => void;
			completeMock.mockReturnValueOnce(
				new Promise((r) => {
					resolveAutoName = r;
				}) as any,
			);

			await pi.fire("session_start", ctx);
			await pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });
			await pi.fire("session_shutdown", ctx, { reason: "new" });

			// Simulate the captured `pi` becoming stale post-shutdown: any call to
			// getSessionName / setSessionName after this point would crash pi in
			// production with loader.assertActive.
			pi.getSessionName.mockClear();
			pi.setSessionName.mockClear();
			pi.getSessionName.mockImplementation(() => {
				throw new Error("stale ctx after session replacement");
			});
			pi.setSessionName.mockImplementation(() => {
				throw new Error("stale ctx after session replacement");
			});

			resolveAutoName({ content: [{ type: "text", text: "late title" }] });
			await flushMicrotasks();

			// The epoch bump in session_shutdown gates the .then() so neither getter
			// nor setter is invoked after the session was replaced.
			expect(pi.setSessionName).not.toHaveBeenCalled();
			expect(pi.getSessionName).not.toHaveBeenCalled();
		});

		it("drops stale auto-name results after a session switch", async () => {
			vi.useFakeTimers();
			try {
				const pi = createMockPi();
				sessionBanner(pi as any);
				const ctx = createMockCtx({ branch: [] });
				let resolveAutoName!: (v: any) => void;
				completeMock.mockReturnValueOnce(
					new Promise((r) => {
						resolveAutoName = r;
					}) as any,
				);

				await pi.fire("session_start", ctx);
				await pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });
				await pi.fire("session_switch", ctx);

				resolveAutoName({ content: [{ type: "text", text: "stale title" }] });
				await flushMicrotasks();
				expect(pi.setSessionName).not.toHaveBeenCalled();

				await vi.advanceTimersByTimeAsync(50);
			} finally {
				vi.useRealTimers();
			}
		});

		it("drops a stale auto-name result after /title sets a manual name", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [] });
			let resolveAutoName!: (v: any) => void;
			completeMock.mockReturnValueOnce(
				new Promise((r) => {
					resolveAutoName = r;
				}) as any,
			);

			await pi.fire("session_start", ctx);
			await pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });
			await pi.runCommand("title", "manual title", ctx);

			resolveAutoName({ content: [{ type: "text", text: "stale title" }] });
			await flushMicrotasks();

			expect(pi.setSessionName).toHaveBeenCalledTimes(1);
			expect(pi.setSessionName).toHaveBeenLastCalledWith(expect.stringMatching(/^.+ manual title$/));
		});

		it("clears in-flight state when generateName rejects before a stale request exists", async () => {
			const pi = createMockPi();
			const findModel = vi
				.fn()
				.mockImplementationOnce(() => {
					throw new Error("model registry exploded");
				})
				.mockImplementation(() => ({ id: "claude-haiku-4-5", provider: "anthropic" }));
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [userMsg("hi")], findModel });

			await pi.fire("session_start", ctx);
			await pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });
			await flushMicrotasks();

			mockHaikuResponse("retry title");
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();

			expect(completeMock).toHaveBeenCalledTimes(1);
			expect(pi.setSessionName).toHaveBeenCalledWith(expect.stringMatching(/^.+ retry title$/));
		});

		it("leaves newer state alone when a stale generateName rejection arrives", async () => {
			const pi = createMockPi();
			const findModel = vi.fn(() => {
				throw new Error("model registry exploded");
			});
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [], findModel });

			await pi.fire("session_start", ctx);
			const firstAutoName = pi.fire("before_agent_start", ctx, { prompt: "specific opening prompt" });
			await pi.runCommand("title", "manual title", ctx);
			await firstAutoName;
			await flushMicrotasks();

			expect(pi.setSessionName).toHaveBeenCalledTimes(1);
			expect(pi.setSessionName).toHaveBeenLastCalledWith(expect.stringMatching(/^.+ manual title$/));
		});

		it("stays backed off across subsequent turns once we've stopped", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [userMsg("hi")] });

			await pi.fire("session_start", ctx);
			// Turn 1: external rename triggers permanent back-off.
			pi.getSessionName.mockReturnValue("user picked this");
			await pi.fire("before_agent_start", ctx, { prompt: "hi" });
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();
			expect(completeMock).not.toHaveBeenCalled();

			// Turn 2: even if the user clears the name, we stay backed off.
			pi.getSessionName.mockReturnValue("");
			await pi.fire("before_agent_start", ctx, { prompt: "hi" });
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();
			expect(completeMock).not.toHaveBeenCalled();
		});

		it("does not auto-name when the session already has a name on session_start (e.g. /resume)", async () => {
			const pi = createMockPi();
			pi.getSessionName.mockReturnValue("🔮 resumed session");
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [userMsg("hi")] });

			await pi.fire("session_start", ctx);
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();
			expect(completeMock).not.toHaveBeenCalled();
		});

		it("skips when the conversation is empty", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [] });

			await pi.fire("session_start", ctx);
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();
			expect(completeMock).not.toHaveBeenCalled();
		});

		it("returns null and does not setSessionName when the model is not registered", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({
				branch: [userMsg("hi")],
				findModel: vi.fn(() => undefined),
			});

			await pi.fire("session_start", ctx);
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();
			expect(completeMock).not.toHaveBeenCalled();
			expect(pi.setSessionName).not.toHaveBeenCalled();
		});

		it("returns null and does not setSessionName when no API key is available", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({
				branch: [userMsg("hi")],
				getApiKeyAndHeaders: vi.fn(async () => ({ ok: false, error: "no creds" })),
			});

			await pi.fire("session_start", ctx);
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();
			expect(completeMock).not.toHaveBeenCalled();
			expect(pi.setSessionName).not.toHaveBeenCalled();
		});

		it("returns null and does not setSessionName when auth lookup throws", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({
				branch: [userMsg("hi")],
				getApiKeyAndHeaders: vi.fn(async () => {
					throw new Error("auth backend down");
				}),
			});

			await pi.fire("session_start", ctx);
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();
			expect(completeMock).not.toHaveBeenCalled();
			expect(pi.setSessionName).not.toHaveBeenCalled();
		});

		it("falls back to getApiKey when getApiKeyAndHeaders is unavailable", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("fallback auth title");
			const getApiKey = vi.fn(async () => "fallback-key");
			const ctx = createMockCtx({
				branch: [userMsg("hi")],
				getApiKeyAndHeaders: null,
				getApiKey,
			});

			await pi.fire("session_start", ctx);
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();

			expect(getApiKey).toHaveBeenCalledTimes(1);
			expect(completeMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), { apiKey: "fallback-key" });
			expect(pi.setSessionName).toHaveBeenCalledWith(expect.stringMatching(/^.+ fallback auth title$/));
		});

		it("gives up cleanly when getApiKey fallback returns no key", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const getApiKey = vi.fn(async () => undefined);
			const ctx = createMockCtx({
				branch: [userMsg("hi")],
				getApiKeyAndHeaders: null,
				getApiKey,
			});

			await pi.fire("session_start", ctx);
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();

			expect(getApiKey).toHaveBeenCalledTimes(1);
			expect(completeMock).not.toHaveBeenCalled();
			expect(pi.setSessionName).not.toHaveBeenCalled();
		});

		it("gives up cleanly when the model registry exposes no auth method", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({
				branch: [userMsg("hi")],
				getApiKeyAndHeaders: null,
			});

			await pi.fire("session_start", ctx);
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();

			expect(completeMock).not.toHaveBeenCalled();
			expect(pi.setSessionName).not.toHaveBeenCalled();
		});

		it("handles auth.ok=true with a missing apiKey by giving up cleanly", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({
				branch: [userMsg("hi")],
				getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, headers: {} })),
			});

			await pi.fire("session_start", ctx);
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();
			expect(completeMock).not.toHaveBeenCalled();
		});

		it("swallows complete() failures", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			completeMock.mockRejectedValueOnce(new Error("api down"));
			const ctx = createMockCtx({ branch: [userMsg("hi")] });

			await pi.fire("session_start", ctx);
			await expect(pi.fire("agent_end", ctx)).resolves.toBeUndefined();
			await flushMicrotasks();
			expect(pi.setSessionName).not.toHaveBeenCalled();
		});

		it("ignores empty/cleaned-to-null Haiku responses", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("###  "); // cleanGeneratedName returns null
			const ctx = createMockCtx({ branch: [userMsg("hi")] });

			await pi.fire("session_start", ctx);
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();
			expect(pi.setSessionName).not.toHaveBeenCalled();
		});

		it("aborts the rename if the session was renamed externally while Haiku was running", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [userMsg("hi")] });
			mockHaikuResponse("auto generated");

			// session_start (restoreState) and agent_end (pre-Haiku check) both call
			// getSessionName — return empty so the auto-namer fires. Then the .then()
			// callback after Haiku resolves sees an externally-set name and bails.
			await pi.fire("session_start", ctx);
			pi.getSessionName.mockReturnValueOnce(""); // pre-Haiku check
			pi.getSessionName.mockReturnValueOnce("user override"); // post-Haiku check
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();

			expect(completeMock).toHaveBeenCalledTimes(1);
			expect(pi.setSessionName).not.toHaveBeenCalled();
			expect(ctx.ui.setTitle).toHaveBeenLastCalledWith("π root //areas/core/myapp — 🔮 user override");
			expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("session-banner", expect.any(Function));
		});

		it("backs off when the pre-Haiku check sees an external rename", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [userMsg("hi")] });

			await pi.fire("session_start", ctx);
			// Before Haiku is called, getSessionName already shows an external rename.
			pi.getSessionName.mockReturnValue("user override");
			await pi.fire("agent_end", ctx);
			await flushMicrotasks();
			expect(completeMock).not.toHaveBeenCalled();
			expect(pi.setSessionName).not.toHaveBeenCalled();
			expect(ctx.ui.setTitle).toHaveBeenLastCalledWith("π root //areas/core/myapp — 🔮 user override");
			expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("session-banner", expect.any(Function));
		});
	});

  describe("herdr tab rename", () => {
    it("renames the current herdr tab when a session name is applied", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      const pi = createMockPi();
      sessionBanner(pi as any);
      const ctx = createMockCtx();
      await pi.fire("session_start", ctx);
      await pi.runCommand("title", "fix checkout tax bug", ctx);
      await flushMicrotasks();

      const calls = herdrTabRenameCalls();
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[1]).toEqual(["tab", "rename", "w3:t1", "📭 Open"]);
      expect(calls[1]?.[1]).toEqual(["tab", "rename", "w3:t1", expect.stringMatching(/ fix checkout tax bug$/)]);
    });

    it("renames the current herdr tab when restoring an existing session name", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      const pi = createMockPi();
      pi.getSessionName.mockReturnValue("\u{1F52E} restored session");
      sessionBanner(pi as any);
      const ctx = createMockCtx();
      await pi.fire("session_start", ctx);
      await flushMicrotasks();

      expect(herdrTabRenameCalls()).toHaveLength(1);
      expect(execFileMock).toHaveBeenCalledWith(
        "herdr",
        ["tab", "rename", "w3:t1", "\u{1F52E} restored session"],
        expect.any(Function),
      );
    });

    it("persists Herdr ownership after a successful write", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      mockHerdrCliLabel("1");
      const pi = createMockPi();
      pi.getSessionName.mockReturnValue("🔮 restored session");
      sessionBanner(pi as any);
      const ctx = createMockCtx();

      await pi.fire("session_start", ctx);
      await flushMicrotasks();

      expect(fs.promises.mkdir).toHaveBeenCalledWith(
        expect.stringContaining(".pi/agent/config/session-banner"),
        { recursive: true },
      );
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(".pi/agent/config/session-banner/herdr-titles.json"),
        `${JSON.stringify({ "w3:t1": "🔮 restored session" }, null, 2)}\n`,
        { mode: 0o600 },
      );
    });

    it("does not claim ownership when writing the open placeholder fails", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      execFileMock.mockImplementation(((command: string, args?: readonly string[], callback?: ExecFileCallback) => {
        if (command === "herdr" && args?.[0] === "tab" && args[1] === "rename") {
          callback?.(new Error("rename failed"), "", "");
        } else {
          callback?.(null, "", "");
        }
        return {} as ReturnType<typeof execFile>;
      }) as typeof execFile);
      const pi = createMockPi();
      sessionBanner(pi as any);

      await pi.fire("session_start", createMockCtx());
      await flushMicrotasks();

      expect(herdrTabRenameCalls()).toHaveLength(1);
      expect(fs.promises.writeFile).not.toHaveBeenCalled();
    });

    it("serializes Herdr ownership persistence with queued successful renames", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      mockHerdrCliLabel("1");
      const writes: Array<{ payload: string; resolve: () => void }> = [];
      vi.mocked(fs.promises.writeFile).mockImplementation((async (_path, data) => {
        await new Promise<void>((resolve) => writes.push({ payload: String(data), resolve }));
      }) as typeof fs.promises.writeFile);
      const pi = createMockPi();
      sessionBanner(pi as any);
      const ctx = createMockCtx();

      await pi.runCommand("title", "first persistence title", ctx);
      await pi.runCommand("title", "second persistence title", ctx);
      await flushMicrotasks();

      expect(writes).toHaveLength(1);
      expect(writes[0]?.payload).toContain("first persistence title");
      expect(herdrTabRenameCalls()).toHaveLength(1);

      writes[0]!.resolve();
      await flushMicrotasks();

      expect(writes).toHaveLength(2);
      expect(writes[1]?.payload).toContain("second persistence title");
      expect(herdrTabRenameCalls()).toHaveLength(2);

      writes[1]!.resolve();
      await flushMicrotasks();

      const finalPayload = JSON.parse(writes.at(-1)?.payload ?? "{}") as Record<string, string>;
      expect(finalPayload["w3:t1"]).toContain("second persistence title");
    });

    it("prunes persisted Herdr ownership to recent tabs", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      const oldEntries = Object.fromEntries(
        Array.from({ length: 55 }, (_, index) => [`old:${index}`, `title ${index}`]),
      );
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(oldEntries));
      mockHerdrCliLabel("1");
      const pi = createMockPi();
      pi.getSessionName.mockReturnValue("🔮 newest session");
      sessionBanner(pi as any);
      const ctx = createMockCtx();

      await pi.fire("session_start", ctx);
      await flushMicrotasks();

      const payload = JSON.parse(String(vi.mocked(fs.promises.writeFile).mock.calls.at(-1)?.[1])) as Record<string, string>;
      expect(Object.keys(payload)).toHaveLength(50);
      expect(payload["old:0"]).toBeUndefined();
      expect(payload["old:54"]).toBe("title 54");
      expect(payload["w3:t1"]).toBe("🔮 newest session");
    });

    it("ignores Herdr ownership persistence failures after a successful tab write", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      vi.mocked(fs.promises.mkdir).mockRejectedValue(new Error("mkdir failed"));
      mockHerdrCliLabel("1");
      const pi = createMockPi();
      pi.getSessionName.mockReturnValue("🔮 restored session");
      sessionBanner(pi as any);
      const ctx = createMockCtx();

      await pi.fire("session_start", ctx);
      await flushMicrotasks();

      expect(herdrTabRenameCalls()).toHaveLength(1);
      expect(fs.promises.writeFile).not.toHaveBeenCalled();
    });

    it("continues the Herdr rename queue when persistence write fails", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      vi.mocked(fs.promises.writeFile)
        .mockRejectedValueOnce(new Error("write failed"))
        .mockResolvedValue(undefined);
      mockHerdrCliLabel("1");
      const pi = createMockPi();
      sessionBanner(pi as any);
      const ctx = createMockCtx();

      await pi.runCommand("title", "first persistence failure", ctx);
      await pi.runCommand("title", "second after failure", ctx);
      await flushMicrotasks(100);

      expect(herdrTabRenameCalls()).toHaveLength(2);
      expect(fs.promises.writeFile).toHaveBeenCalledTimes(2);
      const persistedPayloads = vi.mocked(fs.promises.writeFile).mock.calls.map((call) => String(call[1]));
      expect(persistedPayloads[0]).toContain("first persistence failure");
      expect(persistedPayloads[1]).toContain("second after failure");
    });

    it("treats persisted ownership as owned on a fresh extension instance", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ "w3:t1": "🔮 previous session" }));
      const herdr = mockHerdrCliLabel("🔮 previous session");
      const pi = createMockPi();
      sessionBanner(pi as any);
      const ctx = createMockCtx();

      await pi.fire("session_start", ctx);
      await flushMicrotasks();

      expect(herdrTabRenameCalls()).toHaveLength(1);
      expect(herdrTabRenameCalls()[0]?.[1]).toEqual(["tab", "rename", "w3:t1", "📭 Open"]);
      expect(pi.setSessionName).not.toHaveBeenCalled();
      expect(herdr.getLabel()).toBe("📭 Open");
    });

    it("replaces a stale non-numeric Herdr label for a new session", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      const herdr = mockHerdrCliLabel("🔮 stale previous run");
      const pi = createMockPi();
      sessionBanner(pi as any);
      const ctx = createMockCtx();

      await pi.fire("session_start", ctx);
      await flushMicrotasks();
      expect(herdr.getLabel()).toBe("📭 Open");

      await pi.runCommand("title", "new session title", ctx);
      await flushMicrotasks();

      expect(herdrTabRenameCalls()).toHaveLength(2);
      expect(pi.setSessionName).toHaveBeenCalledWith(expect.stringMatching(/ new session title$/));
      expect(pi.setSessionName).toHaveBeenCalledTimes(1);
      expect(herdr.getLabel()).toMatch(/ new session title$/);
    });

    it("preserves an unowned manual Herdr label for an existing unnamed conversation", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      const herdr = mockHerdrCliLabel("Manual tab name");
      const pi = createMockPi();
      sessionBanner(pi as any);
      const ctx = createMockCtx({ branch: [userMsg("existing conversation")] });

      await pi.fire("session_start", ctx);
      await flushMicrotasks();

      expect(herdrTabRenameCalls()).toHaveLength(0);
      expect(pi.setSessionName).not.toHaveBeenCalled();
      expect(herdr.getLabel()).toBe("Manual tab name");
    });

    it("keeps prior ownership after a failed Herdr write and still writes owned labels later", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      let currentLabel = "1";
      let failNextRename = false;
      execFileMock.mockImplementation(((command: string, args?: readonly string[], callback?: ExecFileCallback) => {
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
        return {} as ReturnType<typeof execFile>;
      }) as typeof execFile);
      const pi = createMockPi();
      pi.getSessionName.mockReturnValue("🔮 owned title");
      sessionBanner(pi as any);
      const ctx = createMockCtx();

      await pi.fire("session_start", ctx);
      await flushMicrotasks();
      expect(currentLabel).toBe("🔮 owned title");

      failNextRename = true;
      await pi.runCommand("title", "failed write", ctx);
      await flushMicrotasks();
      expect(currentLabel).toBe("🔮 owned title");
      expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);

      await pi.runCommand("title", "successful after failure", ctx);
      await flushMicrotasks();

      expect(herdrTabRenameCalls()).toHaveLength(3);
      expect(currentLabel).toMatch(/ successful after failure$/);
      expect(pi.setSessionName).toHaveBeenLastCalledWith(expect.stringMatching(/ successful after failure$/));
      const persistedPayloads = vi.mocked(fs.promises.writeFile).mock.calls.map((call) => String(call[1]));
      expect(persistedPayloads.join("\n")).not.toContain("failed write");
      expect(persistedPayloads.at(-1)).toContain("successful after failure");
    });

    it("adopts a manual Herdr rename on a fresh instance when persisted ownership diverges", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ "w3:t1": "🔮 previous title" }));
      const herdr = mockHerdrCliLabel("Manual GUI Name");
      const pi = createMockPi();
      sessionBanner(pi as any);
      const ctx = createMockCtx();

      await pi.runCommand("title", "new title", ctx);
      await flushMicrotasks();

      expect(herdrTabRenameCalls()).toHaveLength(0);
      expect(pi.setSessionName).toHaveBeenCalledWith(expect.stringMatching(/ new title$/));
      expect(pi.setSessionName).toHaveBeenLastCalledWith("Manual GUI Name");
      expect(pi.getSessionName()).toBe("Manual GUI Name");
      expect(herdr.getLabel()).toBe("Manual GUI Name");
    });

    it("renames the current herdr tab when adopting an external session name", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      const pi = createMockPi();
      sessionBanner(pi as any);
      const ctx = createMockCtx({ branch: [userMsg("hi")] });

      await pi.fire("session_start", ctx);
      pi.getSessionName.mockReturnValue("external rename");
      await pi.fire("agent_end", ctx);
      await flushMicrotasks();

      const calls = herdrTabRenameCalls();
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[1]).toEqual(["tab", "rename", "w3:t1", ""]);
      expect(calls[1]?.[1]).toEqual(["tab", "rename", "w3:t1", "external rename"]);
    });

    it("renames after session_switch when the Herdr tab still shows the previous auto title", async () => {
      vi.useFakeTimers();
      try {
        process.env.HERDR_ENV = "1";
        process.env.HERDR_TAB_ID = "w3:t1";
        const herdr = mockHerdrCliLabel("1");
        const pi = createMockPi();
        pi.getSessionName.mockReturnValue("🔮 previous session");
        sessionBanner(pi as any);
        const ctx = createMockCtx();

        await pi.fire("session_start", ctx);
        await flushMicrotasks();
        expect(herdr.getLabel()).toBe("🔮 previous session");

        pi.getSessionName.mockReturnValue("⚡ switched session");
        await pi.fire("session_switch", ctx);
        await vi.advanceTimersByTimeAsync(50);
        await flushMicrotasks();

        let calls = herdrTabRenameCalls();
        expect(calls).toHaveLength(2);
        expect(calls[1]?.[1]).toEqual(["tab", "rename", "w3:t1", "⚡ switched session"]);
        expect(herdr.getLabel()).toBe("⚡ switched session");

        await pi.runCommand("title", "manual after switch", ctx);
        await flushMicrotasks();
        calls = herdrTabRenameCalls();
        expect(calls).toHaveLength(3);
        expect(calls[2]?.[1]).toEqual(["tab", "rename", "w3:t1", expect.stringMatching(/ manual after switch$/)]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("renames after session_fork when the Herdr tab still shows the previous auto title", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      const herdr = mockHerdrCliLabel("1");
      const pi = createMockPi();
      pi.getSessionName.mockReturnValue("🔮 previous session");
      sessionBanner(pi as any);
      const firstCtx = createMockCtx({ cwd: "/Users/me/world/trees/root/src/areas/core/myapp" });
      const forkCtx = createMockCtx({ cwd: "/Users/me/world/trees/root/src/areas/apps/flow" });

      await pi.fire("session_start", firstCtx);
      await flushMicrotasks();
      expect(herdr.getLabel()).toBe("🔮 previous session");

      pi.getSessionName.mockReturnValue("⚡ forked session");
      await pi.fire("session_fork", forkCtx);
      await flushMicrotasks();

      let calls = herdrTabRenameCalls();
      expect(calls).toHaveLength(2);
      expect(calls[1]?.[1]).toEqual(["tab", "rename", "w3:t1", "⚡ forked session"]);
      expect(herdr.getLabel()).toBe("⚡ forked session");

      await pi.runCommand("title", "manual after fork", forkCtx);
      await flushMicrotasks();
      calls = herdrTabRenameCalls();
      expect(calls).toHaveLength(3);
      expect(calls[2]?.[1]).toEqual(["tab", "rename", "w3:t1", expect.stringMatching(/ manual after fork$/)]);
    });

    it("backs off permanently when the current Herdr label looks GUI-renamed", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      const herdr = mockHerdrCliLabel("1");
      const pi = createMockPi();
      sessionBanner(pi as any);
      const ctx = createMockCtx();

      await pi.fire("session_start", ctx);
      await flushMicrotasks();
      expect(herdrTabRenameCalls()).toHaveLength(1);
      expect(herdr.getLabel()).toBe("📭 Open");

      herdr.setLabel("🔄 Tab Rename Behavior Issue");
      await pi.runCommand("title", "fix checkout tax bug", ctx);
      await pi.runCommand("title", "queued title after backoff", ctx);
      await flushMicrotasks();
      expect(herdrTabRenameCalls()).toHaveLength(1);
      expect(herdr.getLabel()).toBe("🔄 Tab Rename Behavior Issue");

      await pi.runCommand("title", "another generated title", ctx);
      await flushMicrotasks();
      expect(herdrTabRenameCalls()).toHaveLength(1);
      expect(herdr.getLabel()).toBe("🔄 Tab Rename Behavior Issue");
    });

    it("adopts a manual Herdr GUI rename as the Pi session name without writing back", async () => {
      vi.useFakeTimers();
      try {
        process.env.HERDR_ENV = "1";
        process.env.HERDR_TAB_ID = "w3:t1";
        const herdr = mockHerdrCliLabel("1");
        const pi = createMockPi();
        sessionBanner(pi as any);
        const ctx = createMockCtx({ branch: [userMsg("specific task")] });

        await pi.fire("session_start", ctx);
        await flushMicrotasks();
        expect(herdrTabRenameCalls()).toHaveLength(1);

        herdr.setLabel("🔄 Tab Rename Behavior Issue");
        pi.setSessionName.mockClear();
        ctx.ui.setTitle.mockClear();
        await pi.runCommand("title", "fix checkout tax bug", ctx);
        await flushMicrotasks();

        expect(pi.setSessionName).toHaveBeenCalledWith(expect.stringMatching(/ fix checkout tax bug$/));
        expect(pi.setSessionName).toHaveBeenLastCalledWith("🔄 Tab Rename Behavior Issue");
        expect(pi.getSessionName()).toBe("🔄 Tab Rename Behavior Issue");
        expect(herdrTabRenameCalls()).toHaveLength(1);
        expect(herdr.getLabel()).toBe("🔄 Tab Rename Behavior Issue");
        expect(ctx.ui.setTitle).toHaveBeenLastCalledWith(
          "π root //areas/core/myapp — 🔄 Tab Rename Behavior Issue",
        );
        expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("session-banner", expect.any(Function));
        expect(paneRegistry().banner()?.render(ctx as any)).toEqual({
          slot: "banner",
          emoji: "🔄",
          label: "Tab Rename Behavior Issue",
          color: expect.any(String),
        });

        completeMock.mockClear();
        await vi.advanceTimersByTimeAsync(1000);
        ctx.ui.setTitle.mockClear();
        await pi.fire("agent_end", ctx);
        expect(completeMock).not.toHaveBeenCalled();
        ctx.ui.setTitle.mockClear();
        await vi.advanceTimersByTimeAsync(1000);
        expect(ctx.ui.setTitle).not.toHaveBeenCalled();
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });

    it("drops manual Herdr adoption when the rename epoch changes mid-flight", async () => {
      vi.useFakeTimers();
      try {
        process.env.HERDR_ENV = "1";
        process.env.HERDR_TAB_ID = "w3:t1";
        let getCallback: ExecFileCallback | undefined;
        execFileMock.mockImplementation(((command: string, args?: readonly string[], callback?: ExecFileCallback) => {
          if (command === "herdr" && Array.isArray(args) && args[0] === "tab" && args[1] === "get") {
            getCallback = callback;
          } else {
            callback?.(null, "", "");
          }
          return {} as ReturnType<typeof execFile>;
        }) as typeof execFile);
        const pi = createMockPi();
        sessionBanner(pi as any);
        const ctx = createMockCtx();

        await pi.runCommand("title", "fix checkout tax bug", ctx);
        await flushMicrotasks();
        expect(getCallback).toBeDefined();

        pi.setSessionName.mockClear();
        pi.setSessionName.mockImplementation(() => {
          throw new Error("stale session handle");
        });
        await pi.fire("session_switch", ctx);
        getCallback?.(null, herdrTabGetOutput("Manual GUI Name"), "");
        await flushMicrotasks();

        expect(pi.setSessionName).not.toHaveBeenCalled();
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });

    it("swallows a stale session handle while adopting a manual Herdr rename", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ "w3:t1": "🔮 previous title" }));
      mockHerdrCliLabel("Manual GUI Name");
      const pi = createMockPi();
      const originalSetSessionName = pi.setSessionName.getMockImplementation();
      pi.setSessionName
        .mockImplementationOnce(originalSetSessionName!)
        .mockImplementationOnce(() => {
          throw new Error("stale session handle");
        });
      sessionBanner(pi as any);
      const ctx = createMockCtx();

      await pi.runCommand("title", "new generated title", ctx);
      await flushMicrotasks();

      expect(pi.setSessionName).toHaveBeenCalledTimes(2);
      expect(herdrTabRenameCalls()).toHaveLength(0);
    });

    it("skips manual Herdr adoption when no UI context was captured", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ "w3:t1": "🔮 previous title" }));
      mockHerdrCliLabel("Manual GUI Name");
      const pi = createMockPi();
      sessionBanner(pi as any);
      const ctx = createMockCtx({ hasUI: false });

      await pi.runCommand("title", "headless title", ctx);
      pi.setSessionName.mockClear();
      await flushMicrotasks();

      expect(pi.setSessionName).not.toHaveBeenCalled();
      expect(herdrTabRenameCalls()).toHaveLength(0);
    });

    it("fails open and writes when herdr tab get returns an error", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      execFileMock.mockImplementation(((command: string, args?: readonly string[], callback?: ExecFileCallback) => {
        if (command === "herdr" && Array.isArray(args) && args[0] === "tab" && args[1] === "get") {
          callback?.(new Error("herdr unavailable"), "", "");
        } else {
          callback?.(null, "", "");
        }
        return {} as ReturnType<typeof execFile>;
      }) as typeof execFile);
      const pi = createMockPi();
      sessionBanner(pi as any);
      const ctx = createMockCtx({ branch: [userMsg("existing conversation")] });

      await pi.fire("session_start", ctx);
      await flushMicrotasks();

      expect(herdrTabRenameCalls()).toHaveLength(1);
      expect(execFileMock).toHaveBeenCalledWith(
        "herdr",
        ["tab", "rename", "w3:t1", ""],
        expect.any(Function),
      );
    });

    it("fails open and writes when herdr tab get returns a missing label", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      execFileMock.mockImplementation(((command: string, args?: readonly string[], callback?: ExecFileCallback) => {
        if (command === "herdr" && Array.isArray(args) && args[0] === "tab" && args[1] === "get") {
          callback?.(null, herdrTabGetOutput(7), "");
        } else {
          callback?.(null, "", "");
        }
        return {} as ReturnType<typeof execFile>;
      }) as typeof execFile);
      const pi = createMockPi();
      sessionBanner(pi as any);
      const ctx = createMockCtx({ branch: [userMsg("existing conversation")] });

      await pi.fire("session_start", ctx);
      await flushMicrotasks();

      expect(herdrTabRenameCalls()).toHaveLength(1);
    });

    it("drops a queued open rename after a session lifecycle reset", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      const pi = createMockPi();
      sessionBanner(pi as any);
      const firstCtx = createMockCtx({ cwd: "/Users/me/world/trees/root/src/areas/core/myapp" });
      const forkCtx = createMockCtx({ cwd: "/Users/me/world/trees/root/src/areas/apps/flow" });

      const startingSession = pi.fire("session_start", firstCtx);
      const forkingSession = pi.fire("session_fork", forkCtx);
      await Promise.all([startingSession, forkingSession]);
      await flushMicrotasks();

      expect(herdrTabRenameCalls()).toHaveLength(1);
      expect(herdrTabRenameCalls()[0]?.[1]).toEqual(["tab", "rename", "w3:t1", "📭 Open"]);
    });

    it("does not rename herdr tabs when not running inside herdr", async () => {
      const pi = createMockPi();
      sessionBanner(pi as any);
      const ctx = createMockCtx();
      await pi.fire("session_start", ctx);
      await pi.runCommand("title", "manual name", ctx);
      await flushMicrotasks();

      expect(herdrTabRenameCalls()).toHaveLength(0);
    });

    it("does not rename the parent tab from a headless (subagent) session_start", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      const pi = createMockPi();
      pi.getSessionName.mockReturnValue("general-purpose#5fb88e30");
      sessionBanner(pi as any);

      await pi.fire("session_start", createMockCtx({ hasUI: false }));
      await flushMicrotasks();

      expect(herdrTabRenameCalls()).toHaveLength(0);
    });

    it("does not rename the parent tab from a headless agent_end", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      const pi = createMockPi();
      pi.getSessionName.mockReturnValue("general-purpose#5fb88e30");
      sessionBanner(pi as any);
      const ctx = createMockCtx({ hasUI: false, branch: [userMsg("do the subtask")] });

      await pi.fire("agent_end", ctx);
      await flushMicrotasks();

      expect(herdrTabRenameCalls()).toHaveLength(0);
    });

    it("marks the current herdr tab open when starting an unnamed session", async () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_TAB_ID = "w3:t1";
      const pi = createMockPi();
      sessionBanner(pi as any);
      const ctx = createMockCtx();
      await pi.fire("session_start", ctx);
      await flushMicrotasks();

      expect(herdrTabRenameCalls()).toHaveLength(1);
      expect(execFileMock).toHaveBeenCalledWith(
        "herdr",
        ["tab", "rename", "w3:t1", "📭 Open"],
        expect.any(Function),
      );
    });
  });

  describe("cmux workspace rename", () => {
    it("does not invoke cmux when CMUX_WORKSPACE_ID is unset", async () => {
      delete process.env.CMUX_WORKSPACE_ID;
      vi.resetModules();
      const { default: freshSessionBanner } = await import("./index.js");
      const pi = createMockPi();
      freshSessionBanner(pi as any);
      const ctx = createMockCtx();
      await pi.fire("session_start", ctx);
      await pi.runCommand("title", "manual name", ctx);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("checks the caller workspace tree for a single cmux tab before renaming", async () => {
      process.env.CMUX_WORKSPACE_ID = "workspace:7";
      vi.resetModules();
      const { default: freshSessionBanner } = await import("./index.js");
      mockCmuxTree([{ surfaces: [{ ref: "surface:1" }] }]);
      const pi = createMockPi();
      freshSessionBanner(pi as any);
      const ctx = createMockCtx();
      await pi.fire("session_start", ctx);
      await pi.runCommand("title", "fix checkout tax bug", ctx);
      mockCmuxTree([{ surface_refs: ["surface:1"] }]);
      await pi.runCommand("title", "fix checkout tax bug again", ctx);
      mockCmuxTree([{ surface_count: 1 }]);
      await pi.runCommand("title", "fix checkout tax bug a third time", ctx);
      mockCmuxTreeOutput(JSON.stringify({ windows: [{ workspaces: [{ panes: [{ surface_count: 1 }] }] }] }));
      await pi.runCommand("title", "fix checkout tax bug a fourth time", ctx);

      expect(execFileMock).toHaveBeenCalledWith(
        "cmux",
        ["--json", "tree", "--workspace", "workspace:7"],
        expect.any(Function),
      );
      expect(cmuxRenameCalls()).toHaveLength(4);
      expect(execFileMock).toHaveBeenCalledWith(
        "cmux",
        ["rename-workspace", "--workspace", "workspace:7", "--", expect.stringMatching(/ fix checkout tax bug$/)],
        expect.any(Function),
      );
    });

    it("does not rename the cmux workspace when an existing session name is only rendered", async () => {
      process.env.CMUX_WORKSPACE_ID = "workspace:7";
      vi.resetModules();
      const { default: freshSessionBanner } = await import("./index.js");
      const pi = createMockPi();
      pi.getSessionName.mockReturnValue("\u{1F52E} restored session");
      freshSessionBanner(pi as any);
      const ctx = createMockCtx();
      await pi.fire("session_start", ctx);

      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("does not rename the cmux workspace when multiple tabs are present", async () => {
      process.env.CMUX_WORKSPACE_ID = "workspace:7";
      vi.resetModules();
      const { default: freshSessionBanner } = await import("./index.js");
      mockCmuxTree([{ surfaces: [{ ref: "surface:1" }, { ref: "surface:2" }] }]);
      const pi = createMockPi();
      freshSessionBanner(pi as any);
      const ctx = createMockCtx();
      await pi.fire("session_start", ctx);
      await pi.runCommand("title", "fix checkout tax bug", ctx);
      mockCmuxTree([{ surface_refs: ["surface:1"] }, { surface_count: 1 }]);
      await pi.runCommand("title", "fix checkout tax bug again", ctx);

      expect(execFileMock).toHaveBeenCalledWith(
        "cmux",
        ["--json", "tree", "--workspace", "workspace:7"],
        expect.any(Function),
      );
      expect(cmuxRenameCalls()).toHaveLength(0);
    });

    it("ignores docked panes when counting cmux tabs", async () => {
      process.env.CMUX_WORKSPACE_ID = "workspace:7";
      vi.resetModules();
      const { default: freshSessionBanner } = await import("./index.js");
      const pi = createMockPi();
      freshSessionBanner(pi as any);
      const ctx = createMockCtx();
      await pi.fire("session_start", ctx);

      // One real tab + a global dock terminal (cmux reports dock panes inside
      // every workspace) → still a single-tab workspace, rename proceeds.
      mockCmuxTree([
        { surfaces: [{ ref: "surface:15" }] },
        { dock_scope: "global", surfaces: [{ ref: "surface:6" }] },
      ]);
      await pi.runCommand("title", "fix checkout tax bug", ctx);
      expect(cmuxRenameCalls()).toHaveLength(1);

      // Two real tabs alongside a dock pane → still skipped.
      mockCmuxTree([
        { dock_scope: "global", surfaces: [{ ref: "surface:6" }] },
        { surfaces: [{ ref: "surface:1" }] },
        { surfaces: [{ ref: "surface:2" }] },
      ]);
      await pi.runCommand("title", "fix checkout tax bug again", ctx);
      expect(cmuxRenameCalls()).toHaveLength(1);
    });

    it("renames the cmux workspace when tree output does not prove multiple tabs", async () => {
      process.env.CMUX_WORKSPACE_ID = "workspace:7";
      vi.resetModules();
      const { default: freshSessionBanner } = await import("./index.js");
      const pi = createMockPi();
      freshSessionBanner(pi as any);
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

      expect(cmuxRenameCalls()).toHaveLength(4);
    });

    it("does not rename the cmux workspace when cmux tree fails", async () => {
      process.env.CMUX_WORKSPACE_ID = "workspace:7";
      vi.resetModules();
      const { default: freshSessionBanner } = await import("./index.js");
      mockCmuxTreeOutput("", new Error("cmux unavailable"));
      const pi = createMockPi();
      freshSessionBanner(pi as any);
      const ctx = createMockCtx();
      await pi.fire("session_start", ctx);
      await pi.runCommand("title", "fix checkout tax bug", ctx);

      expect(cmuxRenameCalls()).toHaveLength(0);
    });

    it("does not call cmux during render when there is no label yet", async () => {
      process.env.CMUX_WORKSPACE_ID = "workspace:7";
      vi.resetModules();
      const { default: freshSessionBanner } = await import("./index.js");
      const pi = createMockPi();
      freshSessionBanner(pi as any);
      const ctx = createMockCtx();
      await pi.fire("session_start", ctx);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

	describe("/title command", () => {
		it("sets the name directly when given args", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx();
			await pi.fire("session_start", ctx);
			await pi.runCommand("title", "  fix checkout tax bug  ", ctx);

			expect(pi.setSessionName).toHaveBeenCalledWith(expect.stringMatching(/^.+ fix checkout tax bug$/));
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("fix checkout tax bug"), "info");
		});

		it("does not let background auto-naming overwrite a manual /title", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
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

			expect(completeMock).toHaveBeenCalledTimes(1);
			expect(pi.setSessionName).toHaveBeenLastCalledWith(expect.stringMatching(/^.+ manual title$/));
		});

		it("regenerates via Haiku when called without args", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("regenerated title");
			const ctx = createMockCtx({ branch: [userMsg("a real conversation")] });
			await pi.fire("session_start", ctx);

			await pi.runCommand("title", "", ctx);
			expect(completeMock).toHaveBeenCalledTimes(1);
			expect(pi.setSessionName).toHaveBeenCalledWith(expect.stringMatching(/^.+ regenerated title$/));
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("regenerated title"), "info");
		});

		it("keeps auto-naming active after a successful no-arg regeneration", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("regenerated title");
			const ctx = createMockCtx({ branch: [userMsg("a real conversation")] });
			await pi.fire("session_start", ctx);

			await pi.runCommand("title", "", ctx);
			mockHaikuResponse("automatic refinement");
			await pi.fire("before_agent_start", ctx, { prompt: "add one more detail" });
			await flushMicrotasks();

			expect(completeMock).toHaveBeenCalledTimes(2);
			expect(pi.setSessionName).toHaveBeenLastCalledWith(
				expect.stringMatching(/^.+ automatic refinement$/),
			);
		});

		it("warns and does nothing when there is no conversation to summarize", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [] });
			await pi.fire("session_start", ctx);
			await pi.runCommand("title", "", ctx);
			expect(completeMock).not.toHaveBeenCalled();
			expect(ctx.ui.notify).toHaveBeenCalledWith("No conversation to name yet", "warning");
		});

		it("warns when Haiku regeneration fails", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("###"); // cleans to null
			const ctx = createMockCtx({ branch: [userMsg("hi")] });
			await pi.fire("session_start", ctx);
			await pi.runCommand("title", "", ctx);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to generate name"), "warning");
		});

		it("restores auto-naming when no-arg regeneration hits a registry error", async () => {
			const pi = createMockPi();
			const findModel = vi
				.fn()
				.mockImplementationOnce(() => {
					throw new Error("model registry exploded");
				})
				.mockImplementation(() => ({ id: "claude-haiku-4-5", provider: "anthropic" }));
			sessionBanner(pi as any);
			const ctx = createMockCtx({ branch: [userMsg("hi")], findModel });
			await pi.fire("session_start", ctx);

			await pi.runCommand("title", "", ctx);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to generate name"), "warning");

			mockHaikuResponse("recovered auto title");
			await pi.fire("before_agent_start", ctx, { prompt: "specific follow-up" });
			await flushMicrotasks();

			expect(completeMock).toHaveBeenCalledTimes(1);
			expect(pi.setSessionName).toHaveBeenCalledWith(expect.stringMatching(/^.+ recovered auto title$/));
		});

		it("respects PI_SESSION_BANNER_PROVIDER / PI_SESSION_BANNER_MODEL env vars in the failure message", async () => {
			process.env.PI_SESSION_BANNER_PROVIDER = "openai";
			process.env.PI_SESSION_BANNER_MODEL = "gpt-test";
			// Re-import the module so the env vars are picked up.
			vi.resetModules();
			const { default: freshSessionBanner } = await import("./index.js");
			const pi = createMockPi();
			freshSessionBanner(pi as any);
			mockHaikuResponse("###"); // cleans to null
			const ctx = createMockCtx({ branch: [userMsg("hi")] });
			await pi.fire("session_start", ctx);
			await pi.runCommand("title", "", ctx);
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("provider=openai, model=gpt-test"),
				"warning",
			);
		});

		it("ignores an args-only string that is whitespace and falls through to regenerate", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("from whitespace");
			const ctx = createMockCtx({ branch: [userMsg("hi")] });
			await pi.fire("session_start", ctx);
			await pi.runCommand("title", "   ", ctx);
			expect(completeMock).toHaveBeenCalledTimes(1);
		});

		it("treats a missing args string the same as empty args", async () => {
			const pi = createMockPi();
			sessionBanner(pi as any);
			mockHaikuResponse("from undefined");
			const ctx = createMockCtx({ branch: [userMsg("hi")] });
			await pi.fire("session_start", ctx);
			await pi.runCommand("title", undefined as unknown as string, ctx);
			expect(completeMock).toHaveBeenCalledTimes(1);
		});

	});

});
