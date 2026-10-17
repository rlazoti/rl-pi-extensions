import assert from "node:assert/strict";
import test from "node:test";

import { detectStatus, detectSupersession, formatSignals, gateDaily, gatePropose, type StatusSignalKind } from "./gate.ts";
import type { Claim } from "./grammar.ts";

function claim(body: string, overrides: Partial<Claim> = {}): Claim {
	return {
		key: "git.flow",
		kind: "rule",
		scope: "global",
		asOf: "2026-10-16",
		source: "Rodrigo, PR review",
		body,
		aliases: [],
		tags: [],
		links: [],
		origin: "agent",
		state: "pending",
		...overrides,
	};
}

const STATUS: { body: string; kinds: StatusSignalKind[] }[] = [
	{ body: "Merged 9fa1b7c into main on 2026-10-16.", kinds: ["sha", "dated-verb"] },
	{ body: "PR #1284 fixed the picker.", kinds: ["number"] },
	{ body: "issue 42 stays open", kinds: ["number"] },
	{ body: "run 98712 was red", kinds: ["number"] },
	{ body: "See https://github.com/rlazoti/rl-pi-extensions/actions/runs/12345", kinds: ["ci-url"] },
	{ body: "The suite failed on 2026-10-14.", kinds: ["dated-verb"] },
	{ body: "2026-10-02: deployed to the site", kinds: ["dated-verb"] },
	{ body: "The commit 4c142dc fixed the README numbers.", kinds: ["sha"] },
	{ body: "Reverted deadbeefcafe from release.", kinds: ["sha"] },
	{ body: "Published v1.5.0 on Oct 16.", kinds: ["dated-verb"] },
];

const NOT_STATUS: string[] = [
	"Never push to GitHub without explicit confirmation.",
	"All Git branches are named rl-<MM>-<DD>-<short_description> with the local month and day.",
	"Tests run under node --test with recursive discovery over tests/ and extensions/.",
	"A defaced comment never ships, and cafebabe is not a hash anyone cited.",
	"Pi counts as busy while a run starts, so messages sent meanwhile join it.",
	"The budget is 2000 tokens, tuned from metrics during the trial.",
	"memory_read opens an archived file by path; history is never injected.",
];

test("gate: status-shaped bodies are refused and pointed at memory_log (R22)", () => {
	for (const { body, kinds } of STATUS) {
		const outcome = gatePropose({ claim: claim(body) });
		assert.equal(outcome.ok, false, body);
		if (outcome.ok) continue;
		const found = outcome.signals.map((signal) => signal.kind);
		for (const kind of kinds) assert.ok(found.includes(kind), `${body} → expected ${kind}, got ${formatSignals(outcome.signals)}`);
		assert.equal(outcome.redirect, "memory_log", body);
		assert.match(outcome.problems[0]!, /use memory_log with section completed, in_progress, decision, carry or note/, body);
	}
});

test("gate: ordinary rules and facts pass, including hex-looking English words", () => {
	for (const body of NOT_STATUS) {
		const outcome = gatePropose({ claim: claim(body) });
		assert.equal(outcome.ok, true, `${body} → ${outcome.ok ? "" : formatSignals(outcome.signals)}`);
	}
	// The deliberate narrowing of "7-40 hex": a short run with no digit is a word.
	assert.deepEqual(detectStatus("cafebabe defaced"), []);
	assert.deepEqual(detectStatus("deadbeefcafe"), [{ kind: "sha", match: "deadbeefcafe" }]);
	assert.deepEqual(detectStatus("9fa1b7c"), [{ kind: "sha", match: "9fa1b7c" }]);
});

test("gate: source and links may carry PRs, commits and runs (R23)", () => {
	const clean = gatePropose({
		claim: claim("A commit message says what and why; the branch name says when.", {
			source: "decided in PR #1284, commit 4c142dc, run 98712 green",
			links: ["https://github.com/rlazoti/rl-pi-extensions/actions/runs/12345", "https://github.com/rlazoti/rl-pi-extensions/commit/9fa1b7c"],
		}),
	});
	assert.equal(clean.ok, true, clean.ok ? "" : clean.problems.join("; "));
	// The same text inside the body is status.
	assert.ok(detectStatus("decided in PR #1284, commit 4c142dc").length >= 2);
});

test("gate: supersession prose in a body is refused with the fix spelled out (R14)", () => {
	for (const body of [
		"This rule was superseded by the 2026 convention.",
		"The old flow is historical and kept for reference.",
		"Rebase no longer applies here.",
		"The master branch was replaced by main.",
	]) {
		const outcome = gatePropose({ claim: claim(body) });
		assert.equal(outcome.ok, false, body);
		if (outcome.ok) continue;
		assert.match(outcome.problems[0]!, /propose the new claim for "git\.flow" @ global instead/, body);
	}
	assert.deepEqual(detectSupersession("superseded by"), ["superseded"]);
	assert.deepEqual(detectSupersession("a perfectly ordinary rule"), []);
});

test("gate: an override needs a reason, is stored on the claim, and is refused when pointless (R24)", () => {
	const statusBody = "Merged 9fa1b7c on 2026-10-16 is the example inside the rule.";
	const noReason = gatePropose({ claim: claim(statusBody), overrideStatusCheck: true });
	assert.equal(noReason.ok, false);
	if (!noReason.ok) assert.match(noReason.problems[0]!, /an override needs a reason/);

	const withReason = gatePropose({ claim: claim(statusBody), overrideStatusCheck: true, overrideReason: "the sha is part of the example, not a record of a merge" });
	assert.equal(withReason.ok, true);
	if (withReason.ok) assert.equal(withReason.claim.statusOverride, "the sha is part of the example, not a record of a merge");

	const unneeded = gatePropose({ claim: claim("Never push without confirmation."), overrideStatusCheck: true, overrideReason: "trust me" });
	assert.equal(unneeded.ok, false);
	if (!unneeded.ok) assert.match(unneeded.problems[0]!, /no status signals — it is not needed/);
});

test("gate: grammar problems are refused before anything else", () => {
	const outcome = gatePropose({ claim: claim("A rule.", { asOf: "" }) });
	assert.equal(outcome.ok, false);
	if (!outcome.ok) {
		assert.match(outcome.problems[0]!, /asOf is required and is never filled in/);
		assert.deepEqual(outcome.signals, []);
	}
	const tooLong = gatePropose({ claim: claim("x".repeat(601)) });
	assert.equal(tooLong.ok, false);
	if (!tooLong.ok) assert.match(tooLong.problems[0]!, /601 characters/);
});

test("gate: body whitespace is normalised on the way through", () => {
	const outcome = gatePropose({ claim: claim("  One   rule,\n  one paragraph.  ") });
	assert.equal(outcome.ok, true);
	if (outcome.ok) assert.equal(outcome.claim.body, "One rule, one paragraph.");
});

test("gate: a daily-log write needs a section and text, and nothing else", () => {
	assert.deepEqual(gateDaily({ section: "note", text: "x" }), { ok: true, section: "note", text: "x" });
	assert.deepEqual(gateDaily({ section: "", text: "x" }).ok, false);
	assert.deepEqual(gateDaily({ section: "note", text: "   " }).ok, false);
	assert.deepEqual(gateDaily({ section: 7, text: undefined }).ok, false);
});
