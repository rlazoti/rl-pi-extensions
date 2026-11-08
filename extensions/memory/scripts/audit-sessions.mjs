#!/usr/bin/env node
/**
 * Read-only audit of real Pi sessions, for the one question a unit test cannot
 * answer: is this extension still telling agents where things are?
 *
 *   npm run audit            # or: node scripts/audit-sessions.mjs [sessionsDir]
 *
 * Three numbers, read out of `~/.pi/agent/sessions` (pass another directory to
 * point it elsewhere). Nothing is written and nothing outside the session files is
 * read — in particular this script never walks the filesystem, which is the habit it
 * exists to count.
 *
 * 1. Whether every memory result that names a place names the *whole* place. The
 *    four strings in `index.ts` should read 100% from the day they shipped and 0%
 *    before, and a month from now "we fixed that" is worth less than a number.
 * 2. Bank-shaped writes that landed outside the bank — the incident the change is
 *    for. Expected: rare, and flat regardless of what section 1 says.
 * 3. Broad scans (`find /`, `find ~`) and what they cost. This is context, not a
 *    target: it will not go to zero, and most of it was never ours. It is only
 *    supposed to stop being caused by a memory tool that hid its own root.
 *
 * Method notes, because the first pass at this kind of audit printed two numbers
 * that were not true:
 *   - Read the WHOLE result text. In a compound command the interesting line is
 *     rarely inside the first 200 characters, and a trailing `echo "(search done)"`
 *     looks exactly like an empty result to a classifier that stopped early. So no
 *     outcome is computed here: the slowest calls print with the tail of their
 *     output and are scored by whoever is reading, which is how the four `find /`
 *     calls were finally scored right (one of four found anything).
 *   - A tool result carries no duration. Timings come from the call's timestamp
 *     subtracted from its result's, and calls that run in one turn finish together,
 *     so the total is taken per finishing turn: the 2026-10-17 pair below waited
 *     92 minutes, not 184. A call with no result is counted apart, never as 0 s.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SESSIONS = process.argv[2] ?? path.join(os.homedir(), ".pi", "agent", "sessions");
const HOME_DIR = os.homedir();

/** The four results in index.ts that name a place, and the tool that writes each. */
const PLACE_RESULTS = [
	{ tool: "memory_update", label: "memory_update wrote", re: /^Updated \S+ \(\d+ bytes\)/ },
	{ tool: "memory_append", label: "memory_append wrote", re: /^Appended to ".*?" in \S+/ },
	{ tool: "memory_read", label: "memory_read file not found", re: /^File not found: / },
	{ tool: "memory_append", label: "memory_append no such section", re: /^Section ".*?" not found in / },
];

/** A `.md` whose first path segment is one of the bank's own top-level directories. */
const BANK_SHAPED = /^(?:\.\/)?(knowledge|core|history)\/.*\.md$/i;
/** The live bank, by the same rule index.ts uses — this is not a search for one. */
const BANK = process.env.PI_MEMORY_DIR ?? path.join(HOME_DIR, ".pi", "memory3");
/** Retired roots still on this disk. A write here is lost twice: wrong project, wrong bank. */
const DEAD_BANKS = ["memory", "memory-x", "memory-bkp"].map((d) => path.join(HOME_DIR, ".pi", d));

