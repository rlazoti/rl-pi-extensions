import assert from "node:assert/strict";
import test from "node:test";
import {
	buildTmuxActivationCommand,
	claimProcessRole,
	formatAskBody,
	inactiveReason,
	terminalBundleId,
	truncateText,
	tmuxTargetFromEnv,
} from "./implementation.ts";

// --- claimProcessRole tests ---

test("claimProcessRole: returns main when no existing role", () => {
	const env: NodeJS.ProcessEnv = {};
	const role = claimProcessRole(env, 1234);
	assert.equal(role, "main");
	assert.equal(env["PI_SESSION_ATTENTION_PROCESS_ROLE"], "1234:main");
});

test("claimProcessRole: returns main when PID matches", () => {
	const env: NodeJS.ProcessEnv = { PI_SESSION_ATTENTION_PROCESS_ROLE: "1234:main" };
	const role = claimProcessRole(env, 1234);
	assert.equal(role, "main");
});

test("claimProcessRole: returns child when PID doesn't match", () => {
	const env: NodeJS.ProcessEnv = { PI_SESSION_ATTENTION_PROCESS_ROLE: "1234:main" };
	const role = claimProcessRole(env, 5678);
	assert.equal(role, "child");
});

test("claimProcessRole: returns child when existing role is child", () => {
	const env: NodeJS.ProcessEnv = { PI_SESSION_ATTENTION_PROCESS_ROLE: "1234:child" };
	const role = claimProcessRole(env, 5678);
	assert.equal(role, "child");
});

// --- tmuxTargetFromEnv tests ---

test("tmuxTargetFromEnv: returns target when env has TMUX and TMUX_PANE", () => {
	const env: NodeJS.ProcessEnv = {
		TMUX: "/tmp/tmux-1000/default,0,0",
		TMUX_PANE: "%1",
	};
	const target = tmuxTargetFromEnv(env);
	assert.equal(target?.socket, "/tmp/tmux-1000/default");
	assert.equal(target?.paneId, "%1");
});

test("tmuxTargetFromEnv: returns null when TMUX is missing", () => {
	const env: NodeJS.ProcessEnv = {};
	const target = tmuxTargetFromEnv(env);
	assert.equal(target, null);
});

test("tmuxTargetFromEnv: returns null when TMUX_PANE is missing", () => {
	const env: NodeJS.ProcessEnv = { TMUX: "/tmp/tmux-1000/default,0,0" };
	const target = tmuxTargetFromEnv(env);
	assert.equal(target, null);
});

// --- terminalBundleId / activation command tests ---

test("terminalBundleId: uses the launching terminal's bundle id", () => {
	assert.equal(
		terminalBundleId({ __CFBundleIdentifier: "com.mitchellh.ghostty" }),
		"com.mitchellh.ghostty",
		"a Ghostty user must be shown Ghostty, not iTerm",
	);
	assert.equal(terminalBundleId({ __CFBundleIdentifier: "com.apple.Terminal" }), "com.apple.Terminal");
});

test("terminalBundleId: falls back to iTerm when unset or unusable", () => {
	assert.equal(terminalBundleId({}), "com.googlecode.iterm2");
	// The id is interpolated into a shell command line, so anything that is not a
	// plausible bundle identifier is rejected rather than passed through.
	for (const bad of ["", " ", "com.foo; rm -rf /", "$(whoami)", "a".repeat(200)]) {
		assert.equal(terminalBundleId({ __CFBundleIdentifier: bad }), "com.googlecode.iterm2", `accepted ${bad}`);
	}
});

test("buildTmuxActivationCommand: focuses the caller's terminal, not iTerm", () => {
	const command = buildTmuxActivationCommand(
		{ socket: "/tmp/tmux-501/default", paneId: "%3" },
		"/opt/homebrew/bin/tmux",
		"com.mitchellh.ghostty",
	);
	assert.match(command, /open -b 'com\.mitchellh\.ghostty'/);
	assert.doesNotMatch(command, /iterm/i);
	assert.match(command, /'\/opt\/homebrew\/bin\/tmux' -S '\/tmp\/tmux-501\/default' select-window -t '%3'/);
});

// --- formatAskBody tests ---

test("formatAskBody: returns default message for null args", () => {
	assert.equal(formatAskBody(null), "Waiting for your input");
});

test("formatAskBody: returns default message for non-object args", () => {
	assert.equal(formatAskBody("string"), "Waiting for your input");
	assert.equal(formatAskBody(123), "Waiting for your input");
});

test("formatAskBody: returns question count for multiple questions", () => {
	const args = {
		questions: [
			{ id: "a", question: "Question 1", label: "A" },
			{ id: "b", question: "Question 2", label: "B" },
			{ id: "c", question: "Question 3", label: "C" },
		],
	};
	assert.equal(formatAskBody(args), "3 questions waiting for your input");
});

test("formatAskBody: returns single question text", () => {
	const args = { questions: [{ id: "q", question: "What is your name?", label: "Q" }] };
	assert.equal(formatAskBody(args), "What is your name?");
});

test("formatAskBody: accepts a single question object instead of an array", () => {
	const args = { questions: { id: "q", question: "Solo question?", label: "Q" } };
	assert.equal(formatAskBody(args), "Solo question?");
});

test("formatAskBody: truncates long question text", () => {
	const args = { questions: [{ id: "q", question: "A".repeat(250), label: "Q" }] };
	const result = formatAskBody(args);
	assert.equal(result.length, 200);
	assert.ok(result.endsWith("…"));
});

test("formatAskBody: returns default for empty question text", () => {
	const args = { questions: [{ id: "q", question: "   ", label: "Q" }] };
	assert.equal(formatAskBody(args), "Waiting for your input");
});

// --- truncateText tests ---

test("truncateText: returns text as-is when under max length", () => {
	assert.equal(truncateText("Hello world", 100), "Hello world");
});

test("truncateText: truncates text when over max length", () => {
	const longText = "A".repeat(150);
	const result = truncateText(longText, 100);
	assert.equal(result.length, 100);
	assert.equal(result.endsWith("…"), true);
});

test("truncateText: normalizes whitespace", () => {
	const result = truncateText("Hello   world\n\nfoo", 100);
	assert.equal(result, "Hello world foo");
});

test("truncateText: returns default for empty text", () => {
	assert.equal(truncateText("", 100), "Pi needs your attention");
});

// --- inactiveReason tests ---

test("inactiveReason: returns child role message", () => {
	assert.equal(inactiveReason("child", false, "darwin", "tui"), "disabled in child/background Pi processes");
});

test("inactiveReason: returns disabled message", () => {
	assert.equal(inactiveReason("main", true, "darwin", "tui"), "disabled by PI_SESSION_ATTENTION_DISABLE=1");
});

test("inactiveReason: returns platform message", () => {
	assert.equal(inactiveReason("main", false, "linux", "tui"), "desktop delivery currently requires macOS");
});

test("inactiveReason: returns mode message", () => {
	// ExtensionMode is "tui" | "rpc" | "json" | "print" — a non-TUI mode is what
	// gates delivery, and the reason string names it.
	assert.equal(inactiveReason("main", false, "darwin", "print"), "disabled in print mode");
});
