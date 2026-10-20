import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	appendTurn,
	baselineFile,
	blocksInSession,
	computeBaseline,
	corruptTurnLines,
	formatTrialReport,
	median,
	readFlags,
	readOverrides,
	readTurns,
	recordFlag,
	recordOverride,
	trialReport,
	writeBaseline,
	BASELINE_MARKER,
} from "./trial.ts";
import { bankPaths, ensureBankDirs } from "./store.ts";

function scratch(): { dir: string; paths: ReturnType<typeof bankPaths>; cleanup: () => void } {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "memory-trial-")));
	const paths = bankPaths(dir);
	ensureBankDirs(paths);
	return { dir, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const clockAt = (iso: string) => () => new Date(iso);

test("trial: one line per injected turn, with no prompt text (R43)", () => {
	const { paths, cleanup } = scratch();
	try {
		const metric = appendTurn(
			paths,
			{ tokens: { core: 300, daily: 120, retrieved: 400, total: 860 }, dropped: { claims: 4, dailyItems: 1 }, claims: 17, session: "01a14561" },
			clockAt("2026-10-16T21:05:07"),
		);
		assert.deepEqual(metric, {
			at: "2026-10-16 21:05:07",
			day: "2026-10-16",
			tokens: { core: 300, daily: 120, retrieved: 400, total: 860 },
			dropped: { claims: 4, dailyItems: 1 },
			claims: 17,
			session: "01a14561",
		});
		appendTurn(paths, { tokens: { core: 0, daily: 0, retrieved: 0, total: 0 }, dropped: { claims: 0, dailyItems: 0 }, claims: 17, session: "x" }, clockAt("2026-10-17T09:00:00"));
		const raw = readFileSync(join(paths.metrics, "turns.jsonl"), "utf8");
		assert.equal(raw.split("\n").filter((line) => line !== "").length, 2);
		const turns = readTurns(paths);
		assert.deepEqual(turns.map((turn) => turn.day), ["2026-10-16", "2026-10-17"]);
		// Nothing but numbers and a session id is stored.
		for (const line of raw.trim().split("\n")) {
			assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ["at", "claims", "day", "dropped", "session", "tokens"]);
		}
		assert.deepEqual(readTurns(paths, { sinceDay: "2026-10-17" }).length, 1);
	} finally {
		cleanup();
	}
});

test("trial: a corrupt metrics line is counted, not hidden", () => {
	const { paths, cleanup } = scratch();
	try {
		appendTurn(paths, { tokens: { core: 1, daily: 1, retrieved: 1, total: 3 }, dropped: { claims: 0, dailyItems: 0 }, claims: 5, session: "s" }, clockAt("2026-10-16T10:00:00"));
		writeFileSync(join(paths.metrics, "turns.jsonl"), readFileSync(join(paths.metrics, "turns.jsonl"), "utf8") + "{ half a line\n", "utf8");
		assert.equal(readTurns(paths).length, 1);
		assert.equal(corruptTurnLines(paths), 1);
	} finally {
		cleanup();
	}
});

test("trial: a flag records the claim as injected and the session (R44)", () => {
	const { paths, cleanup } = scratch();
	try {
		const flag = recordFlag(paths, { key: "git.flow", kind: "stale", claim: "rule · global · 2025-01-01: Rebase onto master.", scope: "global", session: "abc" }, clockAt("2026-10-16T12:00:00"));
		assert.deepEqual(flag, {
			at: "2026-10-16 12:00:00",
			day: "2026-10-16",
			key: "git.flow",
			kind: "stale",
			claim: "rule · global · 2025-01-01: Rebase onto master.",
			scope: "global",
			session: "abc",
		});
		recordFlag(paths, { key: "a.b", kind: "rival", claim: "x", scope: "global", session: "abc" }, clockAt("2026-10-17T12:00:00"));
		assert.deepEqual(readFlags(paths).map((entry) => entry.kind), ["stale", "rival"]);
		assert.equal(readFlags(paths, { sinceDay: "2026-10-17" }).length, 1);
		assert.throws(() => recordFlag(paths, { key: "a.b", kind: "wrong" as never, claim: "x", scope: "global", session: "s" }), /flag kind must be stale \| rival/);
	} finally {
		cleanup();
	}
});

test("trial: the median is the middle value, not the average", () => {
	assert.equal(median([]), 0);
	assert.equal(median([5]), 5);
	assert.equal(median([9, 1, 5]), 5);
	assert.equal(median([1, 2, 3, 100]), 3, "the mean would be 26.5");
});

// ── Baseline from session files (R47) ──────────────────────────────────────

