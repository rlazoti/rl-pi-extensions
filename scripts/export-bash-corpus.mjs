#!/usr/bin/env node
/**
 * Regenerate the bash-command corpus that scan-guard is measured against.
 *
 *   node scripts/export-bash-corpus.mjs [sessionsDir]        # write the fixture
 *   node scripts/export-bash-corpus.mjs --candidates         # print commands to label
 *   node scripts/export-bash-corpus.mjs --candidates --full  # …with the whole command
 *
 * Two files come out of this, and the split is deliberate:
 *
 *   tests/fixtures/bash-commands.jsonl   the corpus. ~8 MB of real commands from
 *       ~/.pi/agent/sessions, one JSON record per unique command. **Git-ignored**:
 *       it is machine-local data (it contains whatever those commands contained,
 *       including paths and arguments that were never meant for a repository). It is
 *       regenerable, so there is nothing to lose by ignoring it, and everything to
 *       lose by committing it.
 *   tests/fixtures/scan-guard-labels.json   the hand-decided answer key. Committed,
 *       because it is the judgement, and the judgement is the part that cannot be
 *       regenerated. Keyed by the id below, so it survives regeneration.
 *
 * What a record holds: `id` (a hash of the command — the stable key; commands repeat
 * across sessions and get one record with `n` > 1), `cmd`, `cwd` (a relative path is
 * a claim about a root, and "cwd was $HOME" is itself a broad scan), `ts`, `dur_ms`
 * and `isError` from the matching tool result (0.1 s is the median call, so the slow
 * ones are the interesting ones), `broad` from the labels file.
 *
 * Scrubbing: the home directory becomes `$HOME` everywhere. It keeps the corpus
 * free of the username in path prefixes, and it happens to test the classifier's
 * `$HOME` spelling too — the recorded commands used `~`, `~/` and `/Users/<user>`.
 * It does not scrub secrets: this file lives on this machine and is never committed.
 *
 * `--candidates` prints commands that *look* like a broad scan (a `find` or `fd` in
 * command position with a `/`, `~` or `$HOME` operand) sorted slowest first. It is
 * deliberately a loose net with its own crude parsing: the point is to find commands
 * the classifier did not see, so an unlabeled candidate appearing after a corpus
 * refresh is the signal to label again. It is not the classifier, and the corpus test
 * does not use it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, "tests", "fixtures", "bash-commands.jsonl");
const LABELS = path.join(ROOT, "tests", "fixtures", "scan-guard-labels.json");
const HOME_DIR = os.homedir();
const SESSIONS =
	process.argv.slice(2).find((a) => !a.startsWith("--")) ?? path.join(HOME_DIR, ".pi", "agent", "sessions");
const CANDIDATES = process.argv.includes("--candidates");
const FULL = process.argv.includes("--full");

const scrub = (s) => String(s).split(HOME_DIR).join("$HOME");
const idOf = (cmd) => crypto.createHash("sha256").update(cmd).digest("hex").slice(0, 16);

// --- session log reading -----------------------------------------------------

function* sessionFiles(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		for (const f of fs.readdirSync(path.join(dir, entry.name))) {
			if (f.endsWith(".jsonl")) yield path.join(dir, entry.name, f);
		}
	}
}

/** Every bash tool call, with the result that answered it (when there was one). */
function readCalls(file) {
	const out = [];
	const pending = new Map();
	let cwd = "";
	for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // a torn final line is normal in a session still being written
		}
		if (entry.type === "session") cwd = entry.cwd ?? "";
		const msg = entry.message;
		if (!msg) continue;
		const when = Date.parse(entry.timestamp ?? "");
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part?.type !== "toolCall" || part.name !== "bash") continue;
				const command = String((part.arguments ?? {}).command ?? "");
				pending.set(part.id, { cmd: command, cwd, ts: entry.timestamp, start: when });
			}
			continue;
		}
		if (msg.role !== "toolResult") continue;
		const call = pending.get(msg.toolCallId);
		if (!call) continue;
		pending.delete(msg.toolCallId);
		out.push({
			...call,
			dur_ms: Number.isFinite(when) && Number.isFinite(call.start) ? when - call.start : null,
			isError: !!msg.isError,
		});
	}
	// A call with no recorded result (aborted, or the process died) is still a command
	// that ran, and the aborted `find /` is one of the four scored by hand.
	for (const call of pending.values()) out.push({ ...call, dur_ms: null, isError: true });
	return out;
}

// --- candidate detection (a loose net, NOT the classifier) -------------------

/** A `find`/`fd` in command position: start of line, after a separator, or after a wrapper. */
const SCAN_TOKEN =
	/(?:^|[;&|\n(]|&&|\|\||\$\(|\b(?:sudo|command|time|env|timeout\s+\d+)\s+)\s*(find|fd)\s*([^)]*?)(?=[;&|\n)]|$)/g;
const BROAD_OPERAND = /^["']?(\/|~\/?|\$\{?HOME\}?|\/Users\/[^/"']+)(?=["']?[\s;)]|$)/;

