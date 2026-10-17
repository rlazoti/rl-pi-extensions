import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	appendDailyItem,
	dailyArchiveFiles,
	dailyFile,
	dailyStatus,
	openItems,
	parseDaily,
	readDaily,
	renderDaily,
	rolloverDaily,
	DAILY_SECTIONS,
} from "./daily.ts";
import { bankPaths, ensureBankDirs } from "./store.ts";

function scratch(): { paths: ReturnType<typeof bankPaths>; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "memory-daily-"));
	const paths = bankPaths(dir);
	ensureBankDirs(paths);
	return { paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const clockAt = (iso: string) => () => new Date(iso);

const CANONICAL = `# Daily log — 2026-10-16

## completed
- (2026-10-16 09:10) Wrote the grammar module.

## in_progress
- (2026-10-16 21:05) Wire the injector.

## carry
- (2026-10-15 17:30) inbox GC is still unowned.

## decision
- (2026-10-16 09:12) Branch: rewrite from scratch, delete the old component here.

## note
- an item another tool wrote without a stamp
`;

test("daily: a hand-written log renders back byte for byte (R6)", () => {
	const parsed = parseDaily(CANONICAL, "daily/today.md", "2026-10-16");
	assert.deepEqual(parsed.issues, []);
	assert.equal(parsed.day, "2026-10-16");
	assert.equal(renderDaily(parsed), CANONICAL);
	const again = parseDaily(renderDaily(parsed), "daily/today.md", "2026-10-16");
	assert.equal(renderDaily(again), CANONICAL);
});

test("daily: memory_log stamps date and time itself; the agent never sets them (R15)", () => {
	const { paths, cleanup } = scratch();
	try {
		const first = appendDailyItem(paths, { section: "in_progress", text: "Wire   the injector.", clock: clockAt("2026-10-16T21:05:00") });
		assert.equal(first.item.stamp, "2026-10-16 21:05");
		assert.equal(first.item.text, "Wire the injector.", "whitespace is collapsed on the way in");
		const second = appendDailyItem(paths, { section: "completed", text: "Grammar module.", clock: clockAt("2026-10-16T21:40:00") });
		assert.equal(second.item.stamp, "2026-10-16 21:40");
		const text = readFileSync(dailyFile(paths), "utf8");
		assert.equal(text, renderDaily(readDaily(paths, "2026-10-16")), "what was written is what the reader sees");
		// R16: the file carries items and nothing else — no auto-persist or summary lines.
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			assert.ok(
				/^# Daily log — \d{4}-\d{2}-\d{2}$/.test(line) || /^## [a-z_]+$/.test(line) || /^- \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\) /.test(line),
				`unexpected line in the daily log: ${line}`,
			);
		}
		assert.ok(!/auto[- ]persist|session summary/i.test(text));
	} finally {
		cleanup();
	}
});

test("daily: only the five sections are accepted", () => {
	const { paths, cleanup } = scratch();
	try {
		assert.throws(() => appendDailyItem(paths, { section: "todo", text: "x", clock: clockAt("2026-10-16T10:00:00") }), /section must be one of completed, in_progress, carry, decision, note/);
		assert.throws(() => appendDailyItem(paths, { section: "note", text: "   ", clock: clockAt("2026-10-16T10:00:00") }), /text is required/);
		assert.deepEqual([...DAILY_SECTIONS], ["completed", "in_progress", "carry", "decision", "note"]);
	} finally {
		cleanup();
	}
});

test("daily: an un-stamped item is read, dated from the file, and counted as coarse", () => {
	const parsed = parseDaily(CANONICAL, "daily/today.md", "2026-10-16");
	const note = parsed.items.find((item) => item.section === "note")!;
	assert.equal(note.undated, true);
	assert.equal(note.stamp, "2026-10-16");
	assert.equal(note.text, "an item another tool wrote without a stamp");
});

test("daily: damage in a hand-written log is reported with its line", () => {
	const broken = `# Daily log — 2026-10-16

## someday
- (2026-10-16 10:00) In a section that does not exist.

prose outside a section

## note
- (2026-10-16 10:00) a first item
    and its wrapped continuation
`;
	const parsed = parseDaily(broken, "daily/today.md", "2026-10-16");
	assert.deepEqual(parsed.issues.map((issue) => issue.line), [3, 4, 6]);
	assert.match(parsed.issues[0]!.message, /unknown section "someday"/);
	assert.match(parsed.issues[1]!.message, /is outside any section/);
	assert.match(parsed.issues[2]!.message, /"prose outside a section" is outside any section/);
	assert.deepEqual(parsed.items.map((item) => item.text), ["a first item and its wrapped continuation"]);
});