function sessionLine(entry: unknown): string {
	return `${JSON.stringify(entry)}\n`;
}

function writeSession(file: string, entries: unknown[]): void {
	writeFileSync(file, entries.map(sessionLine).join(""));
}

const INJECTED = `${BASELINE_MARKER}

## Project Knowledge
a great many words about things that are not this question`;

test("trial: a session file yields one injected block per user turn", () => {
	const { dir, paths, cleanup } = scratch();
	try {
		const sessions = join(dir, "sessions");
		mkdirSync(sessions, { recursive: true });
		const file = join(sessions, "2026-10-14T10-00-00-000Z_abc.jsonl");
		writeSession(file, [
			{ type: "session", id: "abc" },
			{ type: "message", message: { role: "user", content: "first question" }, timestamp: "2026-10-14T10:00:00.000Z", id: "1" },
			{ type: "custom_message", customType: "memory-context", content: INJECTED, timestamp: "2026-10-14T10:00:01.000Z", id: "2" },
			{ type: "custom_message", customType: "memory-context", content: `${INJECTED} (re-injected in the same turn)`, timestamp: "2026-10-14T10:00:02.000Z", id: "3" },
			{ type: "message", message: { role: "assistant", content: "answer" }, timestamp: "2026-10-14T10:00:05.000Z", id: "4" },
			{ type: "message", message: { role: "user", content: "second question" }, timestamp: "2026-10-14T10:05:00.000Z", id: "5" },
			{ type: "custom_message", customType: "memory-context", content: INJECTED, timestamp: "2026-10-14T10:05:01.000Z", id: "6" },
			// A tool result quoting the marker is not an injection.
			{ type: "message", message: { role: "toolResult", content: `the code says "${BASELINE_MARKER}"` }, timestamp: "2026-10-14T10:05:02.000Z", id: "7" },
		]);
		const blocks = blocksInSession(file, BASELINE_MARKER);
		assert.equal(blocks.length, 2, "once per user turn, including a turn that wrote it twice");
		assert.ok(blocks.every((block) => block.tokens > 0));
		assert.deepEqual(blocks.map((block) => block.day), ["2026-10-14", "2026-10-14"]);

		const result = computeBaseline({ paths, sessionsDir: sessions, days: 14, today: "2026-10-16" });
		assert.equal(result.ok, true);
		assert.equal(result.blocksFound, 2);
		assert.equal(result.baseline!.samples, 2);
		assert.equal(result.baseline!.marker, BASELINE_MARKER);
		assert.equal(result.baseline!.estimated, false, "the baseline is measured, never estimated (R47)");
		assert.deepEqual([result.baseline!.from, result.baseline!.to], ["2026-10-14", "2026-10-14"]);
	} finally {
		cleanup();
	}
});

test("trial: blocks outside the window are ignored, and a different marker can be asked for", () => {
	const { dir, paths, cleanup } = scratch();
	try {
		const sessions = join(dir, "sessions");
		mkdirSync(join(sessions, "sub"), { recursive: true });
		writeSession(join(sessions, "old.jsonl"), [
			{ type: "message", message: { role: "user", content: "q" }, timestamp: "2026-01-02T10:00:00.000Z", id: "1" },
			{ type: "custom_message", customType: "memory-context", content: INJECTED, timestamp: "2026-01-02T10:00:01.000Z", id: "2" },
		]);
		writeSession(join(sessions, "sub", "recent.jsonl"), [
			{ type: "message", message: { role: "user", content: "q" }, timestamp: "2026-10-15T10:00:00.000Z", id: "1" },
			{ type: "custom_message", customType: "memory", content: "## Memory — authoritative for this context (project: x)\n- a claim", timestamp: "2026-10-15T10:00:01.000Z", id: "2" },
		]);
		const strict = computeBaseline({ paths, sessionsDir: sessions, days: 14, today: "2026-10-16" });
		assert.equal(strict.ok, false, "the only block in the window uses a different marker");
		assert.match(strict.reason!, /no block starting "# Memory Bank Context" was found in 2 session files/);

		const other = computeBaseline({ paths, sessionsDir: sessions, days: 14, today: "2026-10-16", marker: "## Memory — authoritative for this context" });
		assert.equal(other.ok, true);
		assert.equal(other.baseline!.samples, 1);
		assert.deepEqual([other.baseline!.from, other.baseline!.to], ["2026-10-15", "2026-10-15"]);
	} finally {
		cleanup();
	}
});

