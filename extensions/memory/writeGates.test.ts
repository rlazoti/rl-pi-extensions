/**
 * The write gates are a pure function: text before, text after, limits, and how many
 * times each gate already refused in a row. Everything that decides "reject or accept"
 * is a table here, so the handler tests only have to prove the wiring.
 */
import { describe, it, expect } from "vitest";
import {
	DEFAULT_GATE_LIMITS,
	GATE_MAX_REJECTIONS,
	NO_REJECTIONS,
	boundedBullets,
	checkDailyWrite,
	sectionWeights,
	wordCount,
	type GateLimits,
	type GateState,
} from "./writeGates.js";

const LIMITS: GateLimits = { ...DEFAULT_GATE_LIMITS };
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const daily = (completed: string[], decisions: string[] = []) =>
	[
		"## 2026-11-10",
		"",
		"### In Progress",
		"",
		"### Completed",
		...completed.map((c) => `- ${c}`),
		"",
		"### Key Decisions",
		...decisions.map((d) => `- ${d}`),
		"",
	].join("\n");

describe("wordCount", () => {
	it("counts whitespace-separated tokens and ignores the bullet marker", () => {
		expect(wordCount("- one two  three")).toBe(3);
		expect(wordCount("* [link](https://x.y/z) two")).toBe(2);
		expect(wordCount("")).toBe(0);
	});
});

describe("boundedBullets", () => {
	it("reads only the Completed and Key Decisions sections, at either heading level", () => {
		const text = ["## Completed", "- a b", "### Key Decisions", "- c", "### Other", "- d e f"].join("\n");
		expect(boundedBullets(text).map((b) => [b.section, b.text])).toEqual([
			["Completed", "a b"],
			["Key Decisions", "c"],
		]);
	});
});

describe("an entry without a bullet marker", () => {
	it("is still an entry: a long line that forgot its dash does not walk past the gate", () => {
		const after = ["### Completed", words(LIMITS.completedWords + 1)].join("\n");
		expect(checkDailyWrite("### Completed\n", after, LIMITS, NO_REJECTIONS).decision.action).toBe("reject");
	});
});

describe("word gate", () => {
	const before = daily(["short"]);
	const rows: Array<[string, string, number, boolean]> = [
		["Completed at the limit", "Completed", LIMITS.completedWords, false],
		["Completed one over", "Completed", LIMITS.completedWords + 1, true],
		["Key Decisions at the limit", "Key Decisions", LIMITS.keyDecisionsWords, false],
		["Key Decisions one over", "Key Decisions", LIMITS.keyDecisionsWords + 1, true],
	];
	for (const [label, section, n, rejected] of rows) {
		it(`${label}: ${rejected ? "rejected" : "accepted"}`, () => {
			const after = section === "Completed" ? daily(["short", words(n)]) : daily(["short"], [words(n)]);
			const r = checkDailyWrite(before, after, LIMITS, NO_REJECTIONS);
			expect(r.decision.action).toBe(rejected ? "reject" : "accept");
			if (rejected) {
				expect((r.decision as { message: string }).message).toContain(`${n} words > ${section === "Completed" ? LIMITS.completedWords : LIMITS.keyDecisionsWords}`);
			}
		});
	}

	it("checks only new or changed bullets, so an old long bullet never blocks an unrelated edit", () => {
		const old = words(LIMITS.completedWords + 10);
		const prior = daily([old]);
		const after = daily([old, "a new short line"]);
		expect(checkDailyWrite(prior, after, LIMITS, NO_REJECTIONS).decision.action).toBe("accept");
	});

	it("rejects a long bullet that is a changed copy of an old one", () => {
		const prior = daily(["short"]);
		const after = daily([words(LIMITS.completedWords + 1)]);
		expect(checkDailyWrite(prior, after, LIMITS, NO_REJECTIONS).decision.action).toBe("reject");
	});

	it("a word limit of 0 turns the word gate off", () => {
		const after = daily([words(500)]);
		const r = checkDailyWrite(daily([]), after, { ...LIMITS, completedWords: 0, keyDecisionsWords: 0 }, NO_REJECTIONS);
		expect(r.decision.action).toBe("accept");
	});
});

describe("character gate", () => {
	const filler = (n: number) => "x".repeat(n);
	it("accepts a write that stays inside the cap", () => {
		const after = daily(["a"]).padEnd(LIMITS.dailyContextMaxChars, "\n");
		expect(after.length).toBe(LIMITS.dailyContextMaxChars);
		expect(checkDailyWrite(daily([]), after, LIMITS, NO_REJECTIONS).decision.action).toBe("accept");
	});

	it("rejects a write that grows the file past the cap, naming the numbers", () => {
		const after = daily(["a"]) + filler(LIMITS.dailyContextMaxChars);
		const r = checkDailyWrite(daily([]), after, LIMITS, NO_REJECTIONS);
		expect(r.decision.action).toBe("reject");
		const message = (r.decision as { message: string }).message;
		expect(message).toContain(`${after.length.toLocaleString()} characters`);
		expect(message).toContain(`${(after.length - LIMITS.dailyContextMaxChars).toLocaleString()} over`);
		expect(message).toContain(`${LIMITS.dailyContextMaxChars.toLocaleString()}-character cap`);
	});

	it("a write that does not grow the file passes, even while the file is still over the cap", () => {
		const before = daily(["a"]) + filler(LIMITS.dailyContextMaxChars + 2000);
		const shorter = before.slice(0, before.length - 500);
		expect(shorter.length).toBeGreaterThan(LIMITS.dailyContextMaxChars);
		expect(checkDailyWrite(before, shorter, LIMITS, NO_REJECTIONS).decision.action).toBe("accept");
		expect(checkDailyWrite(before, before, LIMITS, NO_REJECTIONS).decision.action).toBe("accept");
	});

	it("a character cap of 0 turns the character gate off", () => {
		const after = daily(["a"]) + filler(50_000);
		const r = checkDailyWrite(daily([]), after, { ...LIMITS, dailyContextMaxChars: 0 }, NO_REJECTIONS);
		expect(r.decision.action).toBe("accept");
	});
});

