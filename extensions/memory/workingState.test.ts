import assert from "node:assert/strict";
import test from "node:test";

import { renderWorkingState, DEFAULT_STATE_BUDGET } from "./workingState.ts";

/**
 * The working-state block is the only place the two hand-written bank files reach the
 * model, so these tests are about what the model *reads*: nothing dropped silently,
 * nothing truncated mid-line, nothing settled presented as current, and no wording that
 * could be mistaken for an authority.
 */

const PROJECTS = `# Active Projects

## rl-pi-extensions (~/Projects/Terminal/rl-pi-extensions)
- Status: v1.4.1 released and pushed
- Components: manager + 6 extensions
`;

const FRESH_DAILY = `- date: 2026-10-16

## In Progress

### Money Manager

- (2026-10-15) verify the simulator build
- (2026-10-16) bump the Pi pins when the runtime updates

## Completed

- shipped v1.4.1

## Notes

loose prose that is not work
`;

test("both files are injected, in a fixed order, under a header that denies authority", () => {
	const result = renderWorkingState({ activeProjects: PROJECTS, daily: { text: FRESH_DAILY }, today: "2026-10-16" });

	assert.match(result.text, /^## Working state — hand-maintained files, not entry stores and not authorities/);
	assert.ok(result.text.indexOf("core/activeProjects.md") < result.text.indexOf("core/dailyContext.md"), "projects before the day's work");
	assert.match(result.text, /- Status: v1\.4\.1 released and pushed/);
	assert.match(result.text, /verify the simulator build/);
	assert.equal(result.activeProjects.exists, true);
	assert.equal(result.daily.exists, true);
	assert.ok(result.tokens > 0 && result.tokens === Math.ceil(result.text.length / 4), "the reported cost is the cost of what was rendered");
});

test("the same bank on the same day renders byte-identically", () => {
	const input = { activeProjects: PROJECTS, daily: { text: FRESH_DAILY }, today: "2026-10-16" };
	assert.equal(renderWorkingState(input).text, renderWorkingState(input).text);
});

test("open work is recognised by position, not only by its own name", () => {
	// `### Money Manager` is not an open heading; `## In Progress` above it already said so.
	const result = renderWorkingState({ activeProjects: null, daily: { text: FRESH_DAILY }, today: "2026-10-16" });
	assert.match(result.text, /\*\*Money Manager\*\*/);
	assert.match(result.text, /verify the simulator build/);
	assert.equal(result.daily.items, 2);
});

test("settled work, notes, and a previous rollover's provenance line stay out of the prompt", () => {
	const daily = `## In Progress\n_(carried from 2026-10-14 — 2 days old)_\n\n- (2026-10-14) open work\n\n## Completed\n- shipped v1.4.1\n\n## Notes\nloose prose\n`;
	const result = renderWorkingState({ activeProjects: null, daily: { text: daily }, today: "2026-10-16" });

	assert.match(result.text, /open work/);
	assert.equal(result.text.includes("shipped v1.4.1"), false, "settled work belongs in the archive, not the prompt");
	assert.equal(result.text.includes("loose prose"), false);
	assert.equal(result.text.includes("carried from"), false, "the annotation is provenance, not another item to act on");
});

test("the cap drops whole items and counts them; it never cuts a line in half", () => {
	const daily = `- date: 2026-10-16\n\n## Next Steps\n- ${"a long open item that takes up most of the allowance ".repeat(4)}\n- short open item\n`;
	const result = renderWorkingState({ activeProjects: null, daily: { text: daily }, today: "2026-10-16", budget: { daily: 60 } });

	assert.ok(result.daily.droppedItems >= 1, "something must be dropped for this to mean anything");
	assert.equal(result.daily.shownItems + result.daily.droppedItems, result.daily.items);
	assert.match(result.text, /further open item\(s\) did not fit this turn — the rest with memory_read core\/dailyContext\.md/);

	const rendered = result.text.split("\n").filter((line) => line.startsWith("- "));
	for (const line of rendered) assert.ok(daily.includes(line.slice(2)), `every rendered item is a whole item as written: ${line}`);
});

test("when the cap bites, undated items and the newest dated ones survive", () => {
	const daily = `- date: 2026-10-16\n\n## In Progress\n- (2026-09-01) oldest\n- (2026-10-16) newest\n- undated\n`;
	const result = renderWorkingState({ activeProjects: null, daily: { text: daily }, today: "2026-10-16", budget: { daily: 22 } });

	assert.match(result.text, /- undated/, "unknown age is not a reason to drop first — the rollover ages the same way");
	assert.match(result.text, /\(2026-10-16\) newest/);
	assert.equal(result.text.includes("oldest"), false);
	assert.equal(result.daily.droppedItems, 1);
});

test("the daily block is rendered in document order even though selection is by age", () => {
	const daily = `- date: 2026-10-16\n\n## In Progress\n- (2026-10-14) first in the file\n- (2026-10-16) second in the file\n`;
	const result = renderWorkingState({ activeProjects: null, daily: { text: daily }, today: "2026-10-16" });
	assert.ok(result.text.indexOf("first in the file") < result.text.indexOf("second in the file"));
});

test("a stale daily file carries its date and the caution; a current one carries neither", () => {
	const stale = renderWorkingState({ activeProjects: null, daily: { text: `- date: 2026-10-03\n\n## In Progress\n- work\n` }, today: "2026-10-16" });
	assert.match(stale.text, /open work \(2026-10-03\)/);
	assert.match(stale.text, /is dated 2026-10-03 \(13 day\(s\) old\)/);
	assert.match(stale.text, /may no longer be true; say so rather than repeating them/);
	assert.equal(stale.daily.stale, true);

	const fresh = renderWorkingState({ activeProjects: null, daily: { text: `- date: 2026-10-16\n\n## In Progress\n- work\n` }, today: "2026-10-16" });
	assert.equal(fresh.text.includes("may no longer be true"), false);
	assert.equal(fresh.text.includes("dated 2026-10-16 ("), false);
});

test("an undated daily file says its day was inferred, and is not treated as current", () => {
	const result = renderWorkingState({ activeProjects: null, daily: { text: "# Daily Context - Money Manager\n\n## Next Steps\n- work\n", modified: "2026-10-11" }, today: "2026-10-16" });

	assert.match(result.text, /inferred from the file's modification time/);
	assert.match(result.text, /dated by file mtime because the file has no date field/);
	assert.equal(result.daily.needsDate, true);
	assert.equal(result.daily.stale, true, "an undated file is never assumed to be today's work");
});

test("a daily file with nothing open still says so, rather than going silent", () => {
	const result = renderWorkingState({ activeProjects: null, daily: { text: `- date: 2026-10-03\n\n## Completed\n- all done\n` }, today: "2026-10-16" });
	assert.match(result.text, /No open work recognised under its headings/);
	assert.match(result.text, /may no longer be true/, "the caveat survives even when there is no work to caveat");
	assert.equal(result.daily.items, 0);
});

test("activeProjects is cut at whole lines and names the tool that shows the rest", () => {
	const result = renderWorkingState({ activeProjects: PROJECTS, daily: null, today: "2026-10-16", budget: { activeProjects: 40 } });

	assert.ok(result.activeProjects.droppedLines > 0);
	assert.equal(result.activeProjects.shownLines + result.activeProjects.droppedLines, result.activeProjects.lines);
	assert.match(result.text, /lines fit this turn — the rest with memory_read core\/activeProjects\.md/);
	// Never a fragment of a line: half a bullet is a different bullet.
	const body = result.text.split(`### core/activeProjects.md\n`)[1]!.split("\n_")[0]!;
	for (const line of body.split("\n")) assert.ok(PROJECTS.includes(line), `rendered line is whole as written: ${line}`);
});

test("nothing to say means nothing injected — no header, no tokens", () => {
	const empty = renderWorkingState({ activeProjects: null, daily: null, today: "2026-10-16" });
	assert.equal(empty.text, "");
	assert.equal(empty.tokens, 0);
	assert.equal(renderWorkingState({ activeProjects: "\n\n ", daily: { text: "" }, today: "2026-10-16" }).text, "");
});

test("the caps are the documented defaults, and a caller can lower them", () => {
	const small = renderWorkingState({ activeProjects: PROJECTS, daily: { text: FRESH_DAILY }, today: "2026-10-16", budget: { activeProjects: 10, daily: 10 } });
	const roomy = renderWorkingState({ activeProjects: PROJECTS, daily: { text: FRESH_DAILY }, today: "2026-10-16" });

	assert.ok(roomy.activeProjects.shownLines > small.activeProjects.shownLines);
	assert.ok(roomy.daily.shownItems > small.daily.shownItems);
	assert.deepEqual(DEFAULT_STATE_BUDGET, { activeProjects: 600, daily: 500 }, "the numbers the extension runs with — changing one is a deliberate edit");
});

test("the block never claims authority, and never mentions the entry-store machinery", () => {
	const result = renderWorkingState({ activeProjects: PROJECTS, daily: { text: FRESH_DAILY }, today: "2026-10-16" });
	for (const forbidden of ["authoritative for this context", "kind · ", "supersede", "conflictId"]) {
		assert.equal(result.text.includes(forbidden), false, `working state is not the authority surface: ${forbidden}`);
	}
});