test("daily: a missing header is an issue unless the file names the day", () => {
	const parsed = parseDaily("## note\n- (2026-10-16 10:00) No header.\n", "daily/archive/2026-10/2026-10-16.md");
	assert.equal(parsed.day, "");
	assert.match(parsed.issues[0]!.message, /no "# Daily log — YYYY-MM-DD" header/);
	const withFallback = parseDaily("## note\n- (2026-10-16 10:00) No header.\n", "daily/today.md", "2026-10-16");
	assert.deepEqual(withFallback.issues, []);
	assert.equal(withFallback.day, "2026-10-16");
});

test("daily: open items are in_progress and carry, in the order written (R27.2)", () => {
	const parsed = parseDaily(CANONICAL, "daily/today.md", "2026-10-16");
	assert.deepEqual(openItems(parsed).map((item) => `${item.section}: ${item.text}`), ["in_progress: Wire the injector.", "carry: inbox GC is still unowned."]);
});

test("daily: rollover archives the old day and carries the open work", () => {
	const { paths, cleanup } = scratch();
	try {
		writeFileSync(dailyFile(paths), CANONICAL);
		const result = rolloverDaily(paths, { today: "2026-10-17" });
		assert.equal(result.archivedTo, join(paths.dailyArchive, "2026-10", "2026-10-16.md"));
		assert.equal(result.carried, 2);
		assert.equal(result.futureDated, false);
		assert.equal(readFileSync(result.archivedTo!, "utf8"), CANONICAL, "the archived day keeps every word, including finished work");
		const fresh = readDaily(paths, "2026-10-17");
		assert.equal(fresh.day, "2026-10-17");
		assert.deepEqual(openItems(fresh).map((item) => item.stamp), ["2026-10-16 21:05", "2026-10-15 17:30"], "carried items keep the date they were written on");
		assert.deepEqual(fresh.items.filter((item) => item.section === "completed"), [], "finished work does not follow you into a new day");
		assert.deepEqual(dailyArchiveFiles(paths), [join(paths.dailyArchive, "2026-10", "2026-10-16.md")]);
	} finally {
		cleanup();
	}
});

test("daily: rollover is a no-op on the same day, and never archives a future-dated log", () => {
	const { paths, cleanup } = scratch();
	try {
		writeFileSync(dailyFile(paths), CANONICAL);
		const same = rolloverDaily(paths, { today: "2026-10-16" });
		assert.equal(same.archivedTo, undefined);
		assert.equal(same.reason, "already today's log");
		assert.ok(existsSync(dailyFile(paths)));

		// A clock that moved backwards must not turn today's work into an archive entry.
		const future = rolloverDaily(paths, { today: "2026-10-15" });
		assert.equal(future.futureDated, true);
		assert.match(future.reason!, /dated 2026-10-16, after today \(2026-10-15\) — not archived/);
		assert.deepEqual(dailyArchiveFiles(paths), []);
		assert.match(readFileSync(dailyFile(paths), "utf8"), /Wire the injector/, "the log is left exactly where it was");
	} finally {
		cleanup();
	}
});

test("daily: an unreadable or missing log is reported, not invented", () => {
	const { paths, cleanup } = scratch();
	try {
		assert.deepEqual(rolloverDaily(paths, { today: "2026-10-17" }), { carried: 0, reason: "no daily log yet", futureDated: false });
		writeFileSync(dailyFile(paths), "no header, no sections, just prose\n");
		const result = rolloverDaily(paths, { today: "2026-10-17" });
		assert.match(result.reason!, /does not say which day it is/);
		assert.deepEqual(dailyArchiveFiles(paths), []);
	} finally {
		cleanup();
	}
});

test("daily: a second archive slot for one day takes the name beside it", () => {
	const { paths, cleanup } = scratch();
	try {
		mkdirSync(join(paths.dailyArchive, "2026-10"), { recursive: true });
		writeFileSync(join(paths.dailyArchive, "2026-10", "2026-10-16.md"), "# already there\n");
		writeFileSync(dailyFile(paths), CANONICAL);
		const result = rolloverDaily(paths, { today: "2026-10-17" });
		assert.equal(result.archivedTo, join(paths.dailyArchive, "2026-10", "2026-10-16-2.md"));
		assert.match(readFileSync(join(paths.dailyArchive, "2026-10", "2026-10-16.md"), "utf8"), /already there/, "the existing record is untouched");
	} finally {
		cleanup();
	}
});

test("daily: status reports freshness, open count and coarse dates", () => {
	const { paths, cleanup } = scratch();
	try {
		writeFileSync(dailyFile(paths), CANONICAL);
		const stale = dailyStatus(paths, "2026-10-17");
		assert.deepEqual(stale, { day: "2026-10-16", fresh: false, open: 2, undated: 1, issues: [], futureDated: false });
		const fresh = dailyStatus(paths, "2026-10-16");
		assert.equal(fresh.fresh, true);
		assert.equal(fresh.futureDated, false);
		assert.equal(dailyStatus(paths, "2026-10-15").futureDated, true);
	} finally {
		cleanup();
	}
});
