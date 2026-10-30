/**
 * scan-guard — refuse a bash command whose purpose is to walk the whole machine,
 * and answer the question it was asking instead.
 *
 * A `tool_call` hook on `bash`. It decides with `classify.ts` (a pure function)
 * and acts here: block with the reason the agent will read, notify the human,
 * and write one line per event to a log the human can delete.
 *
 * ## Modes, and why the off-switch is not in the command
 *
 * `PI_SCAN_GUARD` is read once, at load:
 *
 *   unset / `log`   notify-only — the default, and the only mode on day one. The
 *                   scan still runs; the human hears about it and the agent gets
 *                   nothing. A week of that measures false positives on commands
 *                   the corpus never contained.
 *   `block`         refuse the ones `classify.ts` calls a hunt.
 *   `off`           do nothing at all, without uninstalling.
 *
 * There is deliberately no in-command marker, no "just this once" token, and no
 * env var the command itself can set: `co-authored-by-ai` shipped a guard that
 * stood down for `/co-authored-by:/i` and then went silent for twelve commits
 * because an agent typed a lookalike. An off-switch has to live somewhere the
 * model is not typing per call.
 *
 * ## The one failure mode that matters
 *
 * A `tool_call` handler that throws blocks the tool as a fail-safe (Pi 1.4.0
 * docs/extensions.md:375). A bug in this file would therefore stop every `bash`
 * call in the session, not just the scans. So the handler catches everything and
 * returns `undefined`, twice over: once around the decision and once around the
 * log, which is a side activity and never a reason to block a command.
 */

import { execFile } from "node:child_process";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { verdictForCommand, type ScanEnv, type Verdict } from "./classify.js";

export type ScanGuardMode = "off" | "log" | "block";

export function parseMode(value: string | undefined): ScanGuardMode {
	const v = (value ?? "").trim().toLowerCase();
	if (v === "off" || v === "0" || v === "false") return "off";
	if (v === "block" || v === "on" || v === "1" || v === "true") return "block";
	return "log";
}

/** Where the log lives: inside the directory the human already manages. */
export const LOG_DIR = join(homedir(), ".pi", "scan-guard");
let logDir = LOG_DIR;
/** The log can be moved (`PI_SCAN_GUARD_DIR`) — a file that cannot be relocated is a file that cannot be deleted. */
if (process.env.PI_SCAN_GUARD_DIR) logDir = process.env.PI_SCAN_GUARD_DIR;
export function setLogDirForTesting(dir: string | null): void {
	logDir = dir ?? LOG_DIR;
}
const logFile = (dir = logDir) => join(dir, "log.jsonl");
/** A cap, not rotation (knowledge/telemetry-defaults.md): filling a disk is worse than losing the log. */
export const LOG_CAP_BYTES = 256 * 1024;

/** The roots a scoped search is pointed at: here first, then the three places a file usually is. */
export function defaultScopedRoots(cwd: string, home: string): string[] {
	return [cwd, join(home, "Projects"), join(home, ".pi"), join(home, "Downloads")];
}

// --- seams: Node's test runner cannot mock ESM modules -----------------------

/** Narrower than node's child_process — only the form this file uses. */
export type ExecFileFn = (command: string, args: readonly string[], options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => void;
let execFileFn: ExecFileFn = execFile as unknown as ExecFileFn;
export function setExecFileForTesting(fn: ExecFileFn | null): void {
	if (fn) execFileFn = fn;
}

/** Whether `fd` is installed, probed once per process and remembered either way. */
let fdProbe: Promise<boolean> | null = null;
/** Three-valued, for the status line: unknown until probed, then yes or no. */
let fdKnown: boolean | null = null;
export function probeFd(): Promise<boolean> {
	fdProbe ??= new Promise<boolean>((resolve) => {
		const done = (present: boolean) => {
			fdKnown = present;
			resolve(present);
		};
		try {
			execFileFn("/bin/sh", ["-c", "command -v fd"], { timeout: 2000 }, (error, stdout) => {
				done(!error && stdout.trim().length > 0);
			});
		} catch {
			done(false); // a probe that cannot run is not a reason to suggest a missing binary
		}
	});
	return fdProbe;
}
export function setFdForTesting(present: boolean | null): void {
	fdProbe = present === null ? null : Promise.resolve(present);
	fdKnown = present;
}

// --- the log ------------------------------------------------------------------

export interface LogEvent {
	/** The verdict the classifier reached, whether or not it was acted on. */
	verdict: "block" | "warn";
	/** `fd` or `find`. */
	tool: string;
	/** The broad root, expanded: the decision, without the command that carried it. */
	root: string;
	depth: number | null;
	mode: ScanGuardMode;
	/** What was suggested, which is the useful half of the record. */
	suggestion: string;
	/** The command, only when the human opted into keeping words. */
	command?: string;
}

/**
 * One JSON line per event. Contents are opt-in and the decision is separable from
 * the words from the start: `root`, `tool`, `depth` and `suggestion` are enough to
 * count false positives, and a count does not need the agent's command line.
 *
 * Never throws: a logger that can fail a turn is worse than no logger.
 */
export function appendLog(event: LogEvent, dir = logDir, cap = LOG_CAP_BYTES): void {
	try {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const file = logFile(dir);
		if (existsSync(file) && statSync(file).size > cap) return; // capped; status says so
		const line = JSON.stringify({ t: new Date().toISOString(), ...event });
		appendFileSync(file, line.slice(0, 2000) + "\n", "utf8");
	} catch {
		// The log is not worth an error dialog, let alone a blocked command.
	}
}

export function logIsCapped(dir = logDir, cap = LOG_CAP_BYTES): boolean {
	try {
		const file = logFile(dir);
		return existsSync(file) && statSync(file).size > cap;
	} catch {
		return false;
	}
}

/** Read the tail of the log for `/scan-guard status`. Broken lines are skipped, never fatal. */
export function readLogEvents(limit: number, dir = logDir): LogEvent[] {
	const out: LogEvent[] = [];
	try {
		const file = logFile(dir);
		if (!existsSync(file)) return [];
		const lines = readTail(file, 64 * 1024).split("\n");
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as LogEvent;
				if (parsed && typeof parsed.verdict === "string") out.push(parsed);
			} catch {
				// a torn final line is normal
			}
		}
	} catch {
		return out;
	}
	return out.slice(-limit);
}

