/**
 * The Pi adapter: what scan-guard blocks, what it only says something about, and
 * what it refuses to become.
 *
 * The classifier is tested in `classify.test.ts`; this file drives the extension
 * through a fake Pi, because the interesting claims live here:
 *
 *  - the default mode runs the command and says nothing to the agent;
 *  - a blocked command reports `block: true` and never `terminate`;
 *  - `PI_SCAN_GUARD=off` means the handler does nothing at all;
 *  - nothing this file does can throw, because a throwing `tool_call` handler
 *    blocks every bash call in the session as a fail-safe.
 *
 * The log always goes to a temp directory — an extension that writes to
 * `~/.pi/scan-guard` during tests would be writing to the developer's machine.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import coAuthoredByAi from "../co-authored-by-ai/implementation.ts";
import factory, {
	appendLog,
	defaultScopedRoots,
	logIsCapped,
	parseMode,
	probeFd,
	readLogEvents,
	setExecFileForTesting,
	setFdForTesting,
	setLogDirForTesting,
	type LogEvent,
} from "./implementation.ts";

// --- fake Pi -----------------------------------------------------------------

type Handler = (event: Record<string, unknown>, ctx: FakeCtx) => Promise<unknown> | unknown;

interface FakeCtx {
	cwd: string;
	model: unknown;
	ui: { notify(message: string, type?: string): void };
}

interface Options {
	cwd?: string;
	/** Make `ctx.ui.notify` throw, the way a dying TUI might. */
	notifyThrows?: boolean;
	/** What `command -v fd` answers. */
	fd?: boolean;
}

function makePi(options: Options = {}) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => unknown }>();
	const notes: { message: string; type?: string }[] = [];
	const register = (pi: Record<string, unknown>) => {
		pi.on = (name: string, handler: Handler) => handlers.set(name, handler);
		pi.registerCommand = (name: string, command: { description?: string; handler: (args: string, ctx: unknown) => unknown }) =>
			commands.set(name, command);
	};
	const ctx: FakeCtx = {
		cwd: options.cwd ?? "/Users/tester/Projects/app",
		model: { name: "Test Model", provider: "test" },
		ui: {
			notify(message: string, type?: string) {
				if (options.notifyThrows) throw new Error("TUI is gone");
				notes.push({ message, type });
			},
		},
	};
	if (options.fd !== undefined) setFdForTesting(options.fd);
	const self: Record<string, unknown> = {};
	register(self);
	return {
		pi: self,
		ctx,
		notes,
		commands,
		/** Send a bash tool_call and return whatever the handler returned. */
		async call(command: unknown, toolName = "bash") {
			const event: Record<string, unknown> = {
				type: "tool_call",
				toolCallId: "call-1",
				toolName,
				input: command === undefined ? {} : { command },
			};
			const result = await handlers.get("tool_call")!(event, ctx as never);
			return { result, command: (event.input as { command?: string }).command };
		},
		async status(args = "") {
			const command = commands.get("scan-guard");
			if (!command) throw new Error("/scan-guard was never registered");
			await command.handler(args, ctx);
			return notes.map((n) => n.message).join("\n");
		},
	};
}

function useTempLog(): string {
	const dir = mkdtempSync(join(tmpdir(), "scan-guard-log-"));
	setLogDirForTesting(dir);
	return dir;
}

const HOME = "/Users/tester";
let previousDir: string | undefined;
let previousLog: string | undefined;
let previousMode: string | undefined;

beforeEach(() => {
	previousDir = process.env.PI_SCAN_GUARD_DIR;
	previousLog = process.env.PI_SCAN_GUARD_LOG;
	previousMode = process.env.PI_SCAN_GUARD;
});

afterEach(() => {
	const restore = (name: string, value: string | undefined) => {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	};
	restore("PI_SCAN_GUARD_DIR", previousDir);
	restore("PI_SCAN_GUARD_LOG", previousLog);
	restore("PI_SCAN_GUARD", previousMode);
	setLogDirForTesting(null);
	setFdForTesting(null);
	setExecFileForTesting(null);
});

// --- mode --------------------------------------------------------------------

describe("PI_SCAN_GUARD", () => {
	it("defaults to notify-only, and only that word turns blocking on", () => {
		assert.equal(parseMode(undefined), "log");
		assert.equal(parseMode(""), "log");
		assert.equal(parseMode("log"), "log");
		assert.equal(parseMode("LOG"), "log");
		assert.equal(parseMode("block"), "block");
		assert.equal(parseMode("off"), "off");
		assert.equal(parseMode("0"), "off");
		// A typo is not permission to start blocking a session's shell.
		assert.equal(parseMode("blockk"), "log");
		assert.equal(parseMode("yesss"), "log");
	});
});