/** `find` aimed at the disk root or at all of $HOME — narrower roots are not this habit. */
const BROAD_FIND = () => /(?:^|[\s;&|(])find\s+("[^"]*"|'[^']*'|\/|~\/?|\$HOME\/?)(?=[\s;)]|$)/g;

function broadFindRoots(command) {
	const roots = [];
	for (const match of String(command).matchAll(BROAD_FIND())) {
		let root = match[1].replace(/^["']|["']$/g, "");
		if (root === "~" || root === "~/" || root === "$HOME" || root === "$HOME/") root = HOME_DIR;
		if (root === "/") roots.push("/");
		else if (root === HOME_DIR) roots.push("~");
	}
	return roots;
}

const files = [];
/**
 * One transcript can be enormous. A settle-guard e2e run on 2026-11-01 left a 516 MB session
 * file in `--private-tmp-sg-e2e--`, and `readFileSync` throws `ERR_STRING_TOO_LONG` past ~512 MB
 * — which killed the audit at its first file, so the report was not empty-but-partial, it was
 * nothing. Skipping is a real cost (those calls are counted nowhere), so the size that gets
 * skipped and the file that was are both printed.
 */
const MAX_AUDIT_FILE_BYTES = 128 * 1024 * 1024;
const skipped = [];
for (const dir of fs.readdirSync(SESSIONS)) {
	const abs = path.join(SESSIONS, dir);
	let st;
	try {
		st = fs.statSync(abs);
	} catch {
		continue;
	}
	if (!st.isDirectory()) continue;
	for (const f of fs.readdirSync(abs)) {
		if (!f.endsWith(".jsonl")) continue;
		const p = path.join(abs, f);
		let size = 0;
		try {
			size = fs.statSync(p).size;
		} catch {
			continue;
		}
		if (size > MAX_AUDIT_FILE_BYTES) {
			skipped.push({ p, size });
			continue;
		}
		files.push(p);
	}
}

/** month → { total, absolute, byLabel } */
const placeResults = new Map();
/** bank-shaped writes that resolved outside the bank */
const misplaced = [];
/** broad scans, one row per bash call that ran one */
const scans = [];
let calls = 0;

for (const file of files) {
	const pending = new Map(); // toolCallId → { name, args, ts }
	let cwd = ""; // the session's own cwd: a relative tool path is relative to this
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
				if (part?.type !== "toolCall") continue;
				const args = part.arguments ?? {};
				calls++;
				pending.set(part.id, { name: part.name, args, ts: when });

				if (part.name !== "write" && part.name !== "edit") continue;
				const target = args.path;
				if (typeof target !== "string" || !BANK_SHAPED.test(target)) continue;
				const full = path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);
				if (full === BANK || full.startsWith(BANK + path.sep)) continue;
				const retired = DEAD_BANKS.some((b) => full === b || full.startsWith(b + path.sep));
				misplaced.push({ ts: entry.timestamp, name: part.name, cwd, target, full, retired });
			}
			continue;
		}

		if (msg.role !== "toolResult") continue;
		const call = pending.get(msg.toolCallId);
		pending.delete(msg.toolCallId);
		// The whole text, joined — not a prefix, and not just the first block.
		const text = (msg.content ?? []).map((c) => (c?.type === "text" ? c.text : "")).join("\n");

		const spec = PLACE_RESULTS.find((s) => s.tool === msg.toolName && s.re.test(text));
		if (spec) {
			const month = (entry.timestamp ?? "").slice(0, 7);
			const row = placeResults.get(month) ?? { total: 0, absolute: 0, byLabel: {} };
			const absolute = text.includes(HOME_DIR + path.sep) ? 1 : 0;
			row.total++;
			row.absolute += absolute;
			const per = (row.byLabel[spec.label] ??= { total: 0, absolute: 0 });
			per.total++;
			per.absolute += absolute;
			placeResults.set(month, row);
			continue;
		}

		if (msg.toolName !== "bash" || !call) continue;
		const command = String(call.args?.command ?? "");
		const roots = broadFindRoots(command);
		if (roots.length === 0) continue;
		scans.push({
			ts: entry.timestamp,
			seconds: Number.isFinite(when) && Number.isFinite(call.ts) ? (when - call.ts) / 1000 : null,
			root: roots.join(","),
			// A bounded walk of $HOME is still $HOME, but a shallow one is cheap — 75 ms
			// at `-maxdepth 3` against 49 s unbounded — so this is shown, not filtered.
			maxdepth: (command.match(/-maxdepth\s+(\d+)/) ?? [])[1] ?? null,
			isError: !!msg.isError,
			command: command.replace(/\s+/g, " "),
			outputTail: text.slice(-220).replace(/\s+/g, " "),
		});
	}
	// Called and never answered: killed, aborted, or the process died mid-call.
	for (const [, call] of pending) {
		const command = String(call.args?.command ?? "");
		for (const root of broadFindRoots(command)) {
			scans.push({ ts: "?", seconds: null, root, maxdepth: null, isError: true, command: command.replace(/\s+/g, " "), outputTail: "(no result recorded)" });
		}
	}
}

const pct = (n, d) => (d === 0 ? "—" : `${Math.round((100 * n) / d)}%`);
console.log(`sessions: ${files.length} files, ${calls} tool calls, read from ${SESSIONS}`);
if (skipped.length > 0) {
	console.log(
		`   skipped ${skipped.length} file(s) over ${(MAX_AUDIT_FILE_BYTES / 1024 / 1024).toFixed(0)} MB — their tool calls are in no number above:`,
	);
	for (const s of skipped) console.log(`   ${(s.size / 1024 / 1024).toFixed(0)} MB  ${s.p}`);
}
console.log(`bank: ${BANK}\n`);

console.log("1. memory results naming a place that name the whole place");
for (const month of [...placeResults.keys()].sort()) {
	const r = placeResults.get(month);
	console.log(`   ${month}  ${r.absolute}/${r.total}  (${pct(r.absolute, r.total)})`);
	for (const [label, n] of Object.entries(r.byLabel)) console.log(`        ${label}: ${n.absolute}/${n.total}`);
}
if (placeResults.size === 0) console.log("   (none yet)");

console.log("\n2. bank-shaped writes that landed outside the bank");
for (const m of misplaced) {
	console.log(`   ${m.ts}  ${m.name}  ${m.target}  (cwd ${m.cwd})`);
	console.log(`        → ${m.full}${m.retired ? "  — a retired bank, invisible to this one" : ""}`);
}
if (misplaced.length === 0) console.log("   none");

const scored = scans.filter((s) => s.seconds !== null).sort((a, b) => b.seconds - a.seconds);
const unfinished = scans.length - scored.length;
// One turn can issue several scans and they run together, so wall time is summed
// per finishing turn. Reporting the sum of durations would bill 184 minutes for
// the 92-minute pair below.
const byTurn = new Map();
for (const s of scored) byTurn.set(s.ts, Math.max(byTurn.get(s.ts) ?? 0, s.seconds));
const total = [...byTurn.values()].reduce((a, b) => a + b, 0);
console.log(
	`\n3. broad scans: ${scans.length} calls (${unfinished} never answered), ` +
	`${Math.round(total).toLocaleString()} s of wall time over ${byTurn.size} turn(s)`,
);
console.log("   outcome is not computed — read the tail and judge. Slowest first:\n");
for (const s of scored.slice(0, 5)) {
	const flags = [s.maxdepth ? `-maxdepth ${s.maxdepth}` : "", s.isError ? "isError" : ""].filter(Boolean).join("  ");
	console.log(`   ${s.ts}  ${Math.round(s.seconds).toLocaleString()} s  root ${s.root}${flags ? `  ${flags}` : ""}`);
	console.log(`      $ ${s.command.slice(0, 200)}`);
	console.log(`      … ${s.outputTail}\n`);
}
