/**
 * The Pi adapter: what the two hooks patch, refuse, and report.
 *
 * `implementation.test.ts` holds the string machinery and the real-git runs;
 * this file drives the extension through its own registration surface with a
 * fake Pi, because the interesting behaviour is a *sequence*: tool_call decides
 * to patch, tool_result decides what to say about the commit that resulted.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import factory, { buildTrailer, hasOnlyEmptyMessageLiteral, messageIsOnlyTrailer } from "./implementation.ts";

const TEST_MODEL = { name: "Claude Sonnet 4", provider: "anthropic" };
const TRAILER = buildTrailer(TEST_MODEL);
const FALLBACK_TRAILER = buildTrailer();

// --- fake Pi ---------------------------------------------------------------

interface FakeGit {
	/** What `git rev-parse --verify --quiet HEAD` answers (undefined/null = unborn HEAD). */
	headBefore?: string | null;
	/** The sha `git log -1` reports afterwards. */
	headAfter?: string | null;
	/** The body that comes back with it. */
	message?: string;
	/** exec throws (git missing, aborted, sandboxed). */
	failExec?: boolean;
	/** `git log` exits non-zero (not a repository). */
	failLog?: boolean;
}

interface FakeCtx {
	model: unknown;
	cwd: string;
	ui: { notify(message: string, type?: string): void };
}

type Handler = (event: Record<string, unknown>, ctx: FakeCtx) => Promise<unknown> | unknown;

