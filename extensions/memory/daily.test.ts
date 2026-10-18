import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DAILY_SECTIONS, appendDailyItem, appendDatedItems, dailyArchiveFiles, dailyFile, dailyStatus, openItems, parseDaily, readDaily, renderDaily, rolloverDaily } from "./daily.ts";
import { acquireLock, bankPaths, ensureBankDirs, FileLocked, releaseLock } from "./store.ts";
import { parallelWriters } from "./test-support/writers.ts";

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

test("daily: migrated items keep their own date, and appending them twice does nothing (R15)", () => {
	const { paths, cleanup } = scratch();
	try {
		const first = appendDatedItems(paths, [
			{ section: "carry", text: "Run app in simulator and verify all screens", day: "2026-10-14" },
			{ section: "decision", text: "rewrite the memory component from scratch", day: "2026-10-16" },
			{ section: "carry", text: "an item with no date of its own" },
		], "2026-10-17");
		assert.equal(first.added, 3);
		const log = readDaily(paths, "2026-10-17");
		assert.deepEqual(
			log.items.map((item) => [item.section, item.stamp, item.day, item.undated]),
			[
				["carry", "2026-10-14", "2026-10-14", false],
				["carry", "2026-10-17", "2026-10-17", true],
				["decision", "2026-10-16", "2026-10-16", false],
			],
		);
		const again = appendDatedItems(paths, [{ section: "carry", text: "Run app in simulator and verify all screens", day: "2026-10-14" }], "2026-10-17");
		assert.deepEqual([again.added, again.skipped], [0, 1], "the step can be re-run");
		// The stamp survives the round trip, which is the point: carried work does
		// not become fresh work because the migration ran today.
		assert.match(readFileSync(join(paths.daily, "today.md"), "utf8"), /- \(2026-10-14\) Run app in simulator/);
	} finally {
		cleanup();
	}
});

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
		// The log keeps the order the items arrived in. It is a log, not a rendered
		// artifact: the writer adds lines, it does not rewrite the day.
		assert.equal(text, "# Daily log — 2026-10-16\n\n## in_progress\n- (2026-10-16 21:05) Wire the injector.\n\n## completed\n- (2026-10-16 21:40) Grammar module.\n");
		const log = readDaily(paths, "2026-10-16");
		assert.deepEqual(log.items.map((item) => [item.section, item.text]), [
			["in_progress", "Wire the injector."],
			["completed", "Grammar module."],
		], "what was written is what the reader sees");
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

const HAND_LOG = `# Daily log — 2026-10-18

A paragraph someone typed between sections.

## in_progress
- (2026-10-18 09:00) Ship the analysis.

## someday
- (2026-10-18 09:10) An item under a section the grammar does not know.

### A subheading, kept where it was
- an un-stamped item another tool wrote
`;