// --- the three modes, on the same command -------------------------------------

describe("a command that walks $HOME", () => {
	const SCAN = `find ~ -name jogoforca-port.md 2>/dev/null | head -3`;

	it("notify-only: the command runs, the human is told, the agent is not", async () => {
		process.env.PI_SCAN_GUARD = "log";
		useTempLog();
		const pi = makePi();
		factory(pi.pi as never);

		const { result, command } = await pi.call(SCAN);
		assert.equal(result, undefined, "notify-only must not block");
		assert.equal(command, SCAN, "notify-only must not edit the command");
		assert.equal(pi.notes.length, 1);
		assert.equal(pi.notes[0].type, "info");
		assert.match(pi.notes[0].message, /scan-guard:/);
	});

	it("block: the agent gets the reason and the command does not run", async () => {
		process.env.PI_SCAN_GUARD = "block";
		useTempLog();
		const pi = makePi();
		factory(pi.pi as never);

		const { result, command } = await pi.call(SCAN);
		assert.equal(command, SCAN, "a refusal must not quietly rewrite what was asked");
		const block = result as { block?: boolean; reason?: string; terminate?: boolean };
		assert.equal(block.block, true);
		assert.match(block.reason ?? "", /find ~/);
		assert.match(block.reason ?? "", /\n  (fd|find) /, "the reason must end with a command to run");
		assert.equal(block.terminate, undefined, "terminate stops the whole batch; this one must continue");
	});

	it("off: no note, no log line, no verdict", async () => {
		process.env.PI_SCAN_GUARD = "off";
		const dir = useTempLog();
		const pi = makePi();
		factory(pi.pi as never);

		const { result } = await pi.call(SCAN);
		assert.equal(result, undefined);
		assert.equal(pi.notes.length, 0);
		assert.equal(readLogEvents(10, dir).length, 0);
	});

	it("records the decision in both notify and block modes, so a week of use is measurable", async () => {
		const dir = useTempLog();
		for (const mode of ["log", "block"]) {
			process.env.PI_SCAN_GUARD = mode;
			const pi = makePi();
			factory(pi.pi as never);
			await pi.call(SCAN);
		}
		const events = readLogEvents(10, dir);
		assert.equal(events.length, 2);
		for (const e of events) {
			assert.equal(e.verdict, "block");
			assert.equal(e.tool, "find");
			assert.ok(e.root.length > 1, "the root is the decision");
			assert.ok(e.suggestion.length > 10);
			// Contents are opt-in: the decision without the words.
			assert.equal(e.command, undefined);
		}
		assert.equal("command" in events[0], false, "the default log keeps the decision, not the words");
	});

	it("logs the command only when the human asked for the words", async () => {
		process.env.PI_SCAN_GUARD = "block";
		process.env.PI_SCAN_GUARD_LOG = "full";
		const dir = useTempLog();
		const pi = makePi();
		factory(pi.pi as never);
		await pi.call(SCAN);
		const [event] = readLogEvents(10, dir) as Array<LogEvent & { command?: string }>;
		assert.match(event.command ?? "", /jogoforca-port/);
	});

	it("warn-tier scans are logged and never blocked, whatever the mode", async () => {
		process.env.PI_SCAN_GUARD = "block";
		const dir = useTempLog();
		const pi = makePi();
		factory(pi.pi as never);
		const { result } = await pi.call(`find ~ -maxdepth 3 -iname '*second-brain*'`);
		assert.equal(result, undefined, "a bounded walk is allowed to run even in block mode");
		assert.equal(readLogEvents(10, dir)[0].verdict, "warn");
	});
});

// --- what it leaves alone -----------------------------------------------------

describe("ordinary commands", () => {
	it("says nothing, logs nothing, returns nothing", async () => {
		process.env.PI_SCAN_GUARD = "block";
		const dir = useTempLog();
		const pi = makePi();
		factory(pi.pi as never);
		for (const cmd of ["ls -la", `cd /Users/tester/Projects/app && find . -name '*.ts' | head`, "git status", "", undefined]) {
			const { result } = await pi.call(cmd);
			assert.equal(result, undefined, String(cmd));
		}
		assert.equal(pi.notes.length, 0);
		assert.equal(readLogEvents(10, dir).length, 0);
	});

	it("is not a hook on other tools", async () => {
		process.env.PI_SCAN_GUARD = "block";
		useTempLog();
		const pi = makePi();
		factory(pi.pi as never);
		const { result } = await pi.call(`find ~ -name x`, "read");
		assert.equal(result, undefined);
		assert.equal(pi.notes.length, 0);
	});
});

