#!/usr/bin/env node
/**
 * End-to-end load smoke test against the real Pi runtime.
 *
 * Starts `pi --mode rpc --no-session --no-extensions -e <this repo>/index.ts`
 * with PI_MEMORY_DIR pointed at a throwaway directory (so the run never touches
 * the default ~/.pi/memory3 bank), sends the slash commands over JSONL, and
 * requires of each:
 *
 *   1. a `handled` prompt response — the command is registered;
 *   2. an `extension_ui_request` / `notify` record whose message reports the
 *      throwaway bank path — the command ran against it;
 *   3. for `/memory`, the scaffolded files on disk — first-run scaffolding wrote.
 *
 * No model request is made: extension commands are handled by Pi itself, so
 * this works offline and costs nothing. Exits non-zero with captured stderr on
 * timeout or mismatch.
 *
 * Usage: npm run smoke [-- --pi /path/to/pi]
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 90_000;
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(projectDir, "index.ts");

const argv = process.argv.slice(2);
const piFlag = argv.indexOf("--pi");
const PI_BIN = piFlag === -1 ? "pi" : argv[piFlag + 1];

const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-smoke-"));

let child;
try {
	child = spawn(
		PI_BIN,
		["--mode", "rpc", "--no-session", "--no-extensions", "--offline", "--extension", extensionPath],
		{ cwd: projectDir, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_MEMORY_DIR: memoryDir, PI_MEMORY_QMD: "/nonexistent/qmd-off-in-smoke" } },
	);
} catch (error) {
	fs.rmSync(memoryDir, { recursive: true, force: true });
	console.error(`FAIL: cannot start "${PI_BIN}": ${error.message}`);
	process.exit(1);
}

let stdoutBuffer = "";
let stderrText = "";
let promptHandled = false;
const notifications = [];

function done(code, message) {
	clearTimeout(timer);
	if (message) console[code === 0 ? "log" : "error"](message);
	child.stdin.end();
	child.kill("SIGTERM");
	fs.rmSync(memoryDir, { recursive: true, force: true });
	process.exit(code);
}

/**
 * Slash commands to send in order, and what each answer must contain.
 *
 * `/memory doctor` warns about missing knowledge on a freshly scaffolded bank —
 * that is the point of it — so a warning level is the expected answer here.
 */
const PROBES = [
	{
		prompt: "/memory",
		needle: "Memory bank:",
		level: "info",
		required: [memoryDir, "activeProjects.md:", "knowledge files:", "search index:", "log:"],
	},
	{
		prompt: "/memory doctor",
		needle: "memory doctor —",
		level: "warning",
		required: ["no knowledge files", "dailyContext.md", "bank size:"],
	},
	// The usage log ships off, and a stranger's first run must not start recording
	// prompts. Its status dialog is where the option is explained.
	{
		prompt: "/memory log",
		needle: "Usage log is off",
		level: "info",
		required: ["logs", "one JSON line per event"],
	},
	// The two opt-in features must answer on a bank that has not opted in, and say what
	// would have to be set: a command that only works once configured is not a command.
	{
		prompt: "/memory scope",
		needle: "Override with /memory config scope.name",
		level: "info",
		required: ["mode off", "flat/shared knowledge remain global"],
	},
	{
		prompt: "/memory revisions",
		needle: "Revision history off",
		level: "info",
		required: ["0 snapshot(s)", "Restore: /memory restore <file> <id>"],
	},
];
let probe = 0;
let promptsSent = 0;

function sendPrompt(message, id) {
	promptsSent++;
	child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
}

function checkScaffold() {
	const expected = ["core/activeProjects.md", "core/dailyContext.md"];
	const missing = expected.filter((rel) => !fs.existsSync(path.join(memoryDir, rel)));
	// knowledge/index.csv was the pre-search trigger-word routing table. Nothing
	// reads it, so first run must not create one.
	if (fs.existsSync(path.join(memoryDir, "knowledge", "index.csv"))) {
		missing.push("knowledge/index.csv (must not be scaffolded)");
	}
	return missing;
}

function evaluate() {
	if (!promptHandled) return;
	const spec = PROBES[probe];
	const notice = notifications.find((n) => n.message.includes(spec.needle));
	if (!notice) return;

	const missing = spec.required.filter((needle) => !notice.message.includes(needle));
	if (missing.length > 0) {
		done(1, `FAIL: ${spec.prompt} missing ${JSON.stringify(missing)}.\nGot: ${notice.message}`);
		return;
	}
	if (notice.notifyType !== spec.level) {
		done(1, `FAIL: ${spec.prompt} expected a ${spec.level} notify, got ${JSON.stringify(notice.notifyType)}.\nGot: ${notice.message}`);
		return;
	}

	probe++;
	if (probe < PROBES.length) {
		promptHandled = false;
		sendPrompt(PROBES[probe].prompt, `smoke-probe-${probe}`);
		return;
	}

	const unscaffolded = checkScaffold();
	if (unscaffolded.length > 0) {
		done(1, `FAIL: scaffolding did not write ${JSON.stringify(unscaffolded)} under ${memoryDir}`);
		return;
	}

	done(
		0,
		`PASS: ${PROBES.map((p) => p.prompt).join(", ")} loaded against a real Pi, reported the bank at ${memoryDir}, and scaffolded it.\n\n` +
			notifications.map((n) => n.message).join("\n---\n"),
	);
}

child.stderr.on("data", (chunk) => {
	stderrText += chunk;
});

child.on("error", (error) => {
	done(1, `FAIL: cannot start "${PI_BIN}": ${error.message}`);
});

child.on("exit", (code, signal) => {
	done(1, `FAIL: pi exited (${code ?? signal}) before the check completed.\nstderr:\n${stderrText}`);
});

const timer = setTimeout(
	() =>
		done(
			1,
			`FAIL: no matching notify within ${TIMEOUT_MS / 1000}s.\n` +
				`probe=${probe} promptHandled=${promptHandled} promptsSent=${promptsSent} notifications=${JSON.stringify(notifications)}\nstderr:\n${stderrText}`,
		),
	TIMEOUT_MS,
);

child.stdout.on("data", (chunk) => {
	stdoutBuffer += chunk;
	// Protocol framing is LF-only (U+2028/U+2029 are valid inside JSON strings).
	for (;;) {
		const index = stdoutBuffer.indexOf("\n");
		if (index === -1) return;
		const line = stdoutBuffer.slice(0, index).replace(/\r$/, "");
		stdoutBuffer = stdoutBuffer.slice(index + 1);
		if (line.trim() === "") continue;

		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}

		if (record.type === "extension_ui_request") {
			if (record.method !== "notify") {
				done(1, `FAIL: unexpected dialog from the extension: ${line}`);
				continue;
			}
			notifications.push(record);
			evaluate();
			continue;
		}

		if (record.type === "response" && record.command === "prompt") {
			if (!record.success) {
				done(1, `FAIL: prompt command rejected: ${record.error}\nstderr:\n${stderrText}`);
				continue;
			}
			if (record.data?.disposition !== "handled") {
				done(1, `FAIL: expected disposition "handled", got ${JSON.stringify(record.data)} — is /memory registered?`);
				continue;
			}
			promptHandled = true;
			evaluate();
			continue;
		}
	}
});

sendPrompt("/memory", "smoke-1");
