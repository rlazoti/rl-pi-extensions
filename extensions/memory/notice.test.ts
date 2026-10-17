import assert from "node:assert/strict";
import test from "node:test";

import { createNoticeSink, reviewNotice } from "./notice.ts";
import type { QueueCounts } from "./queue.ts";

function counts(overrides: Partial<QueueCounts> = {}): QueueCounts {
	return {
		agentProposals: 0,
		migrationBacklog: 0,
		contested: [],
		flagged: [],
		coarseDates: 0,
		total: 0,
		...overrides,
	};
}

const OPTS = { pendingFlagDays: 14 };

test("notice: nothing is shown when nothing waits (R20)", () => {
	assert.equal(reviewNotice(counts(), OPTS), undefined);
	assert.equal(reviewNotice(counts({ total: 0 }), OPTS), undefined);
});

test("notice: one line, counting each category separately (R20, D9)", () => {
	const notice = reviewNotice(
		counts({
			agentProposals: 1,
			migrationBacklog: 2,
			total: 3,
		}),
		OPTS,
	);
	assert.equal(notice, "memory: 3 claims await review — 1 proposal from the agent; 2 migrated claims (migration backlog). Run /memory review.");
});

test("notice: contests and old proposals are named, not just counted", () => {
	const notice = reviewNotice(
		counts({
			agentProposals: 4,
			total: 4,
			contested: [{ key: "git.flow", scope: "global", files: ["claims/rules/git.md:3", "claims/rules/git.md:12"] }],
			flagged: [{ claim: { key: "old.rule" } as never, ageDays: 30, flagged: true, dateSource: "proposedAt", file: "claims/rules/old.md" }],
			coarseDates: 2,
		}),
		OPTS,
	);
	assert.match(notice!, /1 contested identity/);
	assert.match(notice!, /1 waiting longer than 14 days/);
	assert.match(notice!, /contested — git\.flow @ global \(claims\/rules\/git\.md:3, claims\/rules\/git\.md:12\): nothing is injected for it/);
	assert.match(notice!, /2 of them have no proposal date, so their age is counted from the claim's own date/);
});

test("notice: a long contest list is capped and says so", () => {
	const notice = reviewNotice(
		counts({
			total: 0,
			contested: [1, 2, 3, 4, 5].map((n) => ({ key: `k${n}.key`, scope: "global", files: [`f${n}.md`] })),
		}),
		OPTS,
	);
	assert.match(notice!, /5 contested identities/);
	const named = notice!.split("\n").filter((line) => line.includes("contested —"));
	assert.equal(named.length, 3);
	assert.match(notice!, /…and 2 more contested identities/);
});

test("notice: bank damage is said even when nothing is pending", () => {
	const notice = reviewNotice(counts(), { ...OPTS, bankDamage: ["one store could not be read (broken.md)", "a half-written file was left behind (git.md.tmp-42)"] });
	assert.equal(notice, "memory: one store could not be read (broken.md)\nmemory: a half-written file was left behind (git.md.tmp-42)");
});

test("notice: the TUI gets a notification and nothing else is asked", () => {
	const notified: string[] = [];
	const logged: string[] = [];
	const sink = createNoticeSink({ isTui: true, notify: (text) => notified.push(text), log: (text) => logged.push(text) });
	const result = sink.deliver(reviewNotice(counts({ agentProposals: 1, total: 1 }), OPTS));
	assert.equal(result, "shown");
	assert.equal(notified.length, 1);
	assert.deepEqual(logged, []);
	assert.deepEqual(sink.state, { shown: 1, logged: 0 });
});

test("notice: outside a TUI it is written once to the log (R20)", () => {
	const notified: string[] = [];
	const logged: string[] = [];
	const sink = createNoticeSink({ isTui: false, notify: (text) => notified.push(text), log: (text) => logged.push(text) });
	assert.equal(sink.deliver("first"), "logged");
	assert.equal(sink.deliver("second"), "logged");
	assert.deepEqual(logged, ["first"], "the log gets one copy");
	assert.deepEqual(notified, []);
	assert.deepEqual(sink.state, { shown: 0, logged: 2 });
});

test("notice: an empty notice reaches nothing at all", () => {
	const calls: string[] = [];
	const sink = createNoticeSink({ isTui: true, notify: (text) => calls.push(text), log: (text) => calls.push(text) });
	assert.equal(sink.deliver(reviewNotice(counts(), OPTS)), "silent");
	assert.deepEqual(calls, []);
	assert.deepEqual(sink.state, { shown: 0, logged: 0 });
});
