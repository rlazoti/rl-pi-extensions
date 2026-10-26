import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import coAuthoredByAi, {
	buildTrailer,
	containsUnquoted,
	hasCoAuthoredBy,
	injectGitTrailer,
	splitShellCommand,
} from "./implementation.ts";

const TEST_MODEL = { name: "Claude Sonnet 4", provider: "anthropic" };
const TRAILER = buildTrailer(TEST_MODEL);
const FALLBACK_TRAILER = buildTrailer();

// =============================================================================
// buildTrailer
// =============================================================================

describe("buildTrailer", () => {
	it("puts the model name in the parenthetical", () => {
		assert.equal(
			buildTrailer({ name: "Claude Sonnet 4", provider: "anthropic" }),
			"Co-authored-by: AI (Pi/Claude Sonnet 4) <noreply@pi.dev>",
		);
	});

	it("keeps provider variant suffixes verbatim", () => {
		assert.equal(
			buildTrailer({ name: "Claude Opus 4.6 [1M]", provider: "anthropic-1m" }),
			"Co-authored-by: AI (Pi/Claude Opus 4.6 [1M]) <noreply@pi.dev>",
		);
	});

	it("uses the same email for every provider", () => {
		for (const provider of ["anthropic", "openai", "google", "xai", "mistral", "some-provider"]) {
			assert.match(buildTrailer({ name: "Model", provider }), /<noreply@pi\.dev>$/);
		}
	});

	it("falls back to Pi-only when there is no model", () => {
		assert.equal(buildTrailer(), "Co-authored-by: AI (Pi) <noreply@pi.dev>");
		assert.equal(buildTrailer(undefined), "Co-authored-by: AI (Pi) <noreply@pi.dev>");
	});

	it("keeps the stable prefix every tooling grep depends on", () => {
		assert.match(buildTrailer(), /^Co-authored-by: AI\b/);
		assert.match(buildTrailer(TEST_MODEL), /^Co-authored-by: AI\b/);
		assert.match(buildTrailer({ name: "Custom", provider: "unknown" }), /^Co-authored-by: AI\b/);
	});
});

// =============================================================================
// hasCoAuthoredBy
// =============================================================================

describe("hasCoAuthoredBy", () => {
	it("matches the trailer in any casing, flag or message body", () => {
		for (const cmd of [
			'git commit --trailer "Co-authored-by: AI"',
			`git commit --trailer "${TRAILER}"`,
			'gt cc -m "co-authored-by: ai"',
			'gt cc -m "CO-AUTHORED-BY: AI"',
			'gt cc -m "Co-Authored-By: AI"',
			'git commit -m "fix\\n\\nCo-authored-by: AI (Pi) <noreply@pi.dev>"',
			'git commit -m "fix\\n\\nCo-authored-by: someone <a@b.c>"',
		]) {
			assert.equal(hasCoAuthoredBy(cmd), true, cmd);
		}
	});

	it("does not match unrelated or partial text", () => {
		assert.equal(hasCoAuthoredBy('git commit -m "fix bug"'), false);
		assert.equal(hasCoAuthoredBy('git commit -m "co-authored"'), false);
	});
});

// =============================================================================
// splitShellCommand
// =============================================================================

