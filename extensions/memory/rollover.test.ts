import assert from "node:assert/strict";
import test from "node:test";

import { dailyDate, dailyFreshness, isOpenHeading, isSettledHeading, planDailyRollover, renderRolloverNotice } from "./rollover.ts";

const TODAY = "2026-10-14";

const MIXED = `# Daily Context - Money Manager

## Completed
- Fixed build errors across 39 files

## In Progress
- Simulator verification pending

## Key Decisions
- Dormant while other work continues

## Next Steps
- Resume when the other project ships
`;

const GROUPED = `## Money Manager

### Completed
- Categories & Tags spec written

### In Progress
- Simulator verification pending

## rl-pi-extensions

### Handoff
- Push the branch when approved
`;

// ─── When a rollover happens, and when it does not ──────────────────────────

test("a daily file dated today is left alone", () => {
	assert.equal(planDailyRollover({ text: `- date: ${TODAY}\n\n## Open work\n- x\n` }, TODAY), null);
});

test("a daily file dated yesterday is archived verbatim and a fresh one is written", () => {
	const plan = planDailyRollover({ text: `- date: 2026-10-13\n\n## In Progress\n- verify the build\n` }, TODAY)!;

	assert.equal(plan.archivePath, "history/daily/2026-10/2026-10-13-dailyContext.md");
	assert.equal(plan.archiveText, `- date: 2026-10-13\n\n## In Progress\n- verify the build\n`, "an archive is a record: not re-rendered, not tidied");
	assert.match(plan.freshText, /^# Daily Context — 2026-10-14/);
	assert.match(plan.freshText, /^- date: 2026-10-14$/m, "the fresh file carries the machine-readable field the old one lacked");
	assert.match(plan.freshText, /^- carried from: 2026-10-13$/m);
	assert.match(plan.freshText, /verify the build/);
});

test("the date field wins over a date mentioned in the text", () => {
	const date = dailyDate({ text: `- date: 2026-10-01\n\nStarted on 2026-09-04, see also 2026-10-11.\n` });
	assert.deepEqual(date, { date: "2026-10-01", source: "header" });
});

test("an undated file is dated by modification time, and says so", () => {
	const file = { text: "# Daily Context - Money Manager\n\n## Completed\n- work\n", modified: "2026-10-03" };
	assert.deepEqual(dailyDate(file), { date: "2026-10-03", source: "mtime" });
	const freshness = dailyFreshness(file, TODAY);
	assert.equal(freshness.stale, true);
	assert.equal(freshness.needsDate, true);

	const plan = planDailyRollover(file, TODAY)!;
	assert.equal(plan.archivePath, "history/daily/2026-10/2026-10-03-dailyContext.md");
	assert.match(plan.freshText, /carried from: 2026-10-03 \(recovered from the file's modification time: the file had no date field\)/);
});

test("an undated file last touched today is not rolled over, but is reported as needing a date", () => {
	const file = { text: "# Daily Context\n\n## In Progress\n- still working\n", modified: TODAY };
	assert.equal(planDailyRollover(file, TODAY), null);
	assert.equal(dailyFreshness(file, TODAY).needsDate, true);
});

test("rolling over the fresh file does nothing: no churn, no archive pile-up", () => {
	const first = planDailyRollover({ text: `- date: 2026-10-13\n\n## Next Steps\n- one task\n` }, TODAY)!;
	assert.equal(planDailyRollover({ text: first.freshText }, TODAY), null);
});

// ─── What is carried, and what is reported ──────────────────────────────────

test("open work is recognised by meaning, not by one exact heading", () => {
	for (const heading of ["In Progress", "Next Steps", "Handoff", "Blocked", "Todo", "carried forward", "still open", "Waiting on"]) {
		assert.ok(isOpenHeading(heading), `"${heading}" should count as open work`);
	}
	for (const heading of ["Completed", "Key Decisions", "Done", "Shipped", "Outcomes"]) {
		assert.ok(isSettledHeading(heading), `"${heading}" should count as settled`);
	}
	assert.equal(isOpenHeading("Completed"), false);
	assert.equal(isOpenHeading("Carried away from home"), false, "alias matching is on whole headings, not prefixes");
});

test("open sections are carried and settled ones are reported with a reason", () => {
	const plan = planDailyRollover({ text: MIXED, modified: "2026-10-03" }, TODAY)!;
	assert.deepEqual(plan.carried.map((entry) => entry.heading), ["In Progress", "Next Steps"]);
	const reasons = new Map(plan.notCarried.map((item) => [item.heading, item.reason]));
	assert.match(reasons.get("Completed")!, /entry store/);
	assert.match(reasons.get("Key Decisions")!, /entry store/);
	assert.match(plan.freshText, /Simulator verification pending/);
	assert.equal(plan.freshText.includes("Fixed build errors"), false, "settled work is not carried into today's working file");
});

test("an unrecognised heading is not carried silently: it is named, with alternatives offered", () => {
	const plan = planDailyRollover({ text: `- date: 2026-10-13\n\n## Vibes\n- it is going fine\n`, }, TODAY)!;
	assert.deepEqual(plan.carried, []);
	assert.equal(plan.notCarried.length, 1);
	assert.match(plan.notCarried[0]!.heading, /^Vibes$/);
	assert.match(plan.notCarried[0]!.reason, /Next Steps \/ In Progress \/ Handoff \/ Blocked/);
});

test("project grouping survives the rollover, and only the open parts of it", () => {
	const plan = planDailyRollover({ text: GROUPED, modified: "2026-10-12" }, TODAY)!;
	assert.deepEqual(plan.carried.map((entry) => `${entry.group} / ${entry.heading}`), ["Money Manager / In Progress", "rl-pi-extensions / Handoff"]);
	assert.match(plan.freshText, /## Money Manager/);
	assert.match(plan.freshText, /## rl-pi-extensions/);
	// The group is the section heading, so the carried heading does not repeat it.
	assert.match(plan.freshText, /## rl-pi-extensions\n\n### Handoff \(from 2026-10-12, 2 days old\)/);
	assert.equal(plan.freshText.includes("Categories & Tags spec written"), false);
});

test("a group with no open work is reported rather than dropped", () => {
	const plan = planDailyRollover({ text: `- date: 2026-10-13\n\n## Old Project\n### Completed\n- shipped it\n`, }, TODAY)!;
	assert.deepEqual(plan.carried, []);
	assert.ok(plan.notCarried.some((item) => item.heading === "Old Project" && /no open work/.test(item.reason)));
});

test("carried work shows its age, so a stale intention does not read as current", () => {
	const plan = planDailyRollover({ text: `- date: 2026-10-03\n\n## In Progress\n- verify the simulator\n`, }, TODAY)!;
	assert.equal(plan.carried[0]!.ageDays, 11);
	assert.match(plan.freshText, /### In Progress \(from 2026-10-03, 11 days old\)/);

	const yesterday = planDailyRollover({ text: `- date: 2026-10-13\n\n## In Progress\n- verify the simulator\n`, }, TODAY)!;
	assert.match(yesterday.freshText, /### In Progress \(from 2026-10-13\)/);
});

test("an empty carry is stated, not left as a blank file that looks like nothing happened", () => {
	const plan = planDailyRollover({ text: `- date: 2026-10-13\n\n## Completed\n- all shipped\n`, }, TODAY)!;
	assert.match(plan.freshText, /Nothing was carried forward/);
	assert.match(plan.freshText, /archived/);
});

test("fenced code inside a section survives the carry intact", () => {
	const text = `- date: 2026-10-13\n\n## Next Steps\n\nRun the gate:\n\n\`\`\`\n## not a heading inside a fence\nnpm run typecheck\n\`\`\`\n`;
	const plan = planDailyRollover({ text }, TODAY)!;
	assert.equal(plan.carried.length, 1);
	assert.match(plan.carried[0]!.text, /## not a heading inside a fence/);
	assert.match(plan.freshText, /npm run typecheck/);
});

test("the notice says where the archive went and what did not make it", () => {
	const plan = planDailyRollover({ text: MIXED, modified: "2026-10-03" }, TODAY)!;
	const notice = renderRolloverNotice(plan);
	assert.match(notice, /archived to history\/daily\/2026-10\/2026-10-03-dailyContext\.md/);
	assert.match(notice, /carried 2 open-work section\(s\)/);
	assert.match(notice, /2 not carried \(Completed, Key Decisions\)/);
});

test("an undated file with no mtime is archived under an explicit undated name", () => {
	const plan = planDailyRollover({ text: "## Next Steps\n- no date anywhere\n" }, TODAY)!;
	assert.equal(plan.from.source, "missing");
	assert.equal(plan.archivePath, `history/daily/${TODAY.slice(0, 7)}/undated-${TODAY}-dailyContext.md`);
});