function makePi(git: FakeGit = {}, model: unknown = TEST_MODEL) {
	const handlers = new Map<string, Handler>();
	const execs: string[][] = [];
	const notes: { message: string; type?: string }[] = [];
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		async exec(command: string, args: string[]) {
			execs.push([command, ...args]);
			if (git.failExec) throw new Error("spawn git ENOENT");
			if (args[0] === "rev-parse") {
				return {
					code: git.headBefore ? 0 : 1,
					stdout: git.headBefore ? `${git.headBefore}\n` : "",
					stderr: "",
					killed: false,
				};
			}
			if (args[0] === "log") {
				if (git.failLog || !git.headAfter) {
					return { code: 128, stdout: "", stderr: "fatal: bad default revision 'HEAD'", killed: false };
				}
				return { code: 0, stdout: `${git.headAfter}\n${git.message ?? ""}`, stderr: "", killed: false };
			}
			return { code: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}`, killed: false };
		},
	};
	factory(pi as never);

	const ctx: FakeCtx = {
		model,
		cwd: "/repo",
		ui: { notify: (message: string, type?: string) => notes.push({ message, type }) },
	};

	const call = async (command: string | undefined, overrides: { toolCallId?: string; toolName?: string } = {}) => {
		const event: Record<string, unknown> = {
			type: "tool_call",
			toolCallId: overrides.toolCallId ?? "call-1",
			toolName: overrides.toolName ?? "bash",
			input: { command },
		};
		await handlers.get("tool_call")!(event, ctx as never);
		return (event.input as { command?: string }).command;
	};

	const finish = async (
		overrides: { toolCallId?: string; isError?: boolean; content?: Record<string, unknown>[] } = {},
	) => {
		const event: Record<string, unknown> = {
			type: "tool_result",
			toolCallId: overrides.toolCallId ?? "call-1",
			toolName: "bash",
			isError: overrides.isError ?? false,
			content: overrides.content ?? [{ type: "text", text: "[main 1a2b3c4] 1 file changed" }],
			structuredContent: undefined,
		};
		return (await handlers.get("tool_result")!(event, ctx as never)) as
			| { content?: { type: string; text: string }[] }
			| undefined;
	};

	return { handlers, execs, notes, call, finish };
}

// =============================================================================
// tool_call: what gets patched
// =============================================================================

describe("tool_call patches commits", () => {
	it("registers both hooks", async () => {
		const pi = makePi();
		assert.ok(pi.handlers.has("tool_call"), "patches the command before it runs");
		assert.ok(pi.handlers.has("tool_result"), "checks what the commit recorded");
	});

	it("leaves commands it is not about", async () => {
		for (const command of [
			"",
			undefined,
			"git push origin main",
			"git status",
			"git add -A && git push",
			'echo "commit this" && git log',
		]) {
			const pi = makePi();
			assert.equal(await pi.call(command), command);
			assert.deepEqual(pi.notes, [], "nothing to report about a command it ignored");
		}
	});

	it("ignores non-bash tool calls that mention a command", async () => {
		const pi = makePi();
		const command = 'git commit -m "x"';
		assert.equal(await pi.call(command, { toolName: "read" }), command);
	});

	it("never touches a command that already has a Co-authored-by trailer", async () => {
		for (const command of [
			`git commit -m "x" --trailer "${TRAILER}"`,
			'git commit -m "x" --trailer "Co-authored-by: AI"',
			'git commit -m "fix\\n\\nCO-AUTHORED-BY: someone"',
			'git commit -m "fix\\n\\nCo-Authored-By: someone <noreply@test.com>"',
		]) {
			const pi = makePi();
			assert.equal(await pi.call(command), command);
		}
	});

	it("names the model that made the commit, or just Pi", async () => {
		const named = makePi({}, TEST_MODEL);
		assert.equal(
			await named.call('git commit -m "hello"'),
			`git commit -m "hello" --trailer "${TRAILER}"`,
		);
		const unnamed = makePi({}, null); // null = no model selected; undefined would take the default
		assert.equal(
			await unnamed.call('git commit -m "hello"'),
			`git commit -m "hello" --trailer "${FALLBACK_TRAILER}"`,
		);
	});

	it("injects into an amend of any shape, including --amend --no-edit", async () => {
		for (const command of [
			'git commit --amend -m "fix"',
			"git commit --amend --no-edit",
			"git commit -q --amend --no-edit",
		]) {
			const pi = makePi();
			assert.match((await pi.call(command)) ?? "", /--trailer "/);
		}
	});

	it("keeps quoted punctuation and newline cleanup intact while injecting", async () => {
		const pi = makePi();
		assert.equal(
			await pi.call('git commit -m "fix bug; clean up comment"'),
			`git commit -m "fix bug; clean up comment" --trailer "${TRAILER}"`,
		);
		assert.equal(
			await pi.call("git commit -F /tmp/msg.txt\nrm /tmp/msg.txt"),
			`git commit -F /tmp/msg.txt --trailer "${TRAILER}"\nrm /tmp/msg.txt`,
		);
	});
});

// =============================================================================
// tool_call: the empty message it refuses to rescue
// =============================================================================

describe("tool_call refuses to rescue an empty message", () => {
	it("leaves a blank -m alone, so git's own failure still happens", async () => {
		for (const command of [
			'git commit -m ""',
			"git commit -m ''",
			'git commit -m "   "',
			'git commit --message ""',
			'git add -A && git commit -m ""',
			'git commit --amend -m ""',
			'git commit -m "" -m ""',
			'git commit -q -m ""',
		]) {
			const pi = makePi();
			assert.equal(await pi.call(command), command, `${command} must reach git unpatched`);
			assert.equal(pi.notes.length, 1, "the human is told why nothing was added");
			assert.match(pi.notes[0]!.message, /message is empty|--trailer/);
			assert.equal(pi.notes[0]!.type, "warning");
		}
	});

	it("still patches a message that is only partly blank", async () => {
		for (const command of [
			'git commit -m "" -m "the real body"',
			'git commit -m "subject" -m ""',
			'git commit -m "subject" -m "body"',
		]) {
			const pi = makePi();
			assert.match((await pi.call(command)) ?? "", /--trailer "/, command);
			assert.deepEqual(pi.notes, []);
		}
	});

	it("does not guess at messages it cannot read", async () => {
		// These may yet be empty — a variable, stdin, a file, a reused message —
		// so patching proceeds and tool_result is the one that checks.
		for (const command of [
			'git commit -m "$MSG"',
			"git commit -m $'subject\\n\\nbody'",
			"git commit -F -",
			"git commit -F msg.txt",
			"git commit --amend --no-edit",
			"git commit",
			"git commit -c HEAD~1 -m \"\"",
		]) {
			const pi = makePi();
			assert.match((await pi.call(command)) ?? "", /--trailer "/, command);
		}
	});

	it("records the commit it patched only after deciding to patch it", async () => {
		const refused = makePi();
		await refused.call('git commit -m ""');
		assert.deepEqual(refused.execs, [], "no baseline read for a commit it did not touch");

		const patched = makePi();
		await patched.call('git commit -m "real"');
		assert.deepEqual(patched.execs, [["git", "rev-parse", "--verify", "--quiet", "HEAD"]]);
	});
});

// =============================================================================
// tool_result: the empty message git was made to accept
// =============================================================================

describe("tool_result checks the commit it caused", () => {
	const trailerOnly = `${TRAILER}\n`;

	it("warns in the result and to the human when the message is only the trailer", async () => {
		const pi = makePi({ headBefore: "aaaaaaaa", headAfter: "bbbbbbbb", message: trailerOnly });
		await pi.call('git commit -m "$MSG"');
		const result = await pi.finish({ content: [{ type: "text", text: "[main bbbbbbb] 1 file changed" }] });

		const text = (result?.content ?? []).map((part) => part.text).join("");
		assert.match(text, /^\[main bbbbbbb\] 1 file changed/, "the original output is preserved");
		assert.match(text, /nothing but the Co-authored-by trailer/);
		assert.match(text, /git commit --amend -m/);
		assert.equal(pi.notes.length, 1);
		assert.equal(pi.notes[0]!.type, "error");
		assert.match(pi.notes[0]!.message, /empty message/);
	});

	it("says nothing when the commit has a message", async () => {
		const pi = makePi({ headBefore: "aaaaaaaa", headAfter: "bbbbbbbb", message: `fix: the bug\n\n${TRAILER}\n` });
		await pi.call('git commit -m "fix: the bug"');
		assert.equal(await pi.finish(), undefined);
		assert.deepEqual(pi.notes, []);
	});

	it("says nothing when no commit happened", async () => {
		const unchanged = makePi({ headBefore: "aaaaaaaa", headAfter: "aaaaaaaa", message: trailerOnly });
		await unchanged.call('git commit -m "$MSG"');
		assert.equal(await unchanged.finish({ isError: true }), undefined, "git refused the command");
		assert.deepEqual(unchanged.execs.length, 1, "a refused command is not investigated");

		const noNewCommit = makePi({ headBefore: "aaaaaaaa", headAfter: "aaaaaaaa", message: trailerOnly });
		await noNewCommit.call('git commit -m "$MSG"');
		assert.equal(await noNewCommit.finish(), undefined, "same HEAD, so the trailer-only commit is not ours");
	});

	it("says nothing about calls it never patched", async () => {
		const pi = makePi({ headBefore: "aaaaaaaa", headAfter: "bbbbbbbb", message: trailerOnly });
		await pi.call("git status");
		assert.equal(await pi.finish(), undefined);

		const neverCalled = makePi({ headBefore: "aaaaaaaa", headAfter: "bbbbbbbb", message: trailerOnly });
		assert.equal(await neverCalled.finish({ toolCallId: "someone-else" }), undefined);
		assert.deepEqual(neverCalled.execs, [], "and it does not go looking in git for them");
	});

	it("stays silent when git cannot answer", async () => {
		const noGit = makePi({ failExec: true });
		await noGit.call('git commit -m "x"');
		assert.equal(await noGit.finish(), undefined, "exec throwing must not break the tool call");
		assert.deepEqual(noGit.notes, []);

		const notARepo = makePi({ headBefore: "aaaaaaaa", failLog: true });
		await notARepo.call('git commit -m "x"');
		assert.equal(await notARepo.finish(), undefined);
	});

	it("reports each patched call once", async () => {
		const pi = makePi({ headBefore: "aaaaaaaa", headAfter: "bbbbbbbb", message: trailerOnly });
		await pi.call('git commit -m "$MSG"');
		const first = await pi.finish();
		const before = pi.execs.length;
		const second = await pi.finish();
		assert.ok(first !== undefined, "the first result carries the warning");
		assert.equal(second, undefined, "the second is a different call, or a repeat: either way, silent");
		assert.equal(pi.execs.length, before, "and it did not ask git again");
	});

	it("keeps its bookkeeping bounded when calls are abandoned", async () => {
		// 40 patched calls whose tool_result never arrives (aborted, crashed) must
		// not grow without limit; the map evicts its oldest entry past 32.
		const pi = makePi({ headBefore: "aaaaaaaa", headAfter: "bbbbbbbb", message: `subject\n\n${TRAILER}\n` });
		for (let i = 0; i < 40; i += 1) {
			await pi.call('git commit -m "x"', { toolCallId: `call-${i}` });
		}
		// The very first call has been evicted, so its result is someone else's now.
		assert.equal(await pi.finish({ toolCallId: "call-0" }), undefined);
		const kept = await pi.finish({ toolCallId: "call-39" });
		assert.equal(kept, undefined, "a normal commit message is never reported");
	});
});