test("daily: memory_log keeps what it did not write (P1)", () => {
	const { paths, cleanup } = scratch();
	try {
		writeFileSync(dailyFile(paths), HAND_LOG);
		// The bug: memory_log re-rendered the log from the items it parsed, which
		// deleted the paragraph, the unknown section, and the subheading.
		const before = readFileSync(dailyFile(paths), "utf8").split("\n");
		const appended = appendDailyItem(paths, { section: "in_progress", text: "Add the regression test.", clock: clockAt("2026-10-18T10:00:00") });
		const after = readFileSync(dailyFile(paths), "utf8");
		for (const line of before) assert.ok(after.includes(line), `the log lost a line it did not write: ${line}`);
		assert.match(after, /A paragraph someone typed between sections\./);
		assert.match(after, /## someday\n- \(2026-10-18 09:10\) An item under a section/);
		assert.match(after, /### A subheading, kept where it was/);
		assert.match(after, /- an un-stamped item another tool wrote/);
		// The new line went where it belongs, not to the end of the file.
		assert.ok(after.includes("## in_progress\n- (2026-10-18 09:00) Ship the analysis.\n- (2026-10-18 10:00) Add the regression test."), "the item joins the section it belongs to");
		assert.equal(appended.item.stamp, "2026-10-18 10:00");
	} finally {
		cleanup();
	}
});

test("daily: an append leaves no half-written file behind (P1)", () => {
	const { paths, cleanup } = scratch();
	try {
		for (const [index, section] of ["note", "decision", "note"].entries()) {
			appendDailyItem(paths, { section, text: `Item ${index}.`, clock: clockAt(`2026-10-18T1${index}:00:00`) });
		}
		const leftovers = readdirSync(paths.daily).filter((name) => name.includes(".tmp-"));
		assert.deepEqual(leftovers, [], "write-then-rename leaves no sibling behind");
		const log = readDaily(paths, "2026-10-18");
		assert.deepEqual(log.items.map((item) => [item.section, item.text]), [["note", "Item 0."], ["note", "Item 2."], ["decision", "Item 1."]], "both note items joined the one note section");
	} finally {
		cleanup();
	}
});

test("daily: the archive holds the day's own bytes, not a re-render (P1)", () => {
	const { paths, cleanup } = scratch();
	try {
		writeFileSync(dailyFile(paths), HAND_LOG);
		const rolled = rolloverDaily(paths, { today: "2026-10-19" });
		assert.ok(rolled.archivedTo);
		const archived = readFileSync(rolled.archivedTo!, "utf8");
		assert.match(archived, /A paragraph someone typed between sections\./, "the archive is the day, not the day's parseable parts");
		assert.match(archived, /## someday/);
		// Only open sections carry: `## someday` is not open work, so its item stays
	// where the archive can still be read, and the bytes it was written in survive.
		const fresh = readDaily(paths, "2026-10-19");
		assert.deepEqual(fresh.items.map((item) => item.text), ["Ship the analysis."]);
	} finally {
		cleanup();
	}
});

test("daily: two processes logging at once lose no item (P2)", async () => {
	const { paths, cleanup } = scratch();
	try {
		// The real race: `memory_log` in two Pi sessions inside the same minute. Before
		// the lock, the log kept whichever session wrote last.
		const results = await parallelWriters(paths.root, "daily", ["alpha", "beta"]);
		assert.deepEqual(results.map((result) => result.status), [0, 0], results.map((result) => result.stderr).join("\n"));
		const log = readDaily(paths, "2026-10-18");
		for (const who of ["alpha", "beta"]) {
			for (let i = 0; i < 6; i++) {
				assert.ok(log.items.some((item) => item.text === `item ${who} ${i}`), `the item ${who} logged ${i} survived`);
			}
		}
		assert.deepEqual(log.issues, [], "the log two sessions wrote together is readable");
		assert.deepEqual(readdirSync(paths.daily).filter((name) => name.endsWith(".lock")), [], "no lock is left behind");
	} finally {
		cleanup();
	}
});

test("daily: memory_log refuses while another session holds the log (P2)", () => {
	const { paths, cleanup } = scratch();
	try {
		const file = dailyFile(paths);
		const held = acquireLock(file);
		try {
			assert.throws(() => appendDailyItem(paths, { section: "note", text: "While the other session writes.", clock: clockAt("2026-10-18T10:00:00") }), FileLocked);
			assert.ok(!existsSync(file) || !readFileSync(file, "utf8").includes("While the other session"), "a refused log write writes nothing");
		} finally {
			releaseLock(held);
		}
		appendDailyItem(paths, { section: "note", text: "Now.", clock: clockAt("2026-10-18T10:01:00") });
		assert.match(readFileSync(file, "utf8"), /- \(2026-10-18 10:01\) Now\./);
	} finally {
		cleanup();
	}
});

test("daily: a rollover skips a log another session is writing, and says so (P2)", () => {
	const { paths, cleanup } = scratch();
	try {
		writeFileSync(dailyFile(paths), "# Daily log — 2026-10-16\n\n## in_progress\n- (2026-10-16 09:00) Still open.\n");
		const held = acquireLock(dailyFile(paths));
		try {
			const skipped = rolloverDaily(paths, { today: "2026-10-17" });
			assert.equal(skipped.carried, 0);
			assert.equal(skipped.skipped, true);
			assert.match(skipped.reason ?? "", /another session is writing/);
			assert.match(readFileSync(dailyFile(paths), "utf8"), /2026-10-16/, "the day is not archived under the other writer");
		} finally {
			releaseLock(held);
		}
		const rolled = rolloverDaily(paths, { today: "2026-10-17" });
		assert.equal(rolled.carried, 1);
		assert.ok(rolled.archivedTo);
	} finally {
		cleanup();
	}
});
