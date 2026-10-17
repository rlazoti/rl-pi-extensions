import assert from "node:assert/strict";
import test from "node:test";

import { dayOf, daysBetween, describeAge, isDay, monthOf, stampOf, systemClock } from "./time.ts";

test("time: a day is the local calendar day, not the UTC one", () => {
	const previous = process.env.TZ;
	process.env.TZ = "America/Chicago";
	try {
		// 02:30Z is 21:30 the previous evening in CDT: the UTC day is already ahead.
		const late = new Date("2026-10-17T02:30:00Z");
		assert.equal(dayOf(late), "2026-10-16");
		assert.equal(late.toISOString().slice(0, 10), "2026-10-17", "the helper exists precisely because this is the wrong answer");
		assert.equal(stampOf(late), "2026-10-16 21:30");
		assert.equal(monthOf(dayOf(late)), "2026-10");
	} finally {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	}
});

test("time: systemClock gives a real Date", () => {
	assert.ok(systemClock() instanceof Date);
});

test("time: isDay accepts real days and refuses invented ones", () => {
	for (const good of ["2026-01-01", "2026-10-16", "2028-02-29"]) assert.ok(isDay(good), good);
	for (const bad of ["", "today", "16-10-2026", "2026-13-01", "2026-00-10", "2026-02-30", "2026-1-1", "20260101"]) assert.ok(!isDay(bad), bad);
});

test("time: day arithmetic is whole days and survives a daylight-saving week", () => {
	assert.equal(daysBetween("2026-03-07", "2026-03-09"), 2, "the US spring-forward week is still 48 hours of days");
	assert.equal(daysBetween("2026-10-16", "2026-10-16"), 0);
	assert.equal(daysBetween("2026-10-20", "2026-10-16"), -4, "a future-dated record reads as negative, not as zero");
	assert.equal(daysBetween("2026-10-16", "2026-11-15"), 30);
	assert.equal(daysBetween("not a day", "2026-10-16"), 0);
});

test("time: ages are said the way a human would say them", () => {
	assert.equal(describeAge("2026-10-16", "2026-10-16"), "today");
	assert.equal(describeAge("2026-10-17", "2026-10-16"), "today", "a future date is not an age");
	assert.equal(describeAge("2026-10-15", "2026-10-16"), "1 day");
	assert.equal(describeAge("2026-10-06", "2026-10-16"), "10 days");
	assert.equal(describeAge("2026-09-16", "2026-10-16"), "4 weeks");
	assert.equal(describeAge("2026-01-16", "2026-10-16"), "9 months");
});