test("trial: a missing baseline is reported and nothing is written (R47)", () => {
	const { dir, paths, cleanup } = scratch();
	try {
		const sessions = join(dir, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeSession(join(sessions, "quiet.jsonl"), [{ type: "session", id: "x" }, { type: "message", message: { role: "user", content: "hi" }, timestamp: "2026-10-16T10:00:00.000Z" }]);
		const result = computeBaseline({ paths, sessionsDir: sessions, days: 14, today: "2026-10-16" });
		assert.equal(result.ok, false);
		assert.match(result.reason!, /Nothing was written: the baseline has to be measured, not estimated/);
		assert.ok(!existsSync(baselineFile(paths)));
	} finally {
		cleanup();
	}
});

test("trial: the report applies the go rule — the size gates, the evidence gates and zero flags (R45)", () => {
	const { paths, cleanup } = scratch();
	try {
		// No turns at all.
		let report = trialReport(paths, { today: "2026-10-16" });
		assert.match(report.verdict, /the trial has not started/);
		assert.equal(report.go, false);

		const days = ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];
		for (const day of days) {
			appendTurn(paths, { tokens: { core: 100, daily: 50, retrieved: 40, total: 190 }, dropped: { claims: 0, dailyItems: 0 }, claims: 12, session: "s" }, clockAt(`${day}T12:00:00`));
		}
		report = trialReport(paths, { today: "2026-10-16" });
		assert.equal(report.turns, 7);
		assert.deepEqual(report.medianTokens, 190);
		assert.match(report.verdict, /no baseline: run \/memory trial baseline first/);

		writeBaseline(paths, { medianTokens: 880, samples: 196, from: "2026-10-03", to: "2026-10-16", marker: BASELINE_MARKER, generatedAt: "2026-10-16T12:00:00.000Z", estimated: false });
		report = trialReport(paths, { today: "2026-10-16" });
		assert.deepEqual(report.ratio, 190 / 880);
		assert.equal(report.go, true, "190 is under 25% of 880 and under the ceiling, and no claim was flagged");
		assert.deepEqual(report.gates, []);
		assert.match(report.verdict, /^go: median 190 tokens against a baseline of 880 \(22%, threshold 25%\), under the 1200-token ceiling, and 0 stale or rival flags$/);

		recordFlag(paths, { key: "a.b", kind: "rival", claim: "x", scope: "global", session: "s" }, clockAt("2026-10-15T12:00:00"));
		report = trialReport(paths, { today: "2026-10-16" });
		assert.equal(report.go, false);
		assert.deepEqual(report.flags, { stale: 0, rival: 1, total: 1 });
		assert.deepEqual(report.gates, ["1 claim was flagged stale or rival"]);

		writeBaseline(paths, { medianTokens: 700, samples: 3, from: "2026-10-03", to: "2026-10-16", marker: BASELINE_MARKER, generatedAt: "now", estimated: false });
		report = trialReport(paths, { today: "2026-10-16" });
		assert.equal(report.go, false);
		assert.match(report.verdict, /^not yet: median 190 tokens is 27% of the baseline's 700 \(the gate is 25%\); 1 claim was flagged stale or rival$/);
	} finally {
		cleanup();
	}
});

test("trial: a size failure on its own names the size gate, not a flag problem", () => {
	const { paths, cleanup } = scratch();
	try {
		for (const day of ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]) {
			appendTurn(paths, { tokens: { core: 300, daily: 200, retrieved: 300, total: 800 }, dropped: { claims: 0, dailyItems: 0 }, claims: 12, session: "s" }, clockAt(`${day}T12:00:00`));
		}
		writeBaseline(paths, { medianTokens: 880, samples: 196, from: "2026-10-03", to: "2026-10-16", marker: BASELINE_MARKER, generatedAt: "now", estimated: false });
		const report = trialReport(paths, { today: "2026-10-16" });
		assert.equal(report.go, false);
		assert.equal(report.flags.total, 0);
		assert.deepEqual(report.gates, ["median 800 tokens is 91% of the baseline's 880 (the gate is 25%)"]);
	} finally {
		cleanup();
	}
});

test("trial: turns older than the window are not counted", () => {
	const { paths, cleanup } = scratch();
	try {
		appendTurn(paths, { tokens: { core: 10, daily: 10, retrieved: 10, total: 500 }, dropped: { claims: 0, dailyItems: 0 }, claims: 12, session: "s" }, clockAt("2026-09-01T12:00:00"));
		appendTurn(paths, { tokens: { core: 10, daily: 10, retrieved: 10, total: 150 }, dropped: { claims: 0, dailyItems: 0 }, claims: 12, session: "s" }, clockAt("2026-10-16T12:00:00"));
		const report = trialReport(paths, { today: "2026-10-16", days: 7 });
		assert.equal(report.turns, 1);
		assert.equal(report.medianTokens, 150);
	} finally {
		cleanup();
	}
});

