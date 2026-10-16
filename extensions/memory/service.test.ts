import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MemoryPaths } from "./fs-store.ts";
import { createService, type AskFn, type ResolutionChoice } from "./service.ts";
import type { WriteRequest } from "./gate.ts";

function scratch(): MemoryPaths & { cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "memory-service-"));
	const paths: MemoryPaths = { root, knowledge: join(root, "knowledge"), pending: join(root, ".pending"), extensionsDir: join(root, "agent", "extensions") };
	mkdirSync(paths.knowledge, { recursive: true });
	return { ...paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const UI = `# ui

## ui.background
- kind: preference
- scope: global
- asOf: 2026-10-02
- source: design review
- status: active
Use dark grey for the UI background.

## git.push
- kind: rule
- scope: global
- asOf: 2026-10-12
- status: active
Never push without explicit confirmation.
`;

function seed(paths: MemoryPaths, files: Record<string, string> = { "ui.md": UI }): void {
	for (const [name, content] of Object.entries(files)) writeFileSync(join(paths.knowledge, name), content, "utf8");
}

const rival: WriteRequest = {
	file: "knowledge/appearance.md",
	key: "ui.background",
	scope: "global",
	kind: "preference",
	body: "Charcoal.",
	asOf: "2026-11-01",
	revision: "2026-11-01",
};

const askFor = (choice: ResolutionChoice | null): { ask: AskFn; seen: unknown[] } => {
	const seen: unknown[] = [];
	return {
		seen,
		ask: async (refusal, request) => {
			seen.push({ id: refusal.conflictId, candidates: refusal.candidates.map((entry) => entry.heading), request });
			return choice;
		},
	};
};

// ─── Writes ─────────────────────────────────────────────────────────────────

test("an uncontested write lands on disk", async () => {
	const paths = scratch();
	try {
		seed(paths);
		const service = createService(paths);
		const outcome = await service.write({ file: "knowledge/ui.md", key: "ui.foreground", scope: "global", kind: "preference", body: "Off-white.", asOf: "2026-10-14", revision: "2026-10-14" });
		assert.equal(outcome.kind, "written");
		assert.deepEqual(outcome.files, ["knowledge/ui.md"]);
		assert.match(readFileSync(join(paths.knowledge, "ui.md"), "utf8"), /## ui\.foreground@2026-10-14/);
	} finally {
		paths.cleanup();
	}
});

test("a rival claim is refused with nothing written and the queue filled", async () => {
	const paths = scratch();
	try {
		seed(paths);
		const before = readFileSync(join(paths.knowledge, "ui.md"), "utf8");
		const service = createService(paths, { now: () => "2026-11-01T09:00:00.000Z" });
		const outcome = await service.write(rival);

		assert.equal(outcome.kind, "refused");
		assert.match(outcome.summary, /^CONFLICT ui\.background in scope global — nothing was written\.$/);
		assert.match(outcome.instructions ?? "", /resolve: supersede \| merge \| withdraw \| keep-both-flagged \| discard/);
		assert.equal(readFileSync(join(paths.knowledge, "ui.md"), "utf8"), before, "the bank did not move");
		assert.ok(outcome.conflictId && /^[0-9a-f]{8}$/.test(outcome.conflictId));
		assert.equal(outcome.pendingId, outcome.conflictId);
		assert.match(outcome.conflictText ?? "", /Suggested: supersede/);
		assert.equal(service.pending().conflicts.length, 1);
		assert.equal(existsSync(join(paths.knowledge, "appearance.md")), false, "the refused file was never created");
	} finally {
		paths.cleanup();
	}
});

test("a refusal is parked rather than guessed at when nobody can be asked", async () => {
	const paths = scratch();
	try {
		seed(paths);
		const service = createService(paths);
		const outcome = await service.write(rival);
		assert.equal(outcome.kind, "refused");
		assert.equal(service.pending().conflicts.length, 1);
	} finally {
		paths.cleanup();
	}
});

test("the TUI path: the human answers, and the write goes through in the same call", async () => {
	const paths = scratch();
	try {
		seed(paths);
		const asked = askFor({ resolution: "supersede", note: "user picked charcoal" });
		const service = createService(paths, { ask: asked.ask });

		const outcome = await service.write(rival);
		assert.equal(outcome.kind, "written");
		assert.deepEqual(asked.seen.length, 1);
		assert.match(outcome.summary, /Resolved by the human: supersede \(user picked charcoal\)/);
		assert.deepEqual(service.pending().conflicts, [], "an answered conflict is not queued");

		const appearance = readFileSync(join(paths.knowledge, "appearance.md"), "utf8");
		assert.match(appearance, /- supersedes: knowledge\/ui\.md#ui\.background/);
		assert.match(readFileSync(join(paths.knowledge, "ui.md"), "utf8"), /- supersededBy: knowledge\/appearance\.md#ui\.background@2026-11-01\n- status: superseded/, "canonical field order: the tombstone points at its replacement");
	} finally {
		paths.cleanup();
	}
});

test("a dismissed dialog parks the refusal instead of writing anything", async () => {
	const paths = scratch();
	try {
		seed(paths);
		const service = createService(paths, { ask: askFor(null).ask });
		const outcome = await service.write(rival);
		assert.equal(outcome.kind, "refused");
		assert.equal(service.pending().conflicts.length, 1);
		assert.equal(existsSync(join(paths.knowledge, "appearance.md")), false);
	} finally {
		paths.cleanup();
	}
});

test("a question that dies mid-air leaves the contest parked, not lost", async () => {
	const paths = scratch();
	try {
		seed(paths);
		// The dialog can be displaced, the component can die, the UI can throw. None of
		// that may cost the refusal its record, and none of it may leave the write
		// awaiting an answer that will never come.
		const service = createService(paths, {
			ask: async () => {
				throw new Error("dialog component vanished");
			},
		});
		const outcome = await service.write(rival);
		assert.equal(outcome.kind, "refused");
		assert.match(outcome.summary, /dialog component vanished/);
		assert.equal(service.pending().conflicts.length, 1, "the contest outlives the question");
	} finally {
		paths.cleanup();
	}
});

test("the parked refusal hands over both claims, so the caller can relay them", async () => {
	const paths = scratch();
	try {
		seed(paths);
		const service = createService(paths);
		const outcome = await service.write(rival);
		assert.equal(outcome.kind, "refused");
		assert.match(outcome.contest ?? "", /In the bank now:[\s\S]*Use dark grey[\s\S]*Being written:[\s\S]*Charcoal/);
		assert.match(outcome.contest ?? "", /Why this is refused:/);
		assert.ok((outcome.conflictText ?? "").length > (outcome.contest ?? "").length, "the queue keeps the full text; the handover is the short one");
	} finally {
		paths.cleanup();
	}
});

test("an invalid answer from the human is reported, not worked around", async () => {
	const paths = scratch();
	try {
		seed(paths);
		const service = createService(paths, { ask: askFor({ resolution: "merge" }).ask });
		const outcome = await service.write(rival);
		assert.equal(outcome.kind, "rejected");
		assert.match(outcome.summary, /mergedBody/);
		assert.deepEqual(service.pending().conflicts, [], "a malformed answer is not parked as if it were a refusal");
		assert.equal(existsSync(join(paths.knowledge, "appearance.md")), false);
	} finally {
		paths.cleanup();
	}
});

test("authoring a claim you own is not gated, and the second pass is a no-op", async () => {
	const paths = scratch();
	try {
		seed(paths);
		const service = createService(paths);
		const first = await service.write({ file: "knowledge/ui.md", key: "ui.background", scope: "global", kind: "preference", body: "Dark grey, confirmed.", asOf: "2026-10-09", source: "PR review" });
		assert.equal(first.kind, "written");
		const second = await service.write({ file: "knowledge/ui.md", key: "ui.background", scope: "global", kind: "preference", body: "Dark grey, confirmed.", asOf: "2026-10-09", source: "PR review" });
		assert.equal(second.kind, "unchanged");
	} finally {
		paths.cleanup();
	}
});

test("a malformed write is rejected with the parser's own reasons", async () => {
	const paths = scratch();
	try {
		seed(paths);
		const service = createService(paths);
		const noDate = await service.write({ file: "knowledge/ui.md", key: "ui.x", scope: "global", kind: "fact", body: "x" });
		assert.equal(noDate.kind, "rejected");
		assert.ok(noDate.issues?.some((issue) => issue.code === "missing-asOf") ?? false);

		const badScope = await service.write({ file: "knowledge/ui.md", key: "ui.x", scope: "host:work", kind: "fact", body: "x", asOf: "2026-01-01" });
		assert.equal(badScope.kind, "rejected");
		assert.ok(badScope.issues?.some((issue) => issue.code === "bad-scope") ?? false);

		const badFile = await service.write({ file: "core/dailyContext.md", key: "ui.x", scope: "global", kind: "fact", body: "x", asOf: "2026-01-01" });
		assert.equal(badFile.kind, "rejected");
		assert.match(badFile.summary, /knowledge\/<topic>\.md/);
	} finally {
		paths.cleanup();
	}
});

// ─── The queue ──────────────────────────────────────────────────────────────

test("a queued conflict can be answered later, by a different service instance", async () => {
	const paths = scratch();
	try {
		seed(paths);
		const first = createService(paths);
		const parked = await first.write(rival);
		assert.equal(parked.kind, "refused");

		const later = createService(paths);
		const resolved = await later.resolveQueued(parked.conflictId!, { resolution: "supersede", note: "answered next morning" });
		assert.equal(resolved.kind, "written");
		assert.deepEqual(later.pending().conflicts, [], "answering clears the queue");
		assert.match(readFileSync(join(paths.knowledge, "appearance.md"), "utf8"), /- resolution: supersede — answered next morning/);
	} finally {
		paths.cleanup();
	}
});

test("answering a queue entry after the store moved on re-opens the contest", async () => {
	const paths = scratch();
	try {
		seed(paths);
		const service = createService(paths);
		const parked = await service.write(rival);
		const originalId = parked.conflictId!;

		// Somebody edits the live claim underneath the queue.
		const amended = await service.write({ file: "knowledge/ui.md", key: "ui.background", scope: "global", kind: "preference", body: "Dark grey, revisited.", asOf: "2026-10-20" });
		assert.equal(amended.kind, "written");

		const stale = await service.resolveQueued(originalId, { resolution: "supersede" });
		assert.equal(stale.kind, "refused", "the old decision is not applied to a state nobody reviewed");
		assert.match(stale.summary, /The store changed since/);
		const queue = service.pending().conflicts;
		assert.deepEqual(queue.map((conflict) => conflict.id), [stale.conflictId], "the contest is re-parked under a fresh id");
		assert.notEqual(stale.conflictId, originalId);
	} finally {
		paths.cleanup();
	}
});

test("an answered contest is not re-litigated: discard clears it", async () => {
	const paths = scratch();
	try {
		seed(paths);
		const service = createService(paths);
		const parked = await service.write(rival);
		const discarded = await service.write({ ...rival, resolve: "discard", conflictId: parked.conflictId! });
		assert.equal(discarded.kind, "discarded");
		assert.deepEqual(service.pending().conflicts, [], "answering with discard clears the queue too");
	} finally {
		paths.cleanup();
	}
});

test("a queue entry whose contest disappeared is removed, not retried forever", async () => {
	const paths = scratch();
	try {
		seed(paths, { "ui.md": UI, "settings.md": `# settings\n\n## ui.background\n- kind: preference\n- scope: project:other-repo\n- asOf: 2026-09-01\n- status: active\nNavy over there.\n` });
		const parked = await createService(paths).write({ ...rival, scope: "project:other-repo" });
		assert.equal(parked.kind, "refused");

		// The rival claim is withdrawn by hand; the queued request no longer contests.
		seed(paths, { "settings.md": `# settings\n\n## ui.background\n- kind: preference\n- scope: project:other-repo\n- asOf: 2026-09-01\n- status: withdrawn\nNavy over there.\n` });
		const resolved = await createService(paths).resolveQueued(parked.conflictId!, { resolution: "supersede" });
		assert.equal(resolved.kind, "written", "the rival is gone, so the write is simply uncontested now");
		assert.deepEqual(createService(paths).pending().conflicts, []);
	} finally {
		paths.cleanup();
	}
});

test("resolving an id nobody parked is refused", async () => {
	const paths = scratch();
	try {
		const service = createService(paths);
		const outcome = await service.resolveQueued("deadbeef", { resolution: "supersede" });
		assert.equal(outcome.kind, "rejected");
		assert.match(outcome.summary, /No pending conflict deadbeef/);
	} finally {
		paths.cleanup();
	}
});

// ─── Reading and reporting ──────────────────────────────────────────────────

test("show says plainly when the store disagrees with itself", async () => {
	const paths = scratch();
	try {
		// A contested bank is a real state: it is what migration from the old
		// file-per-claim layout can produce.
		seed(paths, {
			"ui.md": `# ui\n\n## ui.background\n- kind: preference\n- scope: global\n- asOf: 2026-10-02\n- status: active\nDark grey.\n`,
			"settings.md": `# settings\n\n## ui.background\n- kind: preference\n- scope: global\n- asOf: 2026-09-01\n- status: active\nNavy.\n`,
		});
		const report = createService(paths).show("ui.background", {});
		assert.equal(report.contested, true);
		assert.equal(report.authority, null, "no authority is invented for a contested identity");
		assert.deepEqual(report.claims.map((entry) => `${entry.path}#${entry.status}`).sort(), ["knowledge/settings.md#active", "knowledge/ui.md#active"]);
	} finally {
		paths.cleanup();
	}
});

test("show lists the chain: what is current, what was retired, by what", async () => {
	const paths = scratch();
	try {
		seed(paths, {
			"ui.md": `# ui\n\n## ui.background\n- kind: preference\n- scope: global\n- asOf: 2026-10-02\n- status: active\nDark grey.\n\n## ui.background@2026-06-14\n- kind: preference\n- scope: global\n- asOf: 2026-06-14\n- status: superseded\n- supersededBy: knowledge/ui.md#ui.background\nNavy.\n`,
		});
		const report = createService(paths).show("ui.background", {});
		assert.equal(report.authority?.body, "Dark grey.");
		assert.deepEqual(report.claims.map((entry) => `${entry.heading}@${entry.status}`), ["ui.background@active", "ui.background@2026-06-14@superseded"]);
	} finally {
		paths.cleanup();
	}
});

test("show reports the authority and the shadowing trace, not a guess", async () => {
	const paths = scratch();
	try {
		seed(paths, {
			"ui.md": `# ui\n\n## ui.background\n- kind: preference\n- scope: global\n- asOf: 2026-01-01\nDark grey.\n`,
			"finance.md": `# finance\n\n## ui.background\n- kind: preference\n- scope: project:money-manager\n- asOf: 2025-12-01\nNavy for legibility.\n`,
		});
		const here = createService(paths).show("ui.background", { project: "money-manager" });
		assert.equal(here.authority?.body, "Navy for legibility.");
		assert.equal(here.contested, false);
		const there = createService(paths).show("ui.background", {});
		assert.equal(there.authority?.body, "Dark grey.");
		assert.deepEqual(there.plan?.shadowed.map((entry) => entry.reason), []);
		assert.deepEqual(there.plan?.outOfScope.map((entry) => entry.entry.key), ["ui.background"]);
	} finally {
		paths.cleanup();
	}
});

test("search returns candidates with what matched, and never decides authority", async () => {
	const paths = scratch();
	try {
		seed(paths);
		const hits = createService(paths).search("push confirmation", 5);
		assert.deepEqual(hits.map((hit) => hit.entry.key), ["git.push"]);
		assert.deepEqual(hits[0]!.matched.sort(), ["confirmation", "push"]);
	} finally {
		paths.cleanup();
	}
});

test("injection says nothing when there is nothing to say", async () => {
	const paths = scratch();
	try {
		seed(paths);
		assert.equal(createService(paths).injection("xylophone", {}).text, "");
		assert.match(createService(paths).injection("push to github", {}).text, /\[rule · global · 2026-10-12\] git\.push:/);
	} finally {
		paths.cleanup();
	}
});

test("rollDaily archives a stale daily file, carries open work, and never overwrites a record", () => {
	const paths = scratch();
	const root = paths.root;
	const service = createService(paths, { now: () => "2026-10-14T09:00:00.000Z" });
	mkdirSync(join(root, "core"), { recursive: true });
	try {
	writeFileSync(join(root, "core", "dailyContext.md"), `- date: 2026-10-11\n\n## Next Steps\n- push when approved\n\n## Completed\n- shipped it\n`, "utf8");
	const outcome = service.rollDaily();
	assert.equal(outcome.performed, true);
	if (outcome.performed) {
		assert.equal(outcome.carried, 1);
		assert.equal(outcome.notCarried, 1);
		assert.match(outcome.notice, /archived to history\/daily\/2026-10\/2026-10-11-dailyContext\.md/);
	}
	assert.match(readFileSync(join(root, "core", "dailyContext.md"), "utf8"), /push when approved/);
	assert.equal(readFileSync(join(root, "history", "daily", "2026-10", "2026-10-11-dailyContext.md"), "utf8").includes("shipped it"), true, "the settled work stays in the record");

	// Same day again: nothing to do, and the archive is not rewritten.
	const again = service.rollDaily();
	assert.equal(again.performed, false);
	if (!again.performed) assert.equal(again.reason, "the daily file is already current");

	// A forced rollover of a same-day file is allowed, because the date check cannot
	// see a file whose content is old while its mtime is new — but only when a human
	// says so.
	const forced = service.rollDaily({ force: true });
	assert.equal(forced.performed, true);
	if (forced.performed) assert.match(forced.archivePath, /2026-10-14-dailyContext\.md$/);
	// A second forced rollover of the same day has real bytes to keep — the file the
	// first one wrote. It goes beside the existing record rather than overwriting it
	// or blocking forever: two files can legitimately be about one day (an undated
	// one whose day was inferred, plus the file started for that day), and blocking
	// left a real bank's daily file stale and unarchivable for days.
	const firstRecord = readFileSync(join(root, "history", "daily", "2026-10", "2026-10-14-dailyContext.md"), "utf8");
	const attemptedTwice = service.rollDaily({ force: true });
	assert.equal(attemptedTwice.performed, true);
	if (attemptedTwice.performed) {
		assert.match(attemptedTwice.archivePath, /2026-10-14-dailyContext-2\.md$/);
		assert.match(attemptedTwice.notice, /already held a record of that day/);
	}
	assert.equal(readFileSync(join(root, "history", "daily", "2026-10", "2026-10-14-dailyContext.md"), "utf8"), firstRecord, "the first record is untouched");
	} finally {
		paths.cleanup();
	}
});

test("the same day's exact bytes are never archived twice", () => {
	const paths = scratch();
	const root = paths.root;
	const service = createService(paths, { now: () => "2026-10-14T09:00:00.000Z" });
	mkdirSync(join(root, "core"), { recursive: true });
	const stale = `- date: 2026-10-11\n\n## Next Steps\n- push when approved\n`;
	try {
	writeFileSync(join(root, "core", "dailyContext.md"), stale, "utf8");
	assert.equal(service.rollDaily().performed, true);

	// Same day, same content, e.g. a replay or a hand-restored file: the record
	// already exists, so nothing is duplicated and the reason says which case it is.
	writeFileSync(join(root, "core", "dailyContext.md"), stale, "utf8");
	const replay = service.rollDaily();
	assert.equal(replay.performed, false);
	if (!replay.performed) assert.match(replay.reason, /already records this exact day/);
	assert.deepEqual(readdirSync(join(root, "history", "daily", "2026-10")), ["2026-10-11-dailyContext.md"]);
	} finally {
		paths.cleanup();
	}
});

test("stampDaily dates undated open items and leaves settled work alone", () => {
	const paths = scratch();
	const root = paths.root;
	const service = createService(paths, { now: () => "2026-10-14T09:00:00.000Z" });
	mkdirSync(join(root, "core"), { recursive: true });
	try {
		writeFileSync(join(root, "core", "dailyContext.md"), `- date: 2026-10-14\n\n## Next Steps\n- verify the simulator\n\n## Completed\n- shipped it\n`, "utf8");
		const stamped = service.stampDaily();
		assert.deepEqual(stamped, { stamped: 1, date: "2026-10-14" });
		const text = readFileSync(join(root, "core", "dailyContext.md"), "utf8");
		assert.match(text, /- \(2026-10-14\) verify the simulator/);
		assert.match(text, /## Completed\n- shipped it/, "settled work is not turned into a dated task");
		// Idempotent: a second pass has nothing to do.
		assert.deepEqual(service.stampDaily(), { stamped: 0, date: "2026-10-14" });
	} finally {
		paths.cleanup();
	}
});

test("daily() reports an undated file as dated by mtime and needing a date field", () => {
	const paths = scratch();
	const root = paths.root;
	const service = createService(paths, { now: () => "2026-10-14T09:00:00.000Z" });
	mkdirSync(join(root, "core"), { recursive: true });
	try {
	writeFileSync(join(root, "core", "dailyContext.md"), "# Daily Context\n\n## In Progress\n- still going\n", "utf8");
	// Hermetic: an mtime is the wall clock, and the wall clock is not the injected
	// day. Left to the real mtime this test passes only on one date a month.
	const touched = new Date("2026-10-14T12:00:00.000Z");
	utimesSync(join(root, "core", "dailyContext.md"), touched, touched);

	const status = service.daily();
	assert.equal(status.exists, true);
	assert.equal(status.freshness.needsDate, true);
	assert.equal(status.freshness.stale, false, "touched today, so treated as current — but reported");
	} finally {
		paths.cleanup();
	}
});

test("doctor reports the bank as it actually is", async () => {
	const paths = scratch();
	try {
		seed(paths, {
			"ui.md": UI,
			"settings.md": `# settings\n\n## ui.background\n- kind: preference\n- scope: global\n- asOf: 2026-09-01\n- status: active\nNavy.\n`,
			"empty.md": "# empty\n\nintro prose with no entries at all\n",
			"notes.md": `# notes\n\n## A heading that is not an assertion key\n- kind: fact\n- scope: global\n- asOf: 2026-01-01\n- status: active\nLegacy prose heading.\n`
		});
		mkdirSync(join(paths.knowledge, "broken.md"));
		const service = createService(paths);
		const parked = await service.write({ file: "knowledge/notes.md", key: "git.push", scope: "global", kind: "rule", body: "Push means verified.", asOf: "2026-11-02", revision: "2026-11-02" });
		assert.equal(parked.kind, "refused");

		const report = createService(paths).doctor();
		assert.equal(report.bankRoot, paths.root);
		assert.deepEqual(report.files, ["knowledge/broken.md", "knowledge/empty.md", "knowledge/notes.md", "knowledge/settings.md", "knowledge/ui.md"]);
		assert.equal(report.entries, 4);
		assert.deepEqual(report.byStatus, { active: 4, superseded: 0, withdrawn: 0 });
		assert.deepEqual(report.contested, [{ identity: "ui.background in scope global", candidates: ["knowledge/settings.md#ui.background", "knowledge/ui.md#ui.background"] }]);
		assert.ok(report.violations.some((violation) => violation.code === "duplicate-identity"));
		assert.deepEqual(report.unkeyed, ["knowledge/notes.md#A heading that is not an assertion key"]);
		assert.deepEqual(report.unreadable.map((problem) => problem.path), ["knowledge/broken.md"]);
		assert.deepEqual(report.emptyFiles, ["knowledge/broken.md", "knowledge/empty.md"]);
		assert.deepEqual(report.pending.map((conflict) => conflict.id), [parked.conflictId]);
	assert.deepEqual(report.corruptQueue, []);
	} finally {
		paths.cleanup();
	}
});

// ─── Working state and read-only recall ──────────────────────────────────────

function seedAnywhere(paths: MemoryPaths, files: Record<string, string>): void {
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(join(paths.root, name.split("/").slice(0, -1).join("/")), { recursive: true });
		writeFileSync(join(paths.root, name), content, "utf8");
	}
}

const CLOCK = { now: () => "2026-10-16T09:00:00.000Z" };

test("working state reads the two prose files and reports what fit", () => {
	const paths = scratch();
	try {
		seedAnywhere(paths, {
			"core/activeProjects.md": "# Active Projects\n\n## rl-pi-extensions\n- v1.4.1 released and pushed\n",
			"core/dailyContext.md": "- date: 2026-10-16\n\n## In Progress\n- (2026-10-16) bump the Pi pins when the runtime updates\n",
		});
		const report = createService(paths, CLOCK).workingState();

		assert.match(report.text, /- v1\.4\.1 released and pushed/);
		assert.match(report.text, /bump the Pi pins/);
		assert.equal(report.activeProjects.exists, true);
		assert.equal(report.activeProjects.droppedLines, 0);
		assert.equal(report.daily.items, 1);
		assert.equal(report.daily.stale, false);
	} finally {
		paths.cleanup();
	}
});

test("the daily cap is separate from the authority budget, and says so when nothing fits", () => {
	const paths = scratch();
	try {
		seedAnywhere(paths, {
			"core/activeProjects.md": "# Active Projects\n\n## one\n- a project line that is fairly long so it costs tokens to render at all\n",
			"core/dailyContext.md": "- date: 2026-10-16\n\n## In Progress\n- (2026-10-16) open item\n",
		});
		const starved = createService(paths, CLOCK).workingState({ activeProjects: 5, daily: 5 });

		assert.ok(starved.activeProjects.droppedLines > 0);
		assert.equal(starved.daily.shownItems, 0);
		assert.match(starved.text, /No open item fit this turn — the whole list with memory_read core\/dailyContext\.md/);
		assert.match(starved.text, /the rest with memory_read core\/activeProjects\.md/);
	} finally {
		paths.cleanup();
	}
});

test("readFile reaches core/ and history/, and refuses anything that is not in the bank", () => {
	const paths = scratch();
	try {
		seedAnywhere(paths, {
			"core/activeProjects.md": "# Active Projects\n\n## rl-pi-extensions\n- v1.4.1 released\n",
			"history/daily/2026-10/2026-10-14-dailyContext.md": "- date: 2026-10-14\n\n## Completed\n- shipped it\n",
		});
		const service = createService(paths, CLOCK);

		const archived = service.readFile("history/daily/2026-10/2026-10-14-dailyContext.md");
		assert.equal(archived.kind, "read", "an archive from three weeks ago is reachable, which is the whole point of archiving");
		if (archived.kind === "read") assert.match(archived.slice.text, /shipped it/);

		assert.equal(service.readFile("../secrets.env").kind, "outside");
		assert.equal(service.readFile("knowledge").kind, "directory");
		assert.equal(service.readFile("core/nothing.md").kind, "missing");
	} finally {
		paths.cleanup();
	}
});

test("listFiles shows the whole bank, including the stores' own siblings", () => {
	const paths = scratch();
	try {
		seedAnywhere(paths, { "knowledge/ui.md": UI, "core/dailyContext.md": "- date: 2026-10-16\n\n## In Progress\n- work\n" });
		const outcome = createService(paths, CLOCK).listFiles();

		assert.equal(outcome.kind, "listed");
		if (outcome.kind !== "listed") return;
		const listed = outcome.listing.entries.map((entry) => entry.path);
		assert.ok(listed.includes("core/dailyContext.md"));
		assert.ok(listed.includes("knowledge/ui.md"));
	} finally {
		paths.cleanup();
	}
});

test("the doctor reports the working-state files it injects, and a leftover temp file", () => {
	const paths = scratch();
	try {
		seed(paths);
		seedAnywhere(paths, {
			"core/activeProjects.md": "# Active Projects\n\n## rl-pi-extensions\n- v1.4.1\n",
			"core/dailyContext.md": `- date: 2026-09-30\n\n## In Progress\n- (2026-09-30) an old open item\n`,
			"knowledge/ui.md.tmp-4242": "half a file",
		});
		const report = createService(paths, CLOCK).doctor();

		assert.deepEqual(report.tempFiles, ["knowledge/ui.md.tmp-4242"], "a write interrupted mid-rename leaves evidence, and the doctor shows it");
		assert.equal(report.workingState.activeProjects.exists, true);
		assert.equal(report.workingState.daily.stale, true);
		assert.equal(report.workingState.daily.ageDays, 16);
	} finally {
		paths.cleanup();
	}
});