describe("a refusal carries its own fix", () => {
	// The 2026-11-13 bank audit counted 3 refusals over 131 real prompts and not one accepted
	// write after them: a message that names the limit but not the route just loses the entry.
	const messageFor = (before: string, after: string) =>
		(checkDailyWrite(before, after, LIMITS, NO_REJECTIONS).decision as { message: string }).message;

	it("names how far over, states that nothing landed, and gives the detail somewhere to go", () => {
		const message = messageFor(daily(["short"]), daily(["short", words(LIMITS.completedWords + 2)]));
		expect(message).toContain(`(2 over)`);
		expect(message).toContain("at or under the limit");
		expect(message).toContain("Nothing was written");
		expect(message).toContain("still holds its previous text");
		expect(message).toContain("knowledge/<name>.md");
	});

	it("lists every violating bullet, not only the first", () => {
		const message = messageFor(
			daily(["short"]),
			daily(["short"], [words(LIMITS.keyDecisionsWords + 3), words(LIMITS.keyDecisionsWords + 9)]),
		);
		expect(message).toContain(`> ${LIMITS.keyDecisionsWords} (3 over)`);
		expect(message).toContain(`> ${LIMITS.keyDecisionsWords} (9 over)`);
	});

	it("on a character refusal, names the heaviest section so the trim is not guesswork", () => {
		const message = messageFor(daily([]), daily(["a"]) + "x".repeat(LIMITS.dailyContextMaxChars));
		expect(message).toMatch(/Key Decisions [\d,]+ chars/);
		expect(message).toContain("only copy of today");
		expect(message).toContain("knowledge/memory-bank-maintenance.md");
	});
});

describe("sectionWeights", () => {
	it("sizes every section, biggest first, and counts text above the first heading", () => {
		const text = ["intro line", "", "## Small", "- a", "", "## Big", "- one two three"].join("\n");
		const w = sectionWeights(text);
		expect(w.map((s) => s.name)).toEqual(["Big", "Small", "(before the first heading)"]);
		// Every line is sized as if newline-terminated, so the parts add up to the file plus one.
		expect(w.reduce((n, s) => n + s.chars, 0)).toBe(text.length + 1);
	});

	it("has nothing to report for an empty file", () => {
		expect(sectionWeights("")).toEqual([]);
	});
});

describe("the escape: a gate can never wedge a session", () => {
	const before = daily(["short"]);
	const tooLong = daily(["short", words(LIMITS.completedWords + 5)]);
	const clean = daily(["short", "fine"]);

	it("rejects GATE_MAX_REJECTIONS times in a row, then accepts with a warning", () => {
		let state: GateState = NO_REJECTIONS;
		for (let i = 1; i <= GATE_MAX_REJECTIONS; i++) {
			const r = checkDailyWrite(before, tooLong, LIMITS, state);
			expect(r.decision.action).toBe("reject");
			expect((r.decision as { message: string }).message).toContain(`${i} of ${GATE_MAX_REJECTIONS}`);
			state = r.state;
		}
		const last = checkDailyWrite(before, tooLong, LIMITS, state);
		expect(last.decision.action).toBe("accept");
		expect((last.decision as { warning?: string }).warning).toContain("Accepted over-limit write");
		expect(last.state).toEqual(NO_REJECTIONS);
	});

	it("a clean write resets the counters", () => {
		const first = checkDailyWrite(before, tooLong, LIMITS, NO_REJECTIONS);
		expect(first.state.words).toBe(1);
		const ok = checkDailyWrite(before, clean, LIMITS, first.state);
		expect(ok.decision).toEqual({ action: "accept" });
		expect(ok.state).toEqual(NO_REJECTIONS);
	});

	it("when one write breaks both gates, it is accepted only once BOTH allowances are used", () => {
		const both = daily(["short", words(LIMITS.completedWords + 5)]) + "x".repeat(LIMITS.dailyContextMaxChars);
		// Word gate already used up, character gate fresh: still refused, and only the character counter moves.
		const state: GateState = { words: GATE_MAX_REJECTIONS, chars: 0 };
		const r1 = checkDailyWrite(before, both, LIMITS, state);
		expect(r1.decision.action).toBe("reject");
		expect(r1.state).toEqual({ words: GATE_MAX_REJECTIONS, chars: 1 });
		const r2 = checkDailyWrite(before, both, LIMITS, r1.state);
		expect(r2.decision.action).toBe("reject");
		const r3 = checkDailyWrite(before, both, LIMITS, r2.state);
		expect(r3.decision.action).toBe("accept");
	});

	it("a gate that no longer fires does not keep a stale counter alive", () => {
		const state: GateState = { words: 1, chars: 1 };
		const r = checkDailyWrite(before, tooLong, LIMITS, state);
		// Only the word gate fires now; the character counter must not carry over as if it fired too.
		expect(r.state.chars).toBe(0);
	});
});

describe("off switch", () => {
	it("enabled: false accepts everything and keeps no counters", () => {
		const after = daily([words(500)]) + "x".repeat(50_000);
		const r = checkDailyWrite(daily([]), after, { ...LIMITS, enabled: false }, { words: 1, chars: 1 });
		expect(r.decision).toEqual({ action: "accept" });
		expect(r.state).toEqual(NO_REJECTIONS);
	});
});