/**
 * A scan whose root is the working directory is only broad if that directory is
 * `$HOME` — either the session's cwd, or a `cd ~` earlier in the same command. A
 * `cd` to anywhere else makes the root unknown, and unknown is not broad.
 */
function homeRelative(cmd, cwd) {
	const cds = [...cmd.matchAll(/(?:^|[;&|\n])\s*(?:cd|pushd)\s+([^;|\n]+)/g)].map((m) =>
		m[1].trim().replace(/["']/g, "").replace(/\s+.*$/, ""),
	);
	const last = cds[cds.length - 1];
	if (last !== undefined) return last === "~" || last === "./.." || /^\$\{?HOME\}?\/?$/.test(last);
	return cwd === "$HOME";
}

function candidates(cmd, cwd) {
	const hits = [];
	const atHome = homeRelative(cmd, cwd);
	for (const m of cmd.matchAll(SCAN_TOKEN)) {
		const argv = m[2].trim().split(/\s+/);
		// Loose on purpose: every operand is tested, because `fd <pattern> <root>`
		// keeps its root in the *second* positional and a net that only reads the
		// first one missed a real 7 s `fd -H 'jogoforca-port\.md' ~`.
		for (const operand of argv) {
			if (operand.startsWith("-")) continue;
			if (BROAD_OPERAND.test(operand)) hits.push(`${m[1]} ${operand}`);
			else if (atHome && (operand === "." || operand === "./")) hits.push(`${m[1]} . (cwd)`);
		}
		if (argv.length === 0 || (atHome && argv.every((a) => a.startsWith("-")))) hits.push(`${m[1]} (no operand)`);
	}
	return hits;
}

// --- main --------------------------------------------------------------------

if (!fs.existsSync(SESSIONS)) {
	console.error(`no sessions directory at ${SESSIONS}`);
	process.exit(1);
}

const labelDoc = fs.existsSync(LABELS)
	? JSON.parse(fs.readFileSync(LABELS, "utf-8"))
	: { note: "", broad: {} };

const records = new Map();
let calls = 0;
for (const file of sessionFiles(SESSIONS)) {
	for (const call of readCalls(file)) {
		calls++;
		const id = idOf(call.cmd);
		const existing = records.get(id);
		if (existing) {
			existing.n++;
			// Keep the slowest observation: that is the one that shows the cost.
			if ((call.dur_ms ?? -1) > (existing.dur_ms ?? -1)) {
				existing.dur_ms = call.dur_ms;
				existing.isError = call.isError;
			}
			continue;
		}
		records.set(id, {
			id,
			n: 1,
			cmd: call.cmd,
			cwd: scrub(call.cwd),
			ts: call.ts,
			dur_ms: call.dur_ms,
			isError: call.isError,
			broad: Boolean(labelDoc.broad[id]),
		});
	}
}

if (CANDIDATES) {
	const rows = [...records.values()]
		.map((r) => ({ ...r, hits: candidates(r.cmd, r.cwd) }))
		.filter((r) => r.hits.length > 0)
		.sort((a, b) => (b.dur_ms ?? 0) - (a.dur_ms ?? 0));
	console.log(`# ${rows.length} candidates over ${calls} calls (${records.size} unique)`);
	console.log(`# label the real ones in ${path.relative(ROOT, LABELS)} by id, then re-run this script without --candidates`);
	for (const r of rows) {
		const secs = r.dur_ms === null ? "  no result" : `${(r.dur_ms / 1000).toFixed(1)}s`.padStart(9);
		console.log(
			`${r.broad ? "BROAD " : "      "}${r.id}  ${r.ts}  ${secs}${r.isError ? " isError" : ""}  cwd=${r.cwd}  [${r.hits.join(" | ")}]${FULL ? "\n    " + r.cmd.replace(/\s+/g, " ").slice(0, 2000) : "\n    " + r.cmd.replace(/\s+/g, " ").slice(0, 160)}`,
		);
	}
	process.exit(0);
}

const unlabeled = [...records.values()].filter((r) => r.broad && !labelDoc.broad[r.id]).length;
fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
const out = [...records.values()]
	.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
	.map((r) => JSON.stringify(r));
fs.writeFileSync(FIXTURE, out.join("\n") + "\n", "utf-8");

const labelled = Object.keys(labelDoc.broad);
const all = [...records.values()];
const missing = labelled.filter((id) => !records.has(id));
console.log(`wrote ${path.relative(ROOT, FIXTURE)}`);
console.log(
	`  ${calls} bash calls, ${records.size} unique commands, ${(fs.statSync(FIXTURE).size / 1e6).toFixed(1)} MB`,
);
console.log(`  ${all.filter((r) => r.broad).length} labelled broad of ${labelled.length} ids in the label file`);
if (missing.length) console.log(`  WARNING: ${missing.length} labelled ids are no longer in the corpus: ${missing.join(", ")}`);
if (unlabeled) console.log(`  NOTE: ${unlabeled} commands match a broad label but were not labelled (stale ids?)`);
const cands = [...records.values()].filter((r) => !r.broad && candidates(r.cmd, r.cwd).length > 0);
console.log(`  ${cands.length} unlabelled commands look like broad scans (re-run with --candidates)`);
