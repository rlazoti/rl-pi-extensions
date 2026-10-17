import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	applyMigration,
	cutoverSources,
	legacyDailyItems,
	legacyIsRetired,
	legacyKind,
	markDrafted,
	migrationProgress,
	draftQueue,
	migrateDailyItems,
	nextDraft,
	readState,
	parseLegacyStore,
	planMigration,
	recordBackup,
	requireBackup,
	savePlan,
	formatMigrationProgress,
} from "./migrate.ts";
import { bankPaths, ensureBankDirs, markdownFiles, readClaims } from "./store.ts";

const DAY = () => new Date(2026, 9, 16, 10, 0, 0);

function scratchBank(): { paths: ReturnType<typeof bankPaths>; cleanup: () => void } {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "memory-migrate-")));
	const paths = bankPaths(dir);
	ensureBankDirs(paths);
	mkdirSync(join(paths.root, "knowledge"), { recursive: true });
	mkdirSync(join(paths.root, "core"), { recursive: true });
	return { paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const GIT_STORE = `# Git Standards & Preferences

## git-standards.branch-naming-convention
- kind: fact
- scope: global
- asOf: 2026-05-02
- source: migrated from knowledge/git-standards.md — mtime 2026-05-02
- status: active

All Git branches should follow this pattern: \`rl-<MM>-<DD>-<short_description>\`.

## git-standards.github-push-preferences
- kind: rule
- scope: global
- asOf: 2026-05-02
- source: user request, PR review
- status: active

- Never push changes to GitHub without explicit confirmation
- Always verify changes before committing

## git-standards.old-flow
- kind: rule
- scope: global
- asOf: 2024-01-01
- source: old notes
- status: superseded

Rebase onto master.
`;

const PROSE_STORE = `# Loose thoughts

No headings here, just paragraphs of prose that were never keyed.
`;

const DAILY_CORE = `# Daily Context — 2026-10-17

- date: 2026-10-17

## In Progress

### Next Steps

- (2026-10-14) Run app in simulator and verify all screens
- (2026-10-16) memory, open: calendar days come from UTC

## Completed

- (2026-10-16) wrote the README

## Key Decisions

- (2026-10-16) rewrite the memory component from scratch
`;

function writeBank(paths: ReturnType<typeof bankPaths>): void {
	writeFileSync(join(paths.root, "knowledge", "git-standards.md"), GIT_STORE);
	writeFileSync(join(paths.root, "knowledge", "macos.md"), `# macOS

## macos.pressure-widget
- kind: fact
- scope: global
- asOf: 2026-09-01
- source: this session
- status: active

The memory pressure widget lives in the menu bar.
`);
	writeFileSync(join(paths.root, "knowledge", "loose.md"), PROSE_STORE);
	writeFileSync(join(paths.root, "core", "dailyContext.md"), DAILY_CORE);
}

test("migrate: the old store grammar is readable enough to migrate from", () => {
	const store = parseLegacyStore(GIT_STORE, "knowledge/git-standards.md");
	assert.equal(store.entries.length, 3);
	assert.equal(store.entries[0]!.fields.kind, "fact");
	assert.equal(store.entries[1]!.fields.source, "user request, PR review");
	assert.match(store.entries[0]!.body, /rl-<MM>-<DD>/);
	assert.deepEqual(legacyKind(store.entries[1]!), "rule");
	assert.deepEqual(legacyKind(store.entries[0]!), "fact");
	assert.equal(legacyIsRetired(store.entries[2]!), true, "status: superseded is retired");
	assert.deepEqual(store.entries.map((entry) => entry.line), [3, 12, 22]);
});

test("migrate: old working-state items become daily-log items with their dates", () => {
	const items = legacyDailyItems(DAILY_CORE);
	assert.deepEqual(items, [
		{ section: "carry", text: "Run app in simulator and verify all screens", day: "2026-10-14" },
		{ section: "carry", text: "memory, open: calendar days come from UTC", day: "2026-10-16" },
		{ section: "completed", text: "wrote the README", day: "2026-10-16" },
		{ section: "decision", text: "rewrite the memory component from scratch", day: "2026-10-16" },
	]);
});

test("migrate: waves come from the files that exist, rules first (R38)", () => {
	const { paths, cleanup } = scratchBank();
	try {
		writeBank(paths);
		const planned = planMigration(paths, { clock: DAY });
		assert.deepEqual(planned.state.waves, ["rules", "facts:macos", "daily", "prose"]);
		assert.equal(planned.state.files["knowledge/git-standards.md"]!.wave, "rules");
		assert.equal(planned.state.files["knowledge/git-standards.md"]!.entries, 2, "retired entries are not drafted");
		assert.match(planned.state.files["knowledge/git-standards.md"]!.note!, /1 rule and 1 fact in one file/);
		assert.deepEqual(planned.retired, ["knowledge/git-standards.md:git-standards.old-flow"]);
		assert.equal(planned.state.files["knowledge/loose.md"]!.wave, "prose");
		assert.equal(planned.state.files["core/dailyContext.md"]!.wave, "daily");
		const progress = savePlan(paths, planned);
		assert.deepEqual(Object.keys(progress.files).sort(), ["core/dailyContext.md", "knowledge/git-standards.md", "knowledge/loose.md", "knowledge/macos.md"]);
	} finally {
		cleanup();
	}
});

test("migrate: every step except the backup refuses without a verified backup (R37)", () => {
	const { paths, cleanup } = scratchBank();
	try {
		writeBank(paths);
		const planned = planMigration(paths, { clock: DAY });
		savePlan(paths, planned);
		assert.ok(requireBackup(undefined));
		const next = nextDraft(paths);
		assert.equal("done" in next && next.done, true);
		assert.match((next as { reason: string }).reason, /no verified backup/);
		assert.equal(markDrafted(paths, "knowledge/git-standards.md", 2, DAY).ok, false);
		const cutover = cutoverSources(paths, DAY);
		assert.equal(cutover.ok, false);
		if (cutover.ok) return;
		assert.match(cutover.problem, /no verified backup/);
		assert.ok(existsSync(join(paths.root, "knowledge", "git-standards.md")), "the source is untouched");
	} finally {
		cleanup();
	}
});

test("migrate: after the backup gate, next hands over one file with instructions (R38)", () => {
	const { paths, cleanup } = scratchBank();
	try {
		writeBank(paths);
		savePlan(paths, planMigration(paths, { clock: DAY }));
		recordBackup(paths, { file: join(paths.backups, "memory-2026-10-16-10-00-00.tar.gz"), entries: 12 }, DAY);
		const brief = nextDraft(paths);
		assert.equal("file" in brief, true);
		if (!("file" in brief)) return;
		assert.equal(brief.file, "knowledge/git-standards.md", "the rules wave goes first");
		assert.equal(brief.wave, "rules");
		assert.deepEqual(brief.entries.map((entry) => entry.key), ["git-standards.branch-naming-convention", "git-standards.github-push-preferences"]);
		assert.deepEqual(brief.retired, ["git-standards.old-flow (superseded)"]);
		assert.match(brief.instructions, /memory_propose/);
		assert.match(brief.instructions, /origin migration/);
		assert.match(brief.instructions, /asOf the date the claim became true/);
		assert.match(brief.instructions, /memory_archive/);
		assert.match(brief.instructions, /\/memory migrate drafted knowledge\/git-standards\.md/);

		const wave = nextDraft(paths, { wave: "daily" });
		assert.equal("file" in wave && wave.file, "core/dailyContext.md");

		markDrafted(paths, "knowledge/git-standards.md", 2, DAY);
		const after = nextDraft(paths);
		assert.equal("file" in after && after.file, "knowledge/macos.md", "rules first, then facts a domain at a time");
	} finally {
		cleanup();
	}
});

test("migrate: a batch names the next files in wave order, and --file picks one by name (R38)", () => {
	const { paths, cleanup } = scratchBank();
	try {
		writeBank(paths);
		savePlan(paths, planMigration(paths, { clock: DAY }));
		const blocked = draftQueue(paths, { batch: 3 });
		assert.equal("done" in blocked, true, "the backup gate holds for a batch too");

		recordBackup(paths, { file: join(paths.backups, "memory-2026-10-16-10-00-00.tar.gz"), entries: 12 }, DAY);
		const batch = draftQueue(paths, { batch: 3 });
		assert.equal("done" in batch, false);
		if ("done" in batch) return;
		assert.deepEqual(batch.map((todo) => todo.file), ["knowledge/git-standards.md", "knowledge/macos.md", "core/dailyContext.md"]);
		assert.deepEqual(draftQueue(paths, { wave: "rules", batch: 5 }), [{ file: "knowledge/git-standards.md", wave: "rules", entries: 2 }]);

		const named = nextDraft(paths, { file: "core/dailyContext.md" });
		assert.equal("file" in named && named.file, "core/dailyContext.md", "a named file skips ahead of the queue");
		const short = nextDraft(paths, { file: "dailyContext" });
		assert.equal("file" in short, true, "a bare name matches the file it names");
		const gone = nextDraft(paths, { file: "knowledge/nope.md" });
		assert.equal("done" in gone, true);
		assert.match((gone as { reason: string }).reason, /not a file waiting to be drafted/);

		markDrafted(paths, "knowledge/git-standards.md", 2, DAY);
		const drafted = nextDraft(paths, { file: "knowledge/git-standards.md" });
		assert.equal("done" in drafted, true, "a drafted file is not handed out twice");
	} finally {
		cleanup();
	}
});

test("migrate: progress is resumable and a re-plan keeps reviewed work (R38)", () => {
	const { paths, cleanup } = scratchBank();
	try {
		writeBank(paths);
		savePlan(paths, planMigration(paths, { clock: DAY }));
		recordBackup(paths, { file: "b.tar.gz", entries: 3 }, DAY);
		markDrafted(paths, "knowledge/macos.md", 1, DAY);
		let progress = migrationProgress(paths);
		assert.deepEqual(
			{ total: progress.total, drafted: progress.drafted, todo: progress.todo, archived: progress.archived },
			{ total: 4, drafted: 1, todo: 3, archived: 0 },
		);
		assert.equal(formatMigrationProgress(progress).includes("backup: b.tar.gz (verified 2026-10-16, 3 files)"), true);

		// A second plan does not undo the drafted file.
		savePlan(paths, planMigration(paths, { clock: DAY }));
		progress = migrationProgress(paths);
		assert.equal(progress.drafted, 1);
		assert.equal(markDrafted(paths, "no/such/file.md", 1, DAY).ok, false);
	} finally {
		cleanup();
	}
});

test("migrate: apply drafts a wave through the gate and reports what it refused (R38)", () => {
	const { paths, cleanup } = scratchBank();
	try {
		writeBank(paths);
		writeFileSync(
			join(paths.root, "knowledge", "broken.md"),
			"# Broken\n\n## broken.no-date\n- kind: fact\n- scope: global\n- source: a test\n\nNo asOf anywhere.\n\n## broken.old-thing\n- kind: rule\n- scope: global\n- asOf: 2026-01-01\n- source: a test\n\nSuperseded by the newer branch rule.\n",
		);
		savePlan(paths, planMigration(paths, { clock: DAY }));

		const blocked = applyMigration(paths, { all: true, clock: DAY });
		assert.equal("done" in blocked && blocked.done, true, "the backup gate holds");

		recordBackup(paths, { file: join(paths.backups, "memory-2026-10-16-10-00-00.tar.gz"), entries: 12 }, DAY);
		const result = applyMigration(paths, { all: true, clock: DAY });
		if ("done" in result) return assert.fail(result.reason);
		assert.deepEqual(
			result.proposed.map((entry) => entry.key).sort(),
			["git-standards.branch-naming-convention", "git-standards.github-push-preferences", "macos.pressure-widget"],
		);
		const refusals = new Map(result.refused.map((entry) => [entry.key, entry.problem]));
		assert.match(refusals.get("git-standards.old-flow")!, /retired/);
		assert.match(refusals.get("broken.no-date")!, /asOf/);
		assert.match(refusals.get("broken.old-thing")!, /supersed/i);

		const snapshot = readClaims(paths);
		assert.equal(snapshot.claims.length, 3);
		assert.ok(snapshot.claims.every((claim) => claim.state === "pending" && claim.origin === "migration"));
		assert.ok(snapshot.claims.every((claim) => claim.source.startsWith("migrated from knowledge/")));

		const again = applyMigration(paths, { all: true, clock: DAY });
		assert.equal("done" in again && (again as { reason: string }).reason, "every claim file has been drafted", "resumable");
		const state = readState(paths)!;
		assert.equal(state.files["knowledge/loose.md"]!.status, "drafted", "a prose file has nothing to propose, and is still accounted for");
	} finally {
		cleanup();
	}
});

test("migrate: the working-state wave carries open items with their dates and leaves project status out (R2, R15)", () => {
	const { paths, cleanup } = scratchBank();
	try {
		writeBank(paths);
		writeFileSync(
			join(paths.root, "core", "activeProjects.md"),
			"# Active Projects\n\n## rl-pi-extensions (~/Projects/Terminal/rl-pi-extensions)\n- Status: **v1.5.0 released and pushed** (2026-10-16), head 9fa1b7c\n- Open: delete the merged local branch\n",
		);
		const planned = planMigration(paths, { clock: DAY });
		savePlan(paths, planned);
		assert.equal(planned.state.files["core/activeProjects.md"]!.wave, "daily");

		const blocked = migrateDailyItems(paths, { clock: DAY });
		assert.equal("done" in blocked && blocked.done, true, "the backup gate holds here too");

		recordBackup(paths, { file: join(paths.backups, "memory-2026-10-16-10-00-00.tar.gz"), entries: 12 }, DAY);
		const result = migrateDailyItems(paths, { clock: DAY });
		assert.equal("done" in result, false);
		if ("done" in result) return;
		assert.deepEqual(result.converted, [{ file: "core/dailyContext.md", added: 4, skipped: 0 }]);
		assert.deepEqual(result.statusOnly, [{ file: "core/activeProjects.md", items: 2 }]);
		assert.equal(result.total, 4);
		const daily = readFileSync(result.dailyFile, "utf8");
		assert.match(daily, /- \(2026-10-14\) Run app in simulator and verify all screens/);
		assert.match(daily, /- \(2026-10-16\) rewrite the memory component from scratch/);
		assert.ok(!daily.includes("9fa1b7c"), "release status never reaches the daily log");

		const again = migrateDailyItems(paths, { clock: DAY });
		assert.equal("done" in again, false);
		assert.equal("done" in again ? undefined : again.total, 0, "running it twice adds nothing");
		const progress = migrationProgress(paths);
		const state = readState(paths)!;
		assert.deepEqual(
			Object.values(state.files)
				.filter((entry) => entry.wave === "daily")
				.map((entry) => [entry.file, entry.status]),
			[
				["core/activeProjects.md", "drafted"],
				["core/dailyContext.md", "drafted"],
			],
			"both working-state files are done, and the note says what happened",
		);
		assert.match(state.files["core/activeProjects.md"]!.note!, /project status, not memory/);
		assert.equal(progress.byWave.find((wave) => wave.wave === "daily")!.done, 2);
		assert.equal(state.files["knowledge/macos.md"]!.status, "todo", "the claim waves are untouched");
	} finally {
		cleanup();
	}
});

test("migrate: cutover refuses while a source is undrafted, then archives without deleting (R39)", () => {
	const { paths, cleanup } = scratchBank();
	try {
		writeBank(paths);
		savePlan(paths, planMigration(paths, { clock: DAY }));
		recordBackup(paths, { file: "b.tar.gz", entries: 4 }, DAY);
		const blocked = cutoverSources(paths, DAY);
		assert.equal(blocked.ok, false);
		if (blocked.ok) return;
		assert.match(blocked.problem, /4 source files have not been drafted/);

		for (const file of ["knowledge/git-standards.md", "knowledge/macos.md", "knowledge/loose.md", "core/dailyContext.md"]) {
			assert.equal(markDrafted(paths, file, 1, DAY).ok, true);
		}
		const result = cutoverSources(paths, DAY);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.archived.sort(), ["core/dailyContext.md", "knowledge/git-standards.md", "knowledge/loose.md", "knowledge/macos.md"]);
		assert.deepEqual(markdownFiles(join(paths.root, "knowledge"), paths.root), [], "the sources are no longer where they were");
		const archived = markdownFiles(paths.archive, paths.root).map((file) => file.split("/").pop());
		assert.deepEqual(archived.sort(), ["dailyContext.md", "git-standards.md", "loose.md", "macos.md"]);
		assert.match(readFileSync(join(paths.archive, "git-standards.md"), "utf8"), /Never push changes to GitHub without explicit confirmation/);
		assert.equal(migrationProgress(paths).archived, 4);
	} finally {
		cleanup();
	}
});

test("migrate: a bank with no legacy sources plans nothing and says so", () => {
	const { paths, cleanup } = scratchBank();
	try {
		const planned = planMigration(paths, { clock: DAY });
		assert.deepEqual(planned.state.waves, []);
		assert.deepEqual(Object.keys(planned.state.files), []);
		savePlan(paths, planned);
		recordBackup(paths, { file: "b.tar.gz", entries: 0 }, DAY);
		const next = nextDraft(paths);
		assert.equal("done" in next && next.done, true);
		assert.match((next as { reason: string }).reason, /every source file has been drafted/);
	} finally {
		cleanup();
	}
});