describe("splitShellCommand", () => {
	it("returns a single segment for a simple command", () => {
		assert.deepEqual(splitShellCommand("git commit -m 'x'"), ["git commit -m 'x'"]);
	});

	it("splits on && with surrounding whitespace absorbed into the separator", () => {
		assert.deepEqual(splitShellCommand('git add -A && git commit -m "x"'), [
			"git add -A",
			" && ",
			'git commit -m "x"',
		]);
	});

	it("splits on ||, |, ; and newline", () => {
		assert.deepEqual(splitShellCommand("a || b"), ["a", " || ", "b"]);
		assert.deepEqual(splitShellCommand("a | b"), ["a", " | ", "b"]);
		assert.deepEqual(splitShellCommand("a; b"), ["a", "; ", "b"]);
		assert.deepEqual(splitShellCommand("a\nb"), ["a", "\n", "b"]);
	});

	it("distinguishes || from |", () => {
		// `||` is one 2-char operator; `|` is its own 1-char operator. Splitting
		// on `|` is what keeps `git commit … | tail -5` from having --trailer
		// appended to tail.
		assert.deepEqual(splitShellCommand("a || b | c"), ["a", " || ", "b", " | ", "c"]);
	});

	it("does not split inside quoted strings", () => {
		assert.deepEqual(splitShellCommand('echo "a; b && c || d"'), ['echo "a; b && c || d"']);
		assert.deepEqual(splitShellCommand("echo 'a; b && c || d'"), ["echo 'a; b && c || d'"]);
		assert.deepEqual(splitShellCommand('echo "x | y"'), ['echo "x | y"']);
	});

	it("honours backslash escapes inside double quotes only", () => {
		// \" is escaped, so the following " does not close the string.
		assert.deepEqual(splitShellCommand('echo "a\\"; b"'), ['echo "a\\"; b"']);
		// In single quotes the \ is literal, so the next ' closes the string.
		assert.deepEqual(splitShellCommand("echo 'a\\'; b"), ["echo 'a\\'", "; ", "b"]);
	});

	it("does not split an unterminated quote", () => {
		assert.deepEqual(splitShellCommand('echo "a; b'), ['echo "a; b']);
	});

	it("handles multiple separators, and edges of the input", () => {
		assert.deepEqual(splitShellCommand("a && b || c; d\ne"), [
			"a",
			" && ",
			"b",
			" || ",
			"c",
			"; ",
			"d",
			"\n",
			"e",
		]);
		assert.deepEqual(splitShellCommand(""), [""]);
		assert.deepEqual(splitShellCommand("; a"), ["", "; ", "a"]);
		assert.deepEqual(splitShellCommand("a;"), ["a", ";", ""]);
		assert.deepEqual(splitShellCommand("a   ;\t b"), ["a", "   ;\t ", "b"]);
	});

	it("does not treat a single & as a separator", () => {
		assert.deepEqual(splitShellCommand("a & b"), ["a & b"]);
	});

	it("always reconstructs the original via join (join is the round trip)", () => {
		for (const cmd of [
			"a",
			"",
			"a && b",
			"  a  ;  b  ",
			'git commit -m "x; y"\necho done',
			'echo "a\\"b"; c',
			"git commit -m 'it'\''s here' && git push",
		]) {
			assert.equal(splitShellCommand(cmd).join(""), cmd);
		}
	});
});

// =============================================================================
// containsUnquoted
// =============================================================================