function readTail(file: string, bytes: number): string {
	// Reading the whole file would be fine at 256 KB and silly at anything bigger.
	const fd = openSync(file, "r");
	try {
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - bytes);
		const buffer = Buffer.alloc(Math.min(size, bytes));
		readSync(fd, buffer, 0, buffer.length, start);
		return buffer.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

// --- the session record -------------------------------------------------------

export interface SessionStats {
	mode: ScanGuardMode;
	/** bash calls looked at, and the ones that were scans. */
	seen: number;
	hits: number;
	blocked: number;
	last: Array<{ verdict: string; root: string; suggestion: string }>;
}

// --- the extension ------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const mode = parseMode(process.env.PI_SCAN_GUARD);
	const keepCommands = (process.env.PI_SCAN_GUARD_LOG ?? "").trim().toLowerCase() === "full";
	const home = homedir();
	const stats: SessionStats = { mode, seen: 0, hits: 0, blocked: 0, last: [] };

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		if (mode === "off") return;
		if (!isToolCallEventType("bash", event)) return;
		let decision: Verdict | null = null;
		try {
			const command = String((event.input as { command?: unknown }).command ?? "");
			if (!command) return;
			stats.seen++;
			const env: ScanEnv = {
				cwd: ctx.cwd,
				home,
				hasFd: await probeFd(),
				scopedRoots: defaultScopedRoots(ctx.cwd, home),
			};
			decision = verdictForCommand(command, env);
		} catch {
			// Fail open. A guard that cannot parse is not a guard, but it is also not
			// a wall — and a throw here is a wall around every bash call in the session.
			return;
		}

		if (!decision || decision.action === "allow") return;
		stats.hits++;
		const { finding, suggestion, reason } = decision;
		if (decision.action === "block" && mode === "block") stats.blocked++;
		if (stats.last.length > 8) stats.last.shift();
		stats.last.push({ verdict: decision.action, root: finding.rootPath, suggestion });

		// Both side activities are optional: a log directory that cannot be written
		// and a UI that cannot notify must not become a blocked command, and must
		// certainly not become the fail-safe around every bash call in the session.
		try {
			appendLog({
				verdict: decision.action,
				tool: finding.tool,
				root: finding.rootPath,
				depth: finding.depth,
				mode,
				suggestion,
				...(keepCommands ? { command: String((event.input as { command?: unknown }).command ?? "").slice(0, 500) } : {}),
			});
			// The human hears it either way; the agent hears it only when it is stopped,
			// because in notify-only mode nothing happened to its command.
			// A warning is for something that actually stopped; in notify-only mode the
			// command ran and this is an observation.
			ctx.ui.notify(reason, mode === "block" && decision.action === "block" ? "warning" : "info");
		} catch {
			// Nothing to do here. The verdict above is already decided and logged.
		}
		if (decision.action === "block" && mode === "block") {
			// `terminate` is never set: the agent is supposed to carry on with the
			// scoped command, and a batch is only stopped when every result asks for it.
			return { block: true, reason };
		}
	});

	pi.registerCommand("scan-guard", {
		description: "Show what scan-guard is doing, and what it refused this session",
		handler: async (_args, ctx: ExtensionContext) => {
			const recent = readLogEvents(3);
			const lines = [
				`scan-guard — mode: ${stats.mode}${stats.mode === "log" ? " (notify-only; set PI_SCAN_GUARD=block to refuse)" : ""}`,
				`this session: ${stats.seen} bash calls read, ${stats.hits} broad scans, ${stats.blocked} blocked`,
				`fd available: ${fdKnown === null ? "not probed yet" : fdKnown ? "yes" : "no — suggestions use find"}`,
				`log: ${logFile()}${logIsCapped() ? " — CAPPED, nothing new is being written" : ""}`,
				`contents logged: ${keepCommands ? "yes (PI_SCAN_GUARD_LOG=full)" : "no (decisions only)"}, roots suggested: ${defaultScopedRoots(ctx.cwd, home).join(" ")}`,
			];
			if (stats.last.length > 0) {
				lines.push("last this session:");
				for (const e of stats.last.slice(-3)) lines.push(`  ${e.verdict} ${e.root}`);
			}
			if (recent.length > 0) {
				lines.push("last from the log:");
				for (const e of recent) lines.push(`  ${e.verdict} ${e.tool} ${e.root} → ${e.suggestion}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