test("trial: a burst on one day is not a week of evidence (F2-a, D21)", () => {
	const { paths, cleanup } = scratch();
	try {
		// Three turns, all on the last day, with the size gate passed and nothing
		// flagged. Before this fix the coverage check could not fire at all — it
		// measured the window it was given — and a later verdict overwrote it.
		for (const at of ["2026-10-19T09:00:00", "2026-10-19T09:01:00", "2026-10-19T09:02:00"]) {
			appendTurn(paths, { tokens: { core: 100, daily: 0, retrieved: 40, total: 300 }, dropped: { claims: 0, dailyItems: 0 }, claims: 12, session: "s" }, clockAt(at));
		}
		writeBaseline(paths, { medianTokens: 17232, samples: 380, from: "2026-10-06", to: "2026-10-19", marker: BASELINE_MARKER, generatedAt: "now", estimated: false });
		const report = trialReport(paths, { today: "2026-10-19", days: 7 });
		assert.equal(report.go, false, "the size gate passes and nothing is flagged, and that is still not evidence");
		// Every unmet gate is named, in one verdict: the coverage reason can no
		// longer be set and then overwritten by a later one.
		assert.deepEqual(report.gates, [
			"the trial started 1 day ago; the window is 7 days",
			"only 1 of 7 days carry turns (the gate is 4)",
			"only 3 turns retrieved a claim (the gate is 5)",
		]);
		assert.match(report.verdict, /^not yet: the trial started 1 day ago; the window is 7 days; only 1 of 7 days carry turns \(the gate is 4\); only 3 turns retrieved a claim \(the gate is 5\)$/);
	} finally {
		cleanup();
	}
});

test("trial: the clock starts at 3 approved claims and needs 5 turns that retrieved (D22)", () => {
	// A bank with two claims cannot produce a verdict at all.
	{
		const { paths, cleanup } = scratch();
		try {
			for (const day of ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]) {
				appendTurn(paths, { tokens: { core: 100, daily: 50, retrieved: 40, total: 190 }, dropped: { claims: 0, dailyItems: 0 }, claims: 2, session: "s" }, clockAt(`${day}T12:00:00`));
			}
			writeBaseline(paths, { medianTokens: 880, samples: 196, from: "2026-10-03", to: "2026-10-16", marker: BASELINE_MARKER, generatedAt: "now", estimated: false });
			const report = trialReport(paths, { today: "2026-10-16" });
			assert.equal(report.go, false);
			assert.match(report.verdict, /clock has not started/);
			assert.match(report.verdict, /2 approved claims/);
		} finally {
			cleanup();
		}
	}
	// Enough claims, but nothing ever came back from the ranker: an always-on block
	// alone proves only that the block is small.
	{
		const { paths, cleanup } = scratch();
		try {
			for (const day of ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]) {
				appendTurn(paths, { tokens: { core: 100, daily: 50, retrieved: 0, total: 150 }, dropped: { claims: 0, dailyItems: 0 }, claims: 12, session: "s" }, clockAt(`${day}T12:00:00`));
			}
			writeBaseline(paths, { medianTokens: 880, samples: 196, from: "2026-10-03", to: "2026-10-16", marker: BASELINE_MARKER, generatedAt: "now", estimated: false });
			const report = trialReport(paths, { today: "2026-10-16" });
			assert.equal(report.go, false, "a tiny block that nothing was retrieved for is not a win");
			assert.equal(report.retrievedTurns, 0);
			assert.match(report.verdict, /retrieved a claim/);
			assert.match(report.verdict, /5/);
		} finally {
			cleanup();
		}
	}
});