describe("containsUnquoted", () => {
	const RE = /\bgit\s+commit\b/;

	it("matches only where bash would run it", () => {
		assert.equal(containsUnquoted("git commit -m 'x'", RE), true);
		assert.equal(containsUnquoted('echo "git commit" && git commit', RE), true);
	});

	it("ignores the pattern inside quotes of either kind", () => {
		assert.equal(containsUnquoted('echo "git commit"', RE), false);
		assert.equal(containsUnquoted("echo 'git commit'", RE), false);
	});

	it("ignores the pattern entirely when there is no match", () => {
		assert.equal(containsUnquoted("git status", RE), false);
		assert.equal(containsUnquoted("", RE), false);
	});

	it("respects backslash escapes inside double quotes", () => {
		// The first " is escaped, so the whole "…" is one quoted span covering
		// the 'git commit' literal.
		assert.equal(containsUnquoted('echo "\\" git commit \\""', RE), false);
	});

	it("treats an unterminated quote as swallowing the rest", () => {
		assert.equal(containsUnquoted('echo "unterminated git commit', RE), false);
	});

	it("works with a global regex", () => {
		assert.equal(containsUnquoted("git commit here", /\bgit\s+commit\b/g), true);
	});

	it("skips zero-length matches without hanging", () => {
		assert.equal(containsUnquoted("abc", /x*/), true);
		// The lookbehind forces the match to start *after* the opening quote, so
		// the first zero-length match sits inside the quoted range. Without the
		// lastIndex guard this loop never terminates.
		assert.equal(containsUnquoted('\\"abc\\"', /(?<=\")x*/), true);
	});
});

// =============================================================================
// injectGitTrailer
// =============================================================================

describe("injectGitTrailer", () => {
	it("appends the trailer to a plain commit", () => {
		assert.equal(
			injectGitTrailer('git commit -m "fix something"', TRAILER),
			`git commit -m "fix something" --trailer "${TRAILER}"`,
		);
	});

	it("tolerates odd spacing and trailing whitespace", () => {
		assert.equal(injectGitTrailer('git  commit -m "msg"', TRAILER), `git  commit -m "msg" --trailer "${TRAILER}"`);
		assert.equal(injectGitTrailer('git commit -m "msg"   ', TRAILER), `git commit -m "msg" --trailer "${TRAILER}"`);
	});

	it("modifies only the committing segment of a chained command", () => {
		assert.equal(
			injectGitTrailer('git add -A && git commit -m "msg"', TRAILER),
			`git add -A && git commit -m "msg" --trailer "${TRAILER}"`,
		);
		assert.equal(
			injectGitTrailer('echo hi; git commit -m "msg"', TRAILER),
			`echo hi; git commit -m "msg" --trailer "${TRAILER}"`,
		);
		assert.equal(
			injectGitTrailer('git commit -m "msg" || echo failed', TRAILER),
			`git commit -m "msg" --trailer "${TRAILER}" || echo failed`,
		);
	});

	it("leaves a command with no commit untouched", () => {
		assert.equal(injectGitTrailer("git add -A", TRAILER), "git add -A");
	});

	// --- Regressions, carried over from the extension this one replaces ---

	it("does not treat ; inside a quoted -m message as a separator", () => {
		// Bug: a `;` in the commit subject sliced the segment in half and spliced
		// the trailer into the middle of the message.
		assert.equal(
			injectGitTrailer('git commit -m "Remove X from git; canonical data lives in Y"', TRAILER),
			`git commit -m "Remove X from git; canonical data lives in Y" --trailer "${TRAILER}"`,
		);
	});

	it("does not treat && or || or | inside a quoted message as separators", () => {
		assert.equal(
			injectGitTrailer('git commit -m "fix foo && bar"', TRAILER),
			`git commit -m "fix foo && bar" --trailer "${TRAILER}"`,
		);
		assert.equal(
			injectGitTrailer('git commit -m "handle a || b case"', TRAILER),
			`git commit -m "handle a || b case" --trailer "${TRAILER}"`,
		);
		assert.equal(
			injectGitTrailer('git commit -m "feat: add | to splitter"', TRAILER),
			`git commit -m "feat: add | to splitter" --trailer "${TRAILER}"`,
		);
	});

	it("treats a newline as a separator, so cleanup commands stay clean", () => {
		// Bug: `git commit -F /tmp/m\nrm /tmp/m` appended --trailer to `rm`:
		// `rm: --trailer: No such file or directory`.
		assert.equal(
			injectGitTrailer("git commit -F /tmp/m\nrm /tmp/m", TRAILER),
			`git commit -F /tmp/m --trailer "${TRAILER}"\nrm /tmp/m`,
		);
	});

	it("appends to the commit segment, never to a piped tail/grep/head", () => {
		// Bug: the trailer landed on the last token of the whole pipeline
		// (`tail -5 --trailer …` → `unrecognized option '--trailer'`). The commit
		// still happened, silently without attribution.
		assert.equal(
			injectGitTrailer("git commit -F /tmp/msg.txt 2>&1 | tail -5", TRAILER),
			`git commit -F /tmp/msg.txt 2>&1 --trailer "${TRAILER}" | tail -5`,
		);
	});

	it("does not inject when 'git commit' appears only inside quotes", () => {
		// Bug: `node -e 'const x = "git commit"'` matched and got the trailer
		// spliced into the node script.
		assert.equal(injectGitTrailer(`node -e 'const x = "git commit"'`, TRAILER), `node -e 'const x = "git commit"'`);
		assert.equal(injectGitTrailer('rg "git commit" .', TRAILER), 'rg "git commit" .');
		assert.equal(injectGitTrailer('echo "git commit"', TRAILER), 'echo "git commit"');
	});

	it("still injects when the same command also quotes 'git commit'", () => {
		assert.equal(
			injectGitTrailer('echo "git commit" && git commit -m "msg"', TRAILER),
			`echo "git commit" && git commit -m "msg" --trailer "${TRAILER}"`,
		);
	});

	it("handles a multi-line -m message", () => {
		assert.equal(
			injectGitTrailer('git commit -m "subject\\n\\nbody"', TRAILER),
			`git commit -m "subject\\n\\nbody" --trailer "${TRAILER}"`,
		);
	});

	it("injects into an amend, which is where attribution is otherwise lost", () => {
		// The reused message is the message; git deduplicates an identical
		// trailer rather than stacking it (see the real-git tests below).
		assert.equal(
			injectGitTrailer("git commit --amend --no-edit", TRAILER),
			`git commit --amend --no-edit --trailer "${TRAILER}"`,
		);
	});
});

// =============================================================================
// tool_call handler
// =============================================================================

type ToolCallHandler = (event: { toolName: string; input: Record<string, unknown> }, ctx: unknown) => void;

function fakePi(): { handlers: Map<string, ToolCallHandler>; model: unknown } {
	const handlers = new Map<string, ToolCallHandler>();
	const pi = {
		on(name: string, handler: ToolCallHandler) {
			handlers.set(name, handler);
		},
	};
	coAuthoredByAi(pi as never);
	return { handlers, model: undefined };
}

function runHandler(command: string | undefined, model: unknown): string | undefined {
	const { handlers } = fakePi();
	const handler = handlers.get("tool_call");
	assert.ok(handler, "the extension registers a tool_call handler");
	const event = { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command } };
	handler(event as never, { model });
	return event.input.command as string | undefined;
}

describe("tool_call handler", () => {
	it("registers a tool_call listener", () => {
		assert.ok(fakePi().handlers.has("tool_call"));
	});

	it("leaves commands it is not about", () => {
		for (const command of [
			"",
			undefined,
			"git push origin main",
			"git status",
			"git add -A && git push",
			'echo "commit this" && git log',
		]) {
			assert.equal(runHandler(command, TEST_MODEL), command);
		}
	});

	it("ignores non-bash tool calls that mention a command", () => {
		const { handlers } = fakePi();
		const handler = handlers.get("tool_call")!;
		const event = { type: "tool_call", toolCallId: "c", toolName: "read", input: { command: 'git commit -m "x"' } };
		handler(event as never, { model: TEST_MODEL });
		assert.equal(event.input.command, 'git commit -m "x"');
	});

	it("never touches a command that already has a Co-authored-by trailer", () => {
		for (const command of [
			`git commit -m "x" --trailer "${TRAILER}"`,
			'git commit -m "x" --trailer "Co-authored-by: AI"',
			'git commit -m "fix\\n\\nCO-AUTHORED-BY: someone"',
			'git commit -m "fix\\n\\nCo-Authored-By: someone <noreply@test.com>"',
		]) {
			assert.equal(runHandler(command, TEST_MODEL), command);
		}
	});

	it("names the model that made the commit, or just Pi", () => {
		assert.equal(
			runHandler('git commit -m "hello"', TEST_MODEL),
			`git commit -m "hello" --trailer "${TRAILER}"`,
		);
		assert.equal(
			runHandler('git commit -m "hello"', undefined),
			`git commit -m "hello" --trailer "${FALLBACK_TRAILER}"`,
		);
	});

	it("injects into an amend of any shape, including --amend --no-edit", () => {
		for (const command of [
			'git commit --amend -m "fix"',
			"git commit --amend --no-edit",
			"git commit -q --amend --no-edit",
		]) {
			assert.match(runHandler(command, TEST_MODEL) ?? "", /--trailer "/);
		}
	});

	it("keeps quoted punctuation and newline cleanup intact while injecting", () => {
		assert.equal(
			runHandler('git commit -m "fix bug; clean up comment"', TEST_MODEL),
			`git commit -m "fix bug; clean up comment" --trailer "${TRAILER}"`,
		);
		assert.equal(
			runHandler("git commit -F /tmp/msg.txt\nrm /tmp/msg.txt", TEST_MODEL),
			`git commit -F /tmp/msg.txt --trailer "${TRAILER}"\nrm /tmp/msg.txt`,
		);
	});
});

// =============================================================================
// Real git: the point of the extension, not just the string surgery
// =============================================================================

function gitAvailable(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "co-authored-by-ai-"));
	const run = (cmd: string) => execFileSync("bash", ["-c", cmd], { cwd: dir, env: gitEnv(), stdio: "ignore" });
	run("git init -q . && mkdir -p dir && echo hi > dir/file.txt && git add dir");
	return dir;
}

function gitEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_AUTHOR_NAME: "T",
		GIT_AUTHOR_EMAIL: "t@example.com",
		GIT_COMMITTER_NAME: "T",
		GIT_COMMITTER_EMAIL: "t@example.com",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		HOME: tmpdir(),
	};
}

