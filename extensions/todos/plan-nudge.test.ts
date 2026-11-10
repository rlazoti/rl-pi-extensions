/**
 * The plan nudge, as a table: what counts as work, and when the ask is spent.
 *
 * The rule exists because a session that never plans is never told to plan — so
 * the two failures to test are the two directions of being wrong: nagging a
 * session that is only answering a question (or doing one small job), and staying
 * silent in front of a long one. The counted unit is the **turn**, which is what
 * distinguishes those two: two live sessions both did three file changes and both
 * rightly ignored the ask, because each finished in a single turn.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FILE_MUTATING_TOOLS, PLAN_NUDGE_REMINDER, PLAN_NUDGE_THRESHOLD, PlanNudge } from "./plan-nudge.ts";

interface Call {
	tool: string;
	turn: number;
}

/** N file changes, each in its own turn — the shape of work that lasts. */
function turns(n: number, tool = "edit"): Call[] {
	return Array.from({ length: n }, (_unused, index) => ({ tool, turn: index + 1 }));
}

/** N file changes issued together — one turn of work, however many files. */
function batch(n: number, tool = "edit"): Call[] {
	return Array.from({ length: n }, () => ({ tool, turn: 1 }));
}

/** Walk the calls and report the 1-based positions the nudge rode on. */
function walk(calls: Call[], options: { hasTasks?: boolean; enabled?: boolean } = {}): number[] {
	const nudge = new PlanNudge(options.enabled ?? true);
	const fired: number[] = [];
	calls.forEach((call, index) => {
		if (nudge.note(call.tool, options.hasTasks ?? false, call.turn)) fired.push(index + 1);
	});
	return fired;
}

describe("what counts", () => {
	it("asks on the threshold-th turn containing a file change", () => {
		assert.deepEqual(walk(turns(PLAN_NUDGE_THRESHOLD)), [PLAN_NUDGE_THRESHOLD]);
	});

	it("stays silent for a batch: three files, one turn, one job", () => {
		assert.deepEqual(
			walk(batch(PLAN_NUDGE_THRESHOLD * 3)),
			[],
			"a call-count trigger fired on two real one-turn sessions and was ignored by both",
		);
	});

	it("counts every tool that can change files", () => {
		for (const tool of ["edit", "write", "bash", "powershell"]) {
			assert.ok(FILE_MUTATING_TOOLS.has(tool), `${tool} is how a session does work`);
		}
	});

	it("ignores the read-only tools, so a question costs nothing", () => {
		const calls = turns(PLAN_NUDGE_THRESHOLD * 4).map((call) => ({ ...call, tool: "read" }));
		["find", "grep", "ls", "web_search", "memory_read"].forEach((tool, index) =>
			calls.push({ tool, turn: 100 + index }),
		);
		assert.deepEqual(walk(calls), [], "answering a question is not multi-step work");
	});

	it("counts a turn that mixes tools as one, and ignores quiet turns between", () => {
		const calls: Call[] = [
			{ tool: "read", turn: 1 },
			{ tool: "edit", turn: 2 },
			{ tool: "write", turn: 2 },
			{ tool: "bash", turn: 2 },
			{ tool: "read", turn: 3 },
			{ tool: "edit", turn: 4 },
			{ tool: "bash", turn: 6 },
		];
		assert.deepEqual(walk(calls), [7], "three turns of work, reached on the sixth turn");
	});
});

describe("when the ask is spent", () => {
	it("asks once per session", () => {
		assert.deepEqual(walk(turns(PLAN_NUDGE_THRESHOLD * 3)), [PLAN_NUDGE_THRESHOLD]);
	});

	it("never speaks while there is a list, however many turns", () => {
		assert.deepEqual(walk(turns(PLAN_NUDGE_THRESHOLD * 4), { hasTasks: true }), [], "the question is already answered");
	});

	it("re-arms only after a list existed and went away", () => {
		const nudge = new PlanNudge();
		const at = (turn: number) => nudge.note("edit", false, turn);

		assert.equal(at(1), false);
		assert.equal(at(2), false);
		assert.equal(at(3), true);
		assert.equal(at(4), false, "spent for this session");

		nudge.note("edit", true, 5); // the model planned; the count and the ask are reset
		assert.equal(at(6), false);
		assert.equal(at(7), false);
		assert.equal(at(8), true, "a list that was cleared is open work again");
	});

	it("starts over when the session does", () => {
		const nudge = new PlanNudge();
		nudge.note("edit", false, 1);
		nudge.note("edit", false, 2);
		nudge.reset();
		assert.equal(nudge.note("edit", false, 1), false);
		assert.equal(nudge.note("edit", false, 2), false);
		assert.equal(nudge.note("edit", false, 3), true, "a new session owes the full count");
	});

	it("stays off when the config says so", () => {
		assert.deepEqual(walk(turns(PLAN_NUDGE_THRESHOLD * 2), { enabled: false }), [], "planNudge: false means inert, not quieter");
	});

	it("takes the flag from reset, which is where the config is re-read", () => {
		const nudge = new PlanNudge(true);
		nudge.reset(false);
		for (const turn of [1, 2, 3, 4]) assert.equal(nudge.note("edit", false, turn), false, "off is off");

		nudge.reset(true);
		assert.equal(nudge.note("edit", false, 1), false);
		assert.equal(nudge.note("edit", false, 2), false);
		assert.equal(nudge.note("edit", false, 3), true, "and back on, with a fresh count");
	});
});

describe("the reminder text", () => {
	it("names the evidence it is acting on, and the tools to call", () => {
		assert.match(PLAN_NUDGE_REMINDER, new RegExp(`${PLAN_NUDGE_THRESHOLD} separate turns`));
		assert.match(PLAN_NUDGE_REMINDER, /<system-reminder>/);
		assert.match(PLAN_NUDGE_REMINDER, /TodoCreate/);
		assert.match(PLAN_NUDGE_REMINDER, /TodoUpdate/);
	});

	it("asks for a one-line refusal rather than silence, so declining is visible", () => {
		assert.match(PLAN_NUDGE_REMINDER, /say so in one line/);
	});
});