test("trial: the absolute ceiling stops a bank that spends its budget (D23)", () => {
	// A baseline this large makes the relative gate a formality: 1,500 is 8.7% of it.
	{
		const { paths, cleanup } = scratch();
		try {
			for (const day of ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]) {
				appendTurn(paths, { tokens: { core: 600, daily: 500, retrieved: 400, total: 1500 }, dropped: { claims: 0, dailyItems: 0 }, claims: 40, session: "s" }, clockAt(`${day}T12:00:00`));
			}
			writeBaseline(paths, { medianTokens: 17232, samples: 380, from: "2026-10-03", to: "2026-10-16", marker: BASELINE_MARKER, generatedAt: "now", estimated: false });
			const report = trialReport(paths, { today: "2026-10-16" });
			assert.equal(report.go, false, "8.7% of a huge baseline is still 1,500 tokens every turn");
			assert.match(report.verdict, /ceiling/);
			assert.match(report.verdict, /1200/);
			assert.match(formatTrialReport(report), /median 1500 against a ceiling of 1200/);
		} finally {
			cleanup();
		}
	}
	// Under the ceiling, with every other gate met, it goes.
	{
		const { paths, cleanup } = scratch();
		try {
			for (const day of ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]) {
				appendTurn(paths, { tokens: { core: 400, daily: 300, retrieved: 300, total: 1000 }, dropped: { claims: 0, dailyItems: 0 }, claims: 40, session: "s" }, clockAt(`${day}T12:00:00`));
			}
			writeBaseline(paths, { medianTokens: 17232, samples: 380, from: "2026-10-03", to: "2026-10-16", marker: BASELINE_MARKER, generatedAt: "now", estimated: false });
			const report = trialReport(paths, { today: "2026-10-16" });
			assert.equal(report.medianTokens, 1000);
			assert.equal(report.go, true, report.verdict);
		} finally {
			cleanup();
		}
	}
});

test("trial: an override is one event line, counted once each (F2-c, R24)", () => {
	const { paths, cleanup } = scratch();
	try {
		recordOverride(paths, { key: "git.flow", scope: "global", session: "s1", reason: "the body names a PR on purpose" }, clockAt("2026-10-16T10:00:00"));
		recordOverride(paths, { key: "style.commits", scope: "global", session: "s1", reason: "it is a rule about a run number" }, clockAt("2026-10-17T10:00:00"));
		recordOverride(paths, { key: "old.one", scope: "global", session: "s2", reason: "before the window" }, clockAt("2026-09-01T10:00:00"));
		const all = readOverrides(paths);
		assert.equal(all.length, 3);
		assert.deepEqual(all.map((entry) => entry.key), ["git.flow", "style.commits", "old.one"]);
		assert.deepEqual(readOverrides(paths, { sinceDay: "2026-10-16" }).map((entry) => entry.key), ["git.flow", "style.commits"]);

		const turns = ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];
		for (const day of turns) {
			appendTurn(paths, { tokens: { core: 100, daily: 50, retrieved: 40, total: 190 }, dropped: { claims: 0, dailyItems: 0 }, claims: 12, session: "s" }, clockAt(`${day}T12:00:00`));
		}
		writeBaseline(paths, { medianTokens: 880, samples: 196, from: "2026-10-03", to: "2026-10-16", marker: BASELINE_MARKER, generatedAt: "now", estimated: false });
		const report = trialReport(paths, { today: "2026-10-16" });
		assert.equal(report.overrides, 2, "D14 is only measurable if the count is on screen");
		// An override is the detector admitting a false positive. It is measured,
		// never a gate: making it one would reward never overriding.
		assert.equal(report.go, true, report.verdict);
		const text = formatTrialReport(report);
		assert.match(text, /overrides: 2 in the window \(git\.flow, style\.commits\)/);
	} finally {
		cleanup();
	}
});

test("trial: the report says what it measured, in the order the decision needs", () => {
	const { paths, cleanup } = scratch();
	try {
		for (const day of ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]) {
			appendTurn(paths, { tokens: { core: 100, daily: 50, retrieved: 40, total: 190 }, dropped: { claims: 2, dailyItems: 1 }, claims: 12, session: "s" }, clockAt(`${day}T12:00:00`));
		}
		writeBaseline(paths, { medianTokens: 880, samples: 196, from: "2026-10-03", to: "2026-10-16", marker: BASELINE_MARKER, generatedAt: "now", estimated: false });
		const text = formatTrialReport(trialReport(paths, { today: "2026-10-16" }));
		assert.match(text, /^Trial, last 7 days: 7 injected turns, median 190 tokens per turn/);
		assert.match(text, /baseline: median 880 tokens from 196 blocks marked "# Memory Bank Context", 2026-10-03 to 2026-10-16/);
		assert.match(text, /size: 22% of the baseline \(the gate is 25%\), median 190 against a ceiling of 1200/);
		assert.match(text, /evidence: 7 turns over 7 days, 7 of them retrieved a claim \(the gate is 5\), bank at 12 approved claims \(the clock starts at 3\)/);
		assert.match(text, /coverage: 7 of 7 days carry turns, over 7 of 7 days \(the gate is 4 days\)/);
		assert.match(text, /flags: 0 stale, 0 rival/);
		assert.match(text, /overrides: 0 in the window/);
		assert.match(text, /^  go: median 190/m);
	} finally {
		cleanup();
	}
});