function commitMessage(dir: string): string {
	return execFileSync("git", ["log", "-1", "--format=%B"], { cwd: dir, env: gitEnv(), encoding: "utf8" });
}

function runIn(dir: string, command: string): void {
	execFileSync("bash", ["-c", command], { cwd: dir, env: gitEnv(), stdio: "ignore" });
}

const git = gitAvailable();
const repoDirs: string[] = [];

describe("real git runs the patched command", { skip: git ? false : "git is not installed" }, () => {
	const trailerCount = (message: string) => message.split(/\n/).filter((line) => /^co-authored-by:/i.test(line)).length;

	// Every case feeds the *patched* command through bash, so the assertion is
	// about what git recorded, not about what the string manipulation produced.
	const commit = (raw: string): { dir: string; message: string } => {
		const dir = makeRepo();
		repoDirs.push(dir);
		runIn(dir, injectGitTrailer(raw, TRAILER));
		return { dir, message: commitMessage(dir) };
	};

	it("records exactly one trailer", () => {
		const { message } = commit('git commit -q -m "fix: the bug"');
		assert.ok(message.includes(TRAILER), message);
		assert.equal(trailerCount(message), 1);
	});

	it("keeps a message whose text contains shell operators byte for byte", () => {
		// The subject contains ; && || and a | — all of which the splitter must
		// treat as message text, and all of which must survive the shell.
		const { message } = commit('git commit -q -m "split a; keep b && c || d | e"');
		assert.match(message, /^split a; keep b && c \|\| d \| e$/m);
		assert.equal(trailerCount(message), 1);
	});

	it("records one trailer when an amend re-runs the injection", () => {
		// This is why the --amend --no-edit skip was dropped: git's trailer
		// handling is addIfDifferent, so amending an attributed commit keeps one
		// trailer instead of stacking a second copy.
		const dir = makeRepo();
		repoDirs.push(dir);
		runIn(dir, injectGitTrailer('git commit -q -m "subject"', TRAILER));
		runIn(dir, injectGitTrailer("git commit -q --amend --no-edit", TRAILER));
		runIn(dir, injectGitTrailer("git commit -q --amend --no-edit", TRAILER));
		const message = commitMessage(dir);
		assert.equal(trailerCount(message), 1, message);
		assert.ok(message.includes(TRAILER));
	});

	it("does not touch the cleanup command after a newline", () => {
		const dir = makeRepo();
		repoDirs.push(dir);
		// A trailing rm that would have failed loudly had --trailer landed on it.
		runIn(dir, injectGitTrailer('git commit -q -m "msg"\ntouch marker', TRAILER));
		assert.ok(existsSync(join(dir, "marker")), "the command after the newline still ran");
		assert.equal(trailerCount(commitMessage(dir)), 1);
	});

	it("appends to a human trailer rather than replacing it", () => {
		// $'…' so the message really spans lines (a literal \n would stay literal).
		const { message } = commit(`git commit -q -m $'subject\n\nSigned-off-by: Human <h@example.com>'`);
		assert.match(message, /^Signed-off-by: Human <h@example\.com>$/m);
		assert.ok(message.includes(TRAILER), message);
		assert.equal(trailerCount(message), 1);
	});

	it("rescues a commit that had no message at all, which is how a typo becomes a commit", () => {
		// Measured, not hypothetical: this extension shipped into a live session
		// where `git commit -F - <<'EOF'` was typed with no here-document body.
		// Unpatched, git aborts an empty message with exit 1 and the author sees
		// the mistake. Patched, the trailer *is* a message: git exits 0 and the
		// entire commit message is the trailer line. Stdin is not visible to a
		// tool_call hook, so nothing here can detect it at patch time — hence a
		// test that pins the asymmetry instead of a guard that cannot exist.
		const empty = `printf '' | `;
		const failing = makeRepo();
		repoDirs.push(failing);
		assert.throws(
			() => runIn(failing, `${empty}git commit -q -F -`),
			(err: unknown) => (err as { status?: number }).status === 1,
			"an empty message must fail loudly when the extension is not involved",
		);
		assert.throws(() => commitMessage(failing), "and it really did not commit");

		const rescued = makeRepo();
		repoDirs.push(rescued);
		runIn(rescued, empty + injectGitTrailer("git commit -q -F -", TRAILER));
		assert.equal(commitMessage(rescued).trim(), TRAILER, "the trailer became the whole message");
	});
});

after(() => {
	for (const dir of repoDirs) rmSync(dir, { recursive: true, force: true });
});
