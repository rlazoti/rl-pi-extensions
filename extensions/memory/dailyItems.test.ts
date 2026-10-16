import assert from "node:assert/strict";
import test from "node:test";

import { ageItems, parseDailyItems, pruneDailyBody, stampDailyFile, isItem, type DailyItem } from "./dailyItems.ts";
import { isOpenHeading } from "./rollover.ts";

const item = (date: string | null, text: string): DailyItem => ({ date, text, raw: date === null ? `- ${text}` : `- (${date}) ${text}`, indent: "" });

// ─── Reading items ──────────────────────────────────────────────────────────

test("an item carries its date in the text, and the text is kept clean", () => {
	const parsed = parseDailyItems("- (2026-10-11) verify the simulator\n- push when approved\n").filter(isItem);
	assert.deepEqual(parsed.map((entry) => [entry.date, entry.text]), [["2026-10-11", "verify the simulator"], [null, "push when approved"]]);
});

test("a nested bullet belongs to the item above it, not to the list", () => {
	const parsed = parseDailyItems("- (2026-10-11) verify the simulator\n  - the settings screen specifically\n").filter(isItem);
	assert.equal(parsed.length, 1);
	assert.match(parsed[0]!.text, /settings screen specifically/);
});

test("a heading-looking line inside a fence is not an item and not a section", () => {
	const parsed = parseDailyItems("- run the gate:\n```\n- (2020-01-01) not an item\n```\n");
	assert.equal(parsed.filter(isItem).length, 1);
});

// ─── Stamping: what the rollover could not know before ───────────────────────

test("stamping uses the day the file was about, never today", () => {
	const pruned = pruneDailyBody("- verify the simulator\n- push when approved\n", "2026-10-14", { stampWith: "2026-10-03" });
	assert.equal(pruned.stamped, 2);
	assert.equal(pruned.text, "- (2026-10-03) verify the simulator\n- (2026-10-03) push when approved");
});

test("an already-dated item is left exactly as written", () => {
	const pruned = pruneDailyBody("- (2026-09-01)old item\n", "2026-10-14", { stampWith: "2026-10-14", retireAfterDays: 999 });
	assert.equal(pruned.stamped, 0);
	assert.equal(pruned.text, "- (2026-09-01)old item");
});

test("stampDailyFile touches only open sections and leaves the rest byte for byte", () => {
	const text = `# Daily Context

- date: 2026-10-14

## Completed
- (2026-10-14) shipped it

## Next Steps
- verify the simulator
- (2026-10-12) push when approved

## Random Notes
- some prose that is not a task
`;
	const stamped = stampDailyFile(text, "2026-10-14", isOpenHeading);
	assert.equal(stamped.stamped, 1, "only the undated bullet under Next Steps");
	assert.match(stamped.text, /## Next Steps\n- \(2026-10-14\) verify the simulator\n- \(2026-10-12\) push when approved/);
	assert.match(stamped.text, /## Completed\n- \(2026-10-14\) shipped it/);
	assert.match(stamped.text, /## Random Notes\n- some prose that is not a task/);
});

// ─── Ageing: keeping too much is safer than losing work ─────────────────────

test("old items stop being carried, and are reported by age", () => {
	const items = [item("2026-01-01", "ancient"), item("2026-10-12", "recent")];
	const aged = ageItems(items, "2026-10-14", { retireAfterDays: 21 });
	assert.deepEqual(aged.carry.map((entry) => entry.text), ["recent"]);
	assert.deepEqual(aged.retired.map((entry) => entry.text), ["ancient"]);
});

test("an item with no date is never retired — unknown age is not an excuse to drop work", () => {
	const aged = ageItems([item(null, "undated but real")], "2026-10-14", { retireAfterDays: 1 });
	assert.deepEqual(aged.carry.map((entry) => entry.text), ["undated but real"]);
	assert.deepEqual(aged.retired, []);
});

test("the cap keeps the newest items and reports the rest, without reshuffling what is kept", () => {
	const items = [item("2026-10-01", "oldest"), item("2026-10-13", "newest"), item("2026-10-02", "middle")];
	const aged = ageItems(items, "2026-10-14", { maxItems: 2 });
	assert.deepEqual(aged.carry.map((entry) => entry.text), ["newest", "middle"], "the two newest survive, still in the order they were written");
	assert.deepEqual(aged.capped.map((entry) => entry.text), ["oldest"], "the one that did not make the cut is reported, not hidden");
});

test("pruning a body reports every drop, so nothing leaves the file silently", () => {
	const body = "- (2025-01-01) ancient intention\n- (2026-10-13) fresh intention\n";
	const pruned = pruneDailyBody(body, "2026-10-14", { retireAfterDays: 21 });
	assert.equal(pruned.text, "- (2026-10-13) fresh intention");
	assert.deepEqual(pruned.retired.map((entry) => entry.text), ["ancient intention"]);
	assert.deepEqual(pruned.capped, []);
});