// --- fail open -----------------------------------------------------------------

describe("fail open: a throwing tool_call handler is a frozen session", () => {
	const nasty = ["", "\n", `find ~ -name "unterminated`, `echo $(find ~`, "find", ";", "🔍".repeat(20_000), "find ~ " + "-iname x ".repeat(4000)];

	it("never rejects, however broken the command", async () => {
		process.env.PI_SCAN_GUARD = "block";
		useTempLog();
		const pi = makePi();
		factory(pi.pi as never);
		for (const cmd of nasty) {
			await assert.doesNotReject(async () => await pi.call(cmd));
		}
	});

	it("never rejects when the UI itself throws, and still refuses", async () => {
		process.env.PI_SCAN_GUARD = "block";
		useTempLog();
		const pi = makePi({ notifyThrows: true });
		factory(pi.pi as never);
		const { result } = await pi.call(`find ~ -name x`);
		assert.equal((result as { block?: boolean }).block, true, "a broken UI must not turn a refusal into a pass");
	});

	it("treats a failed fd probe as no fd, not as an error", async () => {
		process.env.PI_SCAN_GUARD = "block";
		useTempLog();
		setFdForTesting(null);
		setExecFileForTesting((() => {
			throw new Error("spawn ENOENT");
		}) as never);
		const pi = makePi();
		factory(pi.pi as never);
		const { result } = await pi.call(`find ~ -name note.md`);
		assert.equal((result as { block?: boolean }).block, true);
		assert.match((result as { reason?: string }).reason ?? "", /\n  find /);
	});
});

// --- fd, probed once ----------------------------------------------------------

describe("fd availability", () => {
	it("probes once per process and remembers the answer", async () => {
		let calls = 0;
		setFdForTesting(null);
		setExecFileForTesting(((_cmd: string, _args: readonly string[], _opts: unknown, cb: (e: unknown, o: string, er: string) => void) => {
			calls++;
			cb(null, "/usr/local/bin/fd\n", "");
		}) as never);
		assert.equal(await probeFd(), true);
		assert.equal(await probeFd(), true);
		assert.equal(calls, 1, "one probe per process — a `command -v` per tool call is silly");
	});

	it("a probe that fails says no fd, and the suggestion switches to find", async () => {
		process.env.PI_SCAN_GUARD = "block";
		useTempLog();
		setFdForTesting(false);
		void 0;
		const pi = makePi();
		factory(pi.pi as never);
		const { result } = await pi.call(`find ~ -name note.md`);
		assert.match((result as { reason?: string }).reason ?? "", /\n  find /);
	});
});

// --- the log -------------------------------------------------------------------

describe("the log", () => {
	it("caps instead of rotating, and says so", async () => {
		const dir = useTempLog();
		process.env.PI_SCAN_GUARD = "block";
		const pi = makePi();
		factory(pi.pi as never);
		void pi;
		// Fill it past a cap measured in bytes, not in events.
		writeFileSync(join(dir, "log.jsonl"), "x".repeat(1200) + "\n", "utf8");
		assert.equal(logIsCapped(dir, 1000), true);
		appendLog({ verdict: "block", tool: "find", root: HOME, depth: null, mode: "block", suggestion: "find ~/Projects -maxdepth 4" }, dir, 1000);
		assert.equal(statSync(join(dir, "log.jsonl")).size, 1201, "past the cap nothing more is written");
	});

	it("survives a log file that is not JSON", () => {
		const dir = useTempLog();
		writeFileSync(join(dir, "log.jsonl"), "{not json\n{also not\n", "utf8");
		assert.deepEqual(readLogEvents(10, dir), []);
	});

	it("survives a directory it cannot create", () => {
		assert.doesNotThrow(() =>
			appendLog({ verdict: "warn", tool: "fd", root: HOME, depth: 2, mode: "log", suggestion: "x" }, join("/proc/nonexistent-scan-guard", "x"), 1000),
		);
	});
});

// --- /scan-guard status --------------------------------------------------------

describe("/scan-guard status", () => {
	it("is registered, and says mode, counts, and the last scans", async () => {
		process.env.PI_SCAN_GUARD = "block";
		const dir = useTempLog();
		const pi = makePi();
		factory(pi.pi as never);
		await pi.call(`find ~ -name x`);
		const text = await pi.status();
		assert.match(text, /mode: block/);
		assert.match(text, /1 broad scans/);
		assert.match(text, /1 blocked/);
		assert.match(text, /last this session:/);
		assert.match(text, /last from the log:/);
		assert.match(text, /contents logged: no/);
		assert.match(text, /→ fd -H -F|→ find ~\//);
	});

	it("reports a capped log rather than pretending to record", async () => {
		process.env.PI_SCAN_GUARD = "log";
		const dir = useTempLog();
		const pi = makePi();
		factory(pi.pi as never);
		writeFileSync(join(dir, "log.jsonl"), "x".repeat(300 * 1024), "utf8");
		assert.match(await pi.status(), /CAPPED/);
	});

	it("works before anything has happened", async () => {
		process.env.PI_SCAN_GUARD = "off";
		useTempLog();
		const pi = makePi();
		factory(pi.pi as never);
		assert.match(await pi.status(), /mode: off/);
		assert.match(await pi.status(), /0 bash calls read/);
	});
});

// --- roots and the environment -------------------------------------------------

describe("the environment it reads", () => {
	it("suggests the session's own directory first, then the three places a file usually is", () => {
		assert.deepEqual(defaultScopedRoots(`${HOME}/Projects/app`, HOME), [
			`${HOME}/Projects/app`,
			`${HOME}/Projects`,
			`${HOME}/.pi`,
			`${HOME}/Downloads`,
		]);
	});

	it("uses the cwd of the call, not of the process", async () => {
		process.env.PI_SCAN_GUARD = "block";
		useTempLog();
		const pi = makePi({ cwd: `${HOME}/.emacs.d` });
		factory(pi.pi as never);
		const { result } = await pi.call(`find / -name init.el`);
		// Displayed in full: `~` is only substituted under the real home directory,
		// and this test's cwd is a synthetic one.
		assert.match((result as { reason?: string }).reason ?? "", /\/Users\/tester\/\.emacs\.d/);
	});

	it("keeps quiet when the classifier has nothing to say about the roots it was given", async () => {
		// A cwd inside a broad root, with nothing else to suggest, is still a refusal
		// — but the suggestion must not name the root it refused.
		process.env.PI_SCAN_GUARD = "block";
		useTempLog();
		const pi = makePi({ cwd: HOME });
		factory(pi.pi as never);
		const { result } = await pi.call(`find / -name x`);
		const reason = (result as { reason?: string }).reason ?? "";
		assert.match(reason, /The same search, scoped/);
		assert.doesNotMatch(reason, /\n {2}find \n|\n {2}fd .*  ~/);
	});
});

// --- coexistence ---------------------------------------------------------------

describe("with co-authored-by-ai loaded in the same session", () => {
	/**
	 * Pi runs `tool_call` handlers in registration order and stops at the first
	 * block. So on `git commit -m "x" && find ~ …` the trailer may well be added
	 * first — and then nothing runs at all, because the scan is refused and a block
	 * short-circuits the batch. That is intended (silently dropping the scan segment
	 * would be editing what the agent asked for), and it is why the reason has to
	 * say the commit did not happen either.
	 */
	it("blocks the whole command, including the commit it shares it with", async () => {
		process.env.PI_SCAN_GUARD = "block";
		useTempLog();
		const notes: string[] = [];
		const handlers: Array<{ name: string; fn: (event: Record<string, unknown>, ctx: unknown) => unknown }> = [];
		const execs: string[][] = [];
		const pi = {
			on: (name: string, fn: (event: Record<string, unknown>, ctx: unknown) => unknown) => handlers.push({ name, fn }),
			registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) =>
				handlers.push({ name, fn: (_event, ctx) => command.handler("", ctx) }),
			exec: async (_command: string, args: string[]) => {
				execs.push(args);
				return { code: 1, stdout: "", stderr: "", killed: false };
			},
		};
		coAuthoredByAi(pi as never);
		factory(pi as never);

		const ctx = {
			cwd: `${HOME}/Projects/app`,
			model: { name: "Test Model", provider: "test" },
			ui: { notify: (m: string) => notes.push(m) },
		};
		const event = {
			type: "tool_call",
			toolCallId: "call-9",
			toolName: "bash",
			input: { command: `git add -A && git commit -m "fix the thing" && find ~ -name note.md` },
		} as Record<string, unknown>;

		let blocked: { block?: boolean; reason?: string } | undefined;
		for (const handler of handlers) {
			if (handler.name !== "tool_call") continue;
			const out = (await handler.fn(event, ctx)) as { block?: boolean } | undefined;
			if (out?.block) {
				blocked = out;
				break; // what the runner does
			}
		}

		const input = (event.input as { command: string }).command;
		assert.match(input, /--trailer/, "co-authored-by-ai ran first, as it always has");
		assert.equal(blocked?.block, true, "scan-guard stopped it");
		assert.match(blocked?.reason ?? "", /Nothing in this command ran/);
	});
});
