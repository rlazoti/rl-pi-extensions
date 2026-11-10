import { describe, it } from "node:test";
import assert from "node:assert/strict";

function expect(actual: unknown) {
	return {
		toBe: (expected: unknown) => assert.equal(actual, expected),
		toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
		toBeNull: () => assert.equal(actual, null),
		toBeUndefined: () => assert.equal(actual, undefined),
		toHaveLength: (expected: number) => assert.equal((actual as { length: number }).length, expected),
		toContain: (expected: string) => assert.ok((actual as string | unknown[]).includes(expected)),
	};
}
import { QuestionnaireState, EditorTarget, type QuestionData, type OptionData } from "./state.ts";
import { InputHandler, InputAction } from "./input-handler.ts";
import { normalizeOptions, normalizeQuestion, normalizeQuestions } from "./types.ts";
import { MultiSelectStrategy, SingleSelectStrategy } from "./selection-strategy.ts";
import { defaultConfig, type AskConfig } from "./config.ts";
import { formatResult, formatSingleFreeResult, formatCancelledResult, formatNoUIResult } from "./result.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const STRUCTURED: QuestionData[] = [
	{
		id: "q1", label: "Pick one", question: "Pick one?", multi: false,
		options: [
			{ label: "Fast", value: "fast", description: "Skip tests", recommended: true },
			{ label: "Safe", value: "safe", description: "Run everything" },
			{ label: "Custom", value: "custom" },
		],
	},
	{ id: "q2", label: "Free-form", question: "Free-form?" },
	{
		id: "q3", label: "Pick many", question: "Pick many?",
		options: [
			{ label: "A", value: "a" },
			{ label: "B", value: "b", recommended: true },
			{ label: "C", value: "c" },
		],
	},
];

const SIMPLE: QuestionData[] = [
	{ id: "s1", label: "Simple", question: "Simple?", options: [{ label: "X", value: "x" }, { label: "Y", value: "y" }] },
];

// ─── normalizeOptions ────────────────────────────────────────────────────────

describe("normalizeOptions", () => {
	it("returns undefined for undefined input", () => {
		expect(normalizeOptions(undefined)).toBeUndefined();
	});

	it("returns undefined for empty array", () => {
		expect(normalizeOptions([])).toBeUndefined();
	});

	it("converts strings to OptionData", () => {
		const result = normalizeOptions(["A", "B"]);
		expect(result).toEqual([
			{ label: "A", value: "A" },
			{ label: "B", value: "B" },
		]);
	});

	it("passes through OptionData objects", () => {
		const opts: OptionData[] = [{ label: "Fast", value: "fast", description: "go fast" }];
		expect(normalizeOptions(opts)).toEqual(opts);
	});

	it("handles mixed string and OptionData", () => {
		const result = normalizeOptions(["plain", { label: "Rich", value: "rich" }]);
		expect(result).toEqual([
			{ label: "plain", value: "plain" },
			{ label: "Rich", value: "rich" },
		]);
	});
});

// ─── normalizeQuestion ───────────────────────────────────────────────────────

describe("normalizeQuestion", () => {
	it("normalizes string options to OptionData", () => {
		const q = normalizeQuestion(
			{ id: "q1", question: "Pick?", label: "Pick", options: ["A", "B"] },
			defaultConfig,
		);
		expect(q.options).toEqual([
			{ label: "A", value: "A" },
			{ label: "B", value: "B" },
		]);
	});

	it("preserves structured OptionData", () => {
		const q = normalizeQuestion(
			{ id: "q1", question: "Pick?", label: "Pick", options: [{ label: "X", value: "x" }] },
			defaultConfig,
		);
		expect(q.options).toEqual([{ label: "X", value: "x" }]);
	});

	it("passes through label, context, id, question", () => {
		const q = normalizeQuestion(
			{ id: "q1", question: "What?", label: "What", context: "help text" },
			defaultConfig,
		);
		expect(q.id).toBe("q1");
		expect(q.question).toBe("What?");
		expect(q.label).toBe("What");
		expect(q.context).toBe("help text");
	});

	it("preserves multi: false when enableSingleSelect is true", () => {
		const q = normalizeQuestion(
			{ id: "q1", question: "Pick?", label: "Pick", multi: false, options: ["A"] },
			{ ...defaultConfig, enableSingleSelect: true },
		);
		expect(q.multi).toBe(false);
	});

	it("drops multi: false when enableSingleSelect is false", () => {
		const q = normalizeQuestion(
			{ id: "q1", question: "Pick?", label: "Pick", multi: false, options: ["A"] },
			{ ...defaultConfig, enableSingleSelect: false },
		);
		expect(q.multi).toBeUndefined();
	});

	it("adds dummy option when no options and enableFreeForm is false", () => {
		const q = normalizeQuestion(
			{ id: "q1", question: "Pick?", label: "Pick" },
			{ ...defaultConfig, enableFreeForm: false },
		);
		expect(q.options).toEqual([{ label: "(no options)", value: "" }]);
	});

	it("keeps options undefined when enableFreeForm is true", () => {
		const q = normalizeQuestion(
			{ id: "q1", question: "Pick?", label: "Pick" },
			{ ...defaultConfig, enableFreeForm: true },
		);
		expect(q.options).toBeUndefined();
	});

	it("multi: true is not set explicitly (stays undefined)", () => {
		const q = normalizeQuestion(
			{ id: "q1", question: "Pick?", label: "Pick", multi: true, options: ["A"] },
			defaultConfig,
		);
		expect(q.multi).toBeUndefined();
	});
});

// ─── normalizeQuestions ──────────────────────────────────────────────────────

describe("normalizeQuestions", () => {
	it("wraps single question into array", () => {
		const qs = normalizeQuestions(
			{ id: "q1", question: "Pick?", label: "Pick" },
			defaultConfig,
		);
		expect(qs).toHaveLength(1);
		expect(qs[0].id).toBe("q1");
	});

	it("passes through array of questions", () => {
		const qs = normalizeQuestions(
			[
				{ id: "q1", question: "A?", label: "A" },
				{ id: "q2", question: "B?", label: "B" },
			],
			defaultConfig,
		);
		expect(qs).toHaveLength(2);
		expect(qs[0].id).toBe("q1");
		expect(qs[1].id).toBe("q2");
	});
});

// ─── Result formatters ──────────────────────────────────────────────────────

describe("formatResult", () => {
	const questions: QuestionData[] = [
		{ id: "q1", label: "Deploy", question: "Deploy strategy?", options: [{ label: "Fast", value: "fast" }] },
		{ id: "q2", label: "Notes", question: "Any notes?" },
	];

	it("content is valid JSON matching the result", () => {
		const input = {
			answers: { q1: [{ label: "Fast", value: "fast" }] },
			skipped: ["q2"],
			unanswered: [] as string[],
		};
		const result = formatResult(input, questions);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed).toEqual(input);
	});

	it("details.questions maps id to question text", () => {
		const result = formatResult(
			{ answers: {}, skipped: [], unanswered: ["q1", "q2"] },
			questions,
		);
		const d = result.details as any;
		expect(d.questions).toEqual({ q1: "Deploy strategy?", q2: "Any notes?" });
	});

	it("details.answered is true when answers exist", () => {
		const result = formatResult(
			{ answers: { q1: [{ value: "fast" }] }, skipped: [], unanswered: [] },
			questions,
		);
		expect((result.details as any).answered).toBe(true);
	});

	it("details.answered is false when no answers", () => {
		const result = formatResult(
			{ answers: {}, skipped: ["q1"], unanswered: ["q2"] },
			questions,
		);
		expect((result.details as any).answered).toBe(false);
	});

	it("details preserves skipped and unanswered arrays", () => {
		const result = formatResult(
			{ answers: {}, skipped: ["q1"], unanswered: ["q2"] },
			questions,
		);
		const d = result.details as any;
		expect(d.skipped).toEqual(["q1"]);
		expect(d.unanswered).toEqual(["q2"]);
	});
});

describe("formatSingleFreeResult", () => {
	it("returns skipped result for null input", () => {
		const result = formatSingleFreeResult("q1", null);
		const d = result.details as any;
		expect(d.answered).toBe(false);
		expect(d.skipped).toEqual(["q1"]);
		expect(d.unanswered).toEqual([]);
		expect(result.content[0].text).toContain("skipped");
	});

	it("returns skipped result for empty string", () => {
		const result = formatSingleFreeResult("q1", "");
		expect((result.details as any).skipped).toEqual(["q1"]);
	});

	it("returns skipped result for whitespace-only", () => {
		const result = formatSingleFreeResult("q1", "   ");
		expect((result.details as any).skipped).toEqual(["q1"]);
	});

	it("returns answered result with custom:true for valid input", () => {
		const result = formatSingleFreeResult("q1", "my answer");
		const d = result.details as any;
		expect(d.answered).toBe(true);
		expect(d.answers.q1).toEqual([{ value: "my answer", custom: true }]);
	});

	it("trims whitespace from answer", () => {
		const result = formatSingleFreeResult("q1", "  padded  ");
		const d = result.details as any;
		expect(d.answers.q1[0].value).toBe("padded");
	});

	it("content is valid JSON for answered result", () => {
		const result = formatSingleFreeResult("q1", "hello");
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.answers.q1).toEqual([{ value: "hello", custom: true }]);
		expect(parsed.skipped).toEqual([]);
		expect(parsed.unanswered).toEqual([]);
	});
});

describe("formatCancelledResult", () => {
	it("has cancelled: true in details", () => {
		const result = formatCancelledResult();
		expect((result.details as any).cancelled).toBe(true);
	});

	it("content says cancelled", () => {
		expect(formatCancelledResult().content[0].text).toContain("Cancelled");
	});
});

describe("formatNoUIResult", () => {
	it("has cancelled: true in details", () => {
		const result = formatNoUIResult();
		expect((result.details as any).cancelled).toBe(true);
	});

	it("content mentions no UI", () => {
		expect(formatNoUIResult().content[0].text).toContain("no UI");
	});
});

// ─── SelectionStrategy ───────────────────────────────────────────────────────

describe("MultiSelectStrategy", () => {
	const strategy = new MultiSelectStrategy();

	it("adds to selection", () => {
		const result = strategy.toggle(new Set(), "a");
		expect(result).toEqual(new Set(["a"]));
	});

	it("removes from selection", () => {
		const result = strategy.toggle(new Set(["a"]), "a");
		expect(result).toEqual(new Set());
	});

	it("keeps others when toggling", () => {
		const result = strategy.toggle(new Set(["a", "b"]), "a");
		expect(result).toEqual(new Set(["b"]));
	});

	it("isMulti returns true", () => {
		expect(strategy.isMulti()).toBe(true);
	});
});

describe("SingleSelectStrategy", () => {
	const strategy = new SingleSelectStrategy();

	it("selects one, clearing others", () => {
		const result = strategy.toggle(new Set(["a"]), "b");
		expect(result).toEqual(new Set(["b"]));
	});

	it("deselects when toggling same", () => {
		const result = strategy.toggle(new Set(["a"]), "a");
		expect(result).toEqual(new Set());
	});

	it("replaces multiple with one", () => {
		const result = strategy.toggle(new Set(["a", "b"]), "c");
		expect(result).toEqual(new Set(["c"]));
	});

	it("isMulti returns false", () => {
		expect(strategy.isMulti()).toBe(false);
	});
});

// ─── Config ──────────────────────────────────────────────────────────────────



// ─── QuestionnaireState ──────────────────────────────────────────────────────

describe("QuestionnaireState", () => {
	describe("initialization", () => {
		it("starts at tab 0 with editor inactive", () => {
			const state = new QuestionnaireState(STRUCTURED);
			expect(state.currentTab).toBe(0);
			expect(state.editorActive).toBe(false);
			expect(state.focusedOptionIndex).toBe(0);
		});

		it("done tab is question count", () => {
			const state = new QuestionnaireState(STRUCTURED);
			expect(state.getDonetab()).toBe(3);
		});
	});

	describe("tab navigation", () => {
		it("advances and returns true", () => {
			const state = new QuestionnaireState(STRUCTURED);
			expect(state.advanceTab()).toBe(true);
			expect(state.currentTab).toBe(1);
		});

		it("stops at done tab", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = state.getDonetab();
			expect(state.advanceTab()).toBe(false);
		});

		it("goes back and returns true", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = 2;
			expect(state.goBackTab()).toBe(true);
			expect(state.currentTab).toBe(1);
		});

		it("stops at tab 0", () => {
			const state = new QuestionnaireState(STRUCTURED);
			expect(state.goBackTab()).toBe(false);
		});

		it("resets focused index on tab change", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.focusedOptionIndex = 5;
			state.advanceTab();
			expect(state.focusedOptionIndex).toBe(0);
		});
	});

	describe("current question", () => {
		it("returns question for current tab", () => {
			const state = new QuestionnaireState(STRUCTURED);
			expect(state.currentQuestion()?.id).toBe("q1");
		});

		it("returns null on done tab", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = state.getDonetab();
			expect(state.currentQuestion()).toBeNull();
		});
	});

	describe("strategyFor", () => {
		it("returns SingleSelectStrategy for multi: false", () => {
			const state = new QuestionnaireState(STRUCTURED);
			const q = state.currentQuestion()!;
			expect(state.strategyFor(q).isMulti()).toBe(false);
		});

		it("returns MultiSelectStrategy by default", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = 2; // q3, no multi field
			const q = state.currentQuestion()!;
			expect(state.strategyFor(q).isMulti()).toBe(true);
		});
	});

	describe("multi-select toggle", () => {
		it("toggles on and off", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = 2; // q3 (multi)
			state.toggleOption("a");
			expect(state.isOptionSelected("a")).toBe(true);
			state.toggleOption("a");
			expect(state.isOptionSelected("a")).toBe(false);
		});

		it("allows multiple selections", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = 2;
			state.toggleOption("a");
			state.toggleOption("b");
			expect(state.isOptionSelected("a")).toBe(true);
			expect(state.isOptionSelected("b")).toBe(true);
		});
	});

	describe("single-select toggle", () => {
		it("replaces previous selection", () => {
			const state = new QuestionnaireState(STRUCTURED);
			// q1 is single-select
			state.toggleOption("fast");
			expect(state.isOptionSelected("fast")).toBe(true);
			state.toggleOption("safe");
			expect(state.isOptionSelected("safe")).toBe(true);
			expect(state.isOptionSelected("fast")).toBe(false);
		});

		it("deselects when toggling same option", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.toggleOption("fast");
			state.toggleOption("fast");
			expect(state.isOptionSelected("fast")).toBe(false);
		});

		it("deselects custom but preserves text when selecting a regular option", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.setCustomAnswer("my custom");
			state.toggleOption("fast");
			expect(state.isOptionSelected("fast")).toBe(true);
			expect(state.isCustomSelected()).toBe(false);
			expect(state.hasCustomAnswer()).toBe(true);
			expect(state.getCustomAnswer()).toBe("my custom");
		});
	});

	describe("toggle does nothing on done tab", () => {
		it("no-ops", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = state.getDonetab();
			state.toggleOption("fast");
			expect(state.isOptionSelected("fast")).toBe(false);
		});
	});

	describe("custom answer", () => {
		it("set and get (multi)", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = 2; // multi
			state.toggleOption("a");
			state.setCustomAnswer("extra");
			expect(state.getCustomAnswer()).toBe("extra");
			expect(state.isOptionSelected("a")).toBe(true); // preserved
		});

		it("set clears selections (single)", () => {
			const state = new QuestionnaireState(STRUCTURED);
			// q1 is single-select
			state.toggleOption("fast");
			state.setCustomAnswer("mine");
			expect(state.getCustomAnswer()).toBe("mine");
			expect(state.isOptionSelected("fast")).toBe(false); // cleared
		});

		it("clears custom answer and selected flag", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.setCustomAnswer("temp");
			expect(state.isCustomSelected()).toBe(true);
			state.clearCustomAnswer();
			expect(state.getCustomAnswer()).toBeUndefined();
			expect(state.hasCustomAnswer()).toBe(false);
			expect(state.isCustomSelected()).toBe(false);
		});

		it("setCustomAnswer marks as selected", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.setCustomAnswer("hello");
			expect(state.isCustomSelected()).toBe(true);
		});

		it("toggleCustomSelected deselects without clearing text", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.setCustomAnswer("keep me");
			state.toggleCustomSelected();
			expect(state.isCustomSelected()).toBe(false);
			expect(state.getCustomAnswer()).toBe("keep me");
		});

		it("toggleCustomSelected re-selects", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.setCustomAnswer("keep me");
			state.toggleCustomSelected(); // off
			state.toggleCustomSelected(); // on
			expect(state.isCustomSelected()).toBe(true);
		});

		it("toggleCustomSelected clears skipped flag", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.skipCurrentQuestion();
			state.setCustomAnswer("after skip");
			state.toggleCustomSelected(); // off
			state.toggleCustomSelected(); // on — should clear skipped
			expect(state.isQuestionSkipped("q1")).toBe(false);
		});

		it("toggleCustomSelected preserves options in multi-select on re-select", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = 2; // q3 is multi
			state.toggleOption("a");
			state.setCustomAnswer("extra");
			state.toggleCustomSelected(); // deselect custom
			state.toggleCustomSelected(); // re-select — options should stay
			expect(state.isOptionSelected("a")).toBe(true);
			expect(state.isCustomSelected()).toBe(true);
		});

		it("toggleOption deselects custom but preserves text in single-select", () => {
			const state = new QuestionnaireState(STRUCTURED);
			// q1 is single-select
			state.setCustomAnswer("my custom answer");
			expect(state.isCustomSelected()).toBe(true);
			state.toggleOption("safe");
			expect(state.isOptionSelected("safe")).toBe(true);
			expect(state.isCustomSelected()).toBe(false);
			expect(state.hasCustomAnswer()).toBe(true);
			expect(state.getCustomAnswer()).toBe("my custom answer");
		});

		it("toggleCustomSelected clears options in single-select on re-select", () => {
			const state = new QuestionnaireState(STRUCTURED);
			// q1 is single-select
			state.setCustomAnswer("mine"); // selects custom, clears options
			state.toggleCustomSelected(); // deselect custom
			state.toggleOption("safe"); // select an option
			state.toggleCustomSelected(); // re-select custom — should clear "safe"
			expect(state.isOptionSelected("safe")).toBe(false);
			expect(state.isCustomSelected()).toBe(true);
		});

		it("isCustomSelected returns false on done tab", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = state.getDonetab();
			expect(state.isCustomSelected()).toBe(false);
		});

		it("toggleCustomSelected does nothing on done tab", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.setCustomAnswer("x");
			state.currentTab = state.getDonetab();
			state.toggleCustomSelected();
			state.currentTab = 0;
			expect(state.isCustomSelected()).toBe(true);
		});

		it("buildResult excludes deselected custom", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.setCustomAnswer("text");
			state.toggleCustomSelected(); // deselect
			const result = state.buildResult();
			expect(result.answers["q1"]).toBeUndefined();
			expect(result.unanswered).toContain("q1");
		});

		it("returns undefined on done tab", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = state.getDonetab();
			expect(state.getCustomAnswer()).toBeUndefined();
		});

		it("set does nothing on done tab", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = state.getDonetab();
			state.setCustomAnswer("nope");
			expect(state.hasCustomAnswer()).toBe(false);
		});

		it("clear does nothing on done tab", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.setCustomAnswer("x");
			state.currentTab = state.getDonetab();
			state.clearCustomAnswer();
			state.currentTab = 0;
			expect(state.getCustomAnswer()).toBe("x");
		});
	});

	describe("custom option index", () => {
		it("is after the last regular option", () => {
			const state = new QuestionnaireState(STRUCTURED);
			expect(state.getCustomOptionIndex()).toBe(3);
		});

		it("is 0 for free-form questions", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = 1;
			expect(state.getCustomOptionIndex()).toBe(0);
		});

		it("isOnCustomOption checks focused index", () => {
			const state = new QuestionnaireState(STRUCTURED);
			expect(state.isOnCustomOption()).toBe(false);
			state.focusedOptionIndex = 3;
			expect(state.isOnCustomOption()).toBe(true);
		});
	});

	describe("focus navigation", () => {
		it("includes custom option in total count", () => {
			const state = new QuestionnaireState(STRUCTURED);
			expect(state.totalOptionCount()).toBe(4);
		});

		it("returns 1 on done tab", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = state.getDonetab();
			expect(state.totalOptionCount()).toBe(1);
		});

		it("returns 1 for free-form", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = 1;
			expect(state.totalOptionCount()).toBe(1);
		});

		it("navigates forward including custom", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.focusedOptionIndex = 2;
			state.focusNextOption();
			expect(state.focusedOptionIndex).toBe(3);
		});

		it("stops at last option", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.focusedOptionIndex = 3;
			state.focusNextOption();
			expect(state.focusedOptionIndex).toBe(3);
		});

		it("navigates backward", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.focusedOptionIndex = 2;
			state.focusPrevOption();
			expect(state.focusedOptionIndex).toBe(1);
		});

		it("stops at 0", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.focusPrevOption();
			expect(state.focusedOptionIndex).toBe(0);
		});
	});

	describe("recommended index", () => {
		it("returns index of first recommended option", () => {
			const state = new QuestionnaireState(STRUCTURED);
			expect(state.getRecommendedIndex()).toBe(0); // q1: "fast" is at index 0
		});

		it("returns 0 when no recommended", () => {
			const state = new QuestionnaireState(SIMPLE);
			expect(state.getRecommendedIndex()).toBe(0);
		});

		it("finds recommended in multi-select", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = 2; // q3: "b" at index 1 is recommended
			expect(state.getRecommendedIndex()).toBe(1);
		});

		it("returns 0 on done tab", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = state.getDonetab();
			expect(state.getRecommendedIndex()).toBe(0);
		});

		it("returns 0 for free-form", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = 1;
			expect(state.getRecommendedIndex()).toBe(0);
		});
	});

	describe("skipping", () => {
		it("marks question as skipped", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.skipCurrentQuestion();
			expect(state.isQuestionSkipped("q1")).toBe(true);
		});

		it("clears selections on skip", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.toggleOption("fast");
			state.setCustomAnswer("custom");
			state.skipCurrentQuestion();
			expect(state.isOptionSelected("fast")).toBe(false);
			expect(state.hasCustomAnswer()).toBe(false);
			expect(state.isQuestionSkipped("q1")).toBe(true);
		});

		it("does nothing on done tab", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = state.getDonetab();
			state.skipCurrentQuestion();
			expect(state.buildResult().skipped).toHaveLength(0);
		});
	});

	describe("notes", () => {
		it("set and get note on option", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.setNote("fast", "skip staging");
			expect(state.getNote("fast")).toBe("skip staging");
		});

		it("clear note", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.setNote("fast", "note");
			state.clearNote("fast");
			expect(state.getNote("fast")).toBeUndefined();
		});

		it("set multiple notes on same question", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.setNote("fast", "note 1");
			state.setNote("safe", "note 2");
			expect(state.getNote("fast")).toBe("note 1");
			expect(state.getNote("safe")).toBe("note 2");
		});

		it("notes isolated per question", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.setNote("fast", "q1 note");
			state.currentTab = 2;
			expect(state.getNote("fast")).toBeUndefined();
		});

		it("skip clears notes", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.setNote("fast", "note");
			state.skipCurrentQuestion();
			state.currentTab = 0; // re-enter skipped question context to check
			// After skip, notes map for q1 is deleted
			expect(state.getNote("fast")).toBeUndefined();
		});

		it("note appears in buildResult", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.toggleOption("fast");
			state.setNote("fast", "skip staging");
			const result = state.buildResult();
			expect(result.answers["q1"]).toEqual([
				{ label: "Fast", value: "fast", description: "Skip tests", note: "skip staging" },
			]);
		});

		it("no note field when not set", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.toggleOption("fast");
			const result = state.buildResult();
			expect(result.answers["q1"]![0].note).toBeUndefined();
		});

		it("set/get/clear do nothing on done tab", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = state.getDonetab();
			state.setNote("fast", "nope");
			expect(state.getNote("fast")).toBeUndefined();
			state.clearNote("fast");
		});

	});

	describe("isOptionSelected on done tab", () => {
		it("returns false", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = state.getDonetab();
			expect(state.isOptionSelected("fast")).toBe(false);
		});
	});

	describe("isQuestionAnswered", () => {
		it("true when option selected", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.toggleOption("fast");
			expect(state.isQuestionAnswered("q1")).toBe(true);
		});

		it("true when custom set", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.setCustomAnswer("yes");
			expect(state.isQuestionAnswered("q1")).toBe(true);
		});

		it("false when untouched", () => {
			const state = new QuestionnaireState(STRUCTURED);
			expect(state.isQuestionAnswered("q1")).toBe(false);
		});
	});

	describe("buildResult", () => {
		it("returns structured AnswerData for selected options", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.toggleOption("fast");
			const result = state.buildResult();
			expect(result.answers["q1"]).toEqual([
				{ label: "Fast", value: "fast", description: "Skip tests" },
			]);
		});

		it("includes custom as { value, custom: true }", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = 2;
			state.setCustomAnswer("my thing");
			const result = state.buildResult();
			expect(result.answers["q3"]).toEqual([
				{ value: "my thing", custom: true },
			]);
		});

		it("includes both options and custom", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.currentTab = 2;
			state.toggleOption("a");
			state.setCustomAnswer("extra");
			const result = state.buildResult();
			expect(result.answers["q3"]).toEqual([
				{ label: "A", value: "a" },
				{ value: "extra", custom: true },
			]);
		});

		it("tracks skipped", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.skipCurrentQuestion();
			const result = state.buildResult();
			expect(result.skipped).toContain("q1");
		});

		it("tracks unanswered", () => {
			const state = new QuestionnaireState(STRUCTURED);
			const result = state.buildResult();
			expect(result.unanswered).toEqual(["q1", "q2", "q3"]);
		});

		it("distinguishes all three states", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.toggleOption("fast"); // q1 answered
			state.advanceTab();
			state.skipCurrentQuestion(); // q2 skipped
			// q3 unanswered
			const result = state.buildResult();
			expect(Object.keys(result.answers)).toEqual(["q1"]);
			expect(result.skipped).toEqual(["q2"]);
			expect(result.unanswered).toEqual(["q3"]);
		});

		it("skip overrides prior selections", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.toggleOption("fast");
			state.skipCurrentQuestion();
			const result = state.buildResult();
			expect(result.answers["q1"]).toBeUndefined();
			expect(result.skipped).toContain("q1");
		});

		it("omits description from result when option has none", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.toggleOption("custom"); // no description
			const result = state.buildResult();
			expect(result.answers["q1"]).toEqual([{ label: "Custom", value: "custom" }]);
		});

		it("ignores orphaned values not in options", () => {
			const state = new QuestionnaireState(STRUCTURED);
			state.toggleOption("fast");
			// Manually inject an orphaned value via toggle on a value that doesn't exist
			state.toggleOption("nonexistent");
			const result = state.buildResult();
			// Only "fast" should appear (q1 is single-select, so "nonexistent" replaces "fast")
			// But since "nonexistent" isn't in options, it gets filtered out
			expect(result.answers["q1"]).toEqual([]);
		});
	});
});

// ─── InputHandler ────────────────────────────────────────────────────────────

describe("InputHandler", () => {
	const questions = STRUCTURED;

	function make() {
		const state = new QuestionnaireState(questions);
		const handler = new InputHandler(state);
		return { state, handler };
	}

	describe("global keys", () => {
		it("escape cancels", () => {
			const { handler } = make();
			expect(handler.process("\x1b")).toBe(InputAction.Cancel);
		});

		it("tab advances", () => {
			const { handler } = make();
			expect(handler.process("\t")).toBe(InputAction.AdvanceTab);
		});

		it("l advances", () => {
			const { handler } = make();
			expect(handler.process("l")).toBe(InputAction.AdvanceTab);
		});

		it("h goes back", () => {
			const { handler } = make();
			expect(handler.process("h")).toBe(InputAction.GoBackTab);
		});
	});

	describe("editor active guard", () => {
		it("returns None when editor is active", () => {
			const { state, handler } = make();
			state.editorActive = true;
			expect(handler.process("s")).toBe(InputAction.None);
			expect(handler.process("j")).toBe(InputAction.None);
			expect(handler.process("\x1b")).toBe(InputAction.None);
		});
	});

	describe("done tab", () => {
		it("enter submits", () => {
			const { state, handler } = make();
			state.currentTab = state.getDonetab();
			expect(handler.process("\r")).toBe(InputAction.Done);
		});

		it("other keys are None", () => {
			const { state, handler } = make();
			state.currentTab = state.getDonetab();
			expect(handler.process("s")).toBe(InputAction.None);
		});
	});

	describe("null question guard", () => {
		it("returns None when past bounds", () => {
			const { state, handler } = make();
			state.currentTab = questions.length + 1;
			expect(handler.process("s")).toBe(InputAction.None);
		});
	});

	describe("question with options", () => {
		it("j/k navigate", () => {
			const { handler } = make();
			expect(handler.process("j")).toBe(InputAction.NextOption);
			expect(handler.process("k")).toBe(InputAction.PrevOption);
		});

		it("space toggles", () => {
			const { handler } = make();
			expect(handler.process(" ")).toBe(InputAction.ToggleFocused);
		});

		it("s skips", () => {
			const { handler } = make();
			expect(handler.process("s")).toBe(InputAction.Skip);
		});

		it("number keys toggle by index", () => {
			const { handler } = make();
			expect(handler.process("1")).toBe(InputAction.ToggleOptionByNumber);
			expect(handler.getLastNumberIndex()).toBe(0);
			expect(handler.process("2")).toBe(InputAction.ToggleOptionByNumber);
			expect(handler.getLastNumberIndex()).toBe(1);
		});

		it("enter starts note when not on custom", () => {
			const { handler } = make();
			expect(handler.process("\r")).toBe(InputAction.StartNote);
		});

		it("unrecognized key is None", () => {
			const { handler } = make();
			expect(handler.process("x")).toBe(InputAction.None);
		});

		it("enter opens editor on custom option", () => {
			const { state, handler } = make();
			state.focusedOptionIndex = 3; // custom
			expect(handler.process("\r")).toBe(InputAction.StartCustom);
		});
	});

	describe("free-form question", () => {
		it("enter opens editor", () => {
			const { state, handler } = make();
			state.currentTab = 1;
			expect(handler.process("\r")).toBe(InputAction.StartCustom);
		});

		it("s skips", () => {
			const { state, handler } = make();
			state.currentTab = 1;
			expect(handler.process("s")).toBe(InputAction.Skip);
		});

		it("other keys are None", () => {
			const { state, handler } = make();
			state.currentTab = 1;
			expect(handler.process("x")).toBe(InputAction.None);
		});
	});

	describe("toggleFocusedOption", () => {
		it("toggles using option.value", () => {
			const { state, handler } = make();
			state.focusedOptionIndex = 0;
			handler.toggleFocusedOption();
			expect(state.isOptionSelected("fast")).toBe(true);
		});

		it("does nothing on custom index", () => {
			const { state, handler } = make();
			state.focusedOptionIndex = 3;
			handler.toggleFocusedOption();
			expect(state.isOptionSelected("fast")).toBe(false);
		});

		it("does nothing on done tab", () => {
			const { state, handler } = make();
			state.currentTab = state.getDonetab();
			handler.toggleFocusedOption();
		});

		it("does nothing on free-form", () => {
			const { state, handler } = make();
			state.currentTab = 1;
			handler.toggleFocusedOption();
		});
	});

	describe("toggleOptionByIndex", () => {
		it("toggles and focuses using value", () => {
			const { state, handler } = make();
			handler.toggleOptionByIndex(1);
			expect(state.isOptionSelected("safe")).toBe(true);
			expect(state.focusedOptionIndex).toBe(1);
		});

		it("does nothing for out-of-bounds", () => {
			const { state, handler } = make();
			handler.toggleOptionByIndex(10);
			expect(state.focusedOptionIndex).toBe(0);
		});
	});
});

// ─── Notes that are not attached to an option ────────────────────────────────

describe("shared and question notes", () => {
	const questions = STRUCTURED;
	function make() {
		const state = new QuestionnaireState(questions);
		const handler = new InputHandler(state);
		return { state, handler };
	}

	describe("shared note", () => {
		it("sets and reads back", () => {
			const { state } = make();
			state.setSharedNote("nothing ships without tests");
			expect(state.getSharedNote()).toBe("nothing ships without tests");
		});

		it("trims, and blank text removes it", () => {
			const { state } = make();
			state.setSharedNote("  keep me  ");
			expect(state.getSharedNote()).toBe("keep me");
			state.setSharedNote("   \n  ");
			expect(state.getSharedNote()).toBeUndefined();
		});

		it("survives moving between tabs", () => {
			const { state } = make();
			state.setSharedNote("context");
			state.advanceTab();
			state.advanceTab();
			state.goBackTab();
			expect(state.getSharedNote()).toBe("context");
		});

		it("survives skipping the question it was written on", () => {
			const { state } = make();
			state.setSharedNote("reason for skipping");
			state.skipCurrentQuestion();
			expect(state.getSharedNote()).toBe("reason for skipping");
		});

		it("is not carried by the option notes it sits beside", () => {
			const { state } = make();
			state.setNote("fast", "option note");
			state.setSharedNote("shared note");
			expect(state.getNote("fast")).toBe("option note");
			state.skipCurrentQuestion();
			// Option notes still go with the answer they qualified...
			expect(state.getNote("fast")).toBeUndefined();
			// ...while the note about the whole ask does not.
			expect(state.getSharedNote()).toBe("shared note");
		});
	});

	describe("question note", () => {
		it("sets and reads back by id", () => {
			const { state } = make();
			state.setQuestionNote("q1", "only for the first one");
			expect(state.getQuestionNote("q1")).toBe("only for the first one");
			expect(state.getQuestionNote("q3")).toBeUndefined();
		});

		it("blank text removes it", () => {
			const { state } = make();
			state.setQuestionNote("q1", "here");
			state.setQuestionNote("q1", " ");
			expect(state.getQuestionNote("q1")).toBeUndefined();
		});

		it("reads and writes through the tab the user is on", () => {
			const { state } = make();
			state.setCurrentQuestionNote("for q1");
			expect(state.getQuestionNote("q1")).toBe("for q1");
			state.currentTab = 2;
			expect(state.getCurrentQuestionNote()).toBeUndefined();
			state.setCurrentQuestionNote("for q3");
			expect(state.getQuestionNote("q3")).toBe("for q3");
		});

		it("has nothing to attach to on the Done tab", () => {
			const { state } = make();
			state.currentTab = state.getDonetab();
			state.setCurrentQuestionNote("nowhere to put me");
			expect(state.getCurrentQuestionNote()).toBeUndefined();
			expect(Object.keys(state.noteFields()).filter((k) => k === "questionNotes")).toHaveLength(0);
		});

		it("survives skipping its question — the note is often the reason", () => {
			const { state } = make();
			state.setQuestionNote("q1", "I skipped because X");
			state.skipCurrentQuestion();
			expect(state.isQuestionSkipped("q1")).toBe(true);
			expect(state.getQuestionNote("q1")).toBe("I skipped because X");
		});
	});

	describe("noteFields and buildResult", () => {
		it("adds nothing at all when there are no notes", () => {
			const { state } = make();
			state.toggleOption("fast");
			expect(state.noteFields()).toEqual({});
			expect(Object.keys(state.buildResult()).sort()).toEqual(["answers", "skipped", "unanswered"]);
		});

		it("carries the shared note as `note`", () => {
			const { state } = make();
			state.toggleOption("fast");
			state.setSharedNote("shared");
			expect(state.buildResult().note).toBe("shared");
		});

		it("carries question notes keyed by id, in question order", () => {
			const { state } = make();
			state.setQuestionNote("q3", "third");
			state.setQuestionNote("q1", "first");
			expect(state.buildResult().questionNotes).toEqual({ q1: "first", q3: "third" });
			expect(Object.keys(state.buildResult().questionNotes!)).toEqual(["q1", "q3"]);
		});

		it("drops a note whose question is no longer being asked", () => {
			const { state } = make();
			state.setQuestionNote("q1", "kept");
			state.setQuestionNote("gone", "orphan");
			expect(state.getQuestionNote("gone")).toBe("orphan");
			expect(state.buildResult().questionNotes).toEqual({ q1: "kept" });
		});

		it("keeps both notes when every question was skipped or unanswered", () => {
			const { state } = make();
			for (const q of questions) state.skipCurrentQuestion(), state.advanceTab();
			state.setSharedNote("the whole ask is moot");
			state.setQuestionNote("q2", "still worth knowing");
			const result = state.buildResult();
			expect(result.answers).toEqual({});
			expect(result.note).toBe("the whole ask is moot");
			expect(result.questionNotes).toEqual({ q2: "still worth knowing" });
		});
	});

	describe("editor target bookkeeping", () => {
		it("an option note remembers which option it belongs to", () => {
			const { state } = make();
			state.beginEdit(EditorTarget.Option, "fast");
			expect(state.editorActive).toBe(true);
			expect(state.editorTarget).toBe(EditorTarget.Option);
			expect(state.noteEditingValue).toBe("fast");
		});

		it("a shared or question note remembers no option", () => {
			const { state } = make();
			state.beginEdit(EditorTarget.Option, "fast");
			state.beginEdit(EditorTarget.Shared);
			expect(state.editorTarget).toBe(EditorTarget.Shared);
			expect(state.noteEditingValue).toBeNull();
		});

		it("cancel clears the target as well as the active flag", () => {
			const { state } = make();
			state.beginEdit(EditorTarget.Option, "fast");
			state.cancelEdit();
			expect(state.editorActive).toBe(false);
			expect(state.editorTarget).toBeUndefined();
			expect(state.noteEditingValue).toBeNull();
		});
	});

	describe("keys", () => {
		it("n opens the shared note on a question tab", () => {
			const { handler } = make();
			expect(handler.process("n")).toBe(InputAction.StartSharedNote);
		});

		it("n opens it on a free-form tab too", () => {
			const { state, handler } = make();
			state.currentTab = 1;
			expect(handler.process("n")).toBe(InputAction.StartSharedNote);
		});

		it("n opens it on the Done tab, where Enter means submit", () => {
			const { state, handler } = make();
			state.currentTab = state.getDonetab();
			expect(handler.process("n")).toBe(InputAction.StartSharedNote);
			expect(handler.process("\r")).toBe(InputAction.Done);
		});

		it("m annotates the current question, options or not", () => {
			const { state, handler } = make();
			expect(handler.process("m")).toBe(InputAction.StartQuestionNote);
			state.currentTab = 1;
			expect(handler.process("m")).toBe(InputAction.StartQuestionNote);
		});

		it("m has no question to annotate on the Done tab", () => {
			const { state, handler } = make();
			state.currentTab = state.getDonetab();
			expect(handler.process("m")).toBe(InputAction.None);
		});

		it("neither key reaches through an open editor", () => {
			const { state, handler } = make();
			state.editorActive = true;
			expect(handler.process("n")).toBe(InputAction.None);
			expect(handler.process("m")).toBe(InputAction.None);
		});
	});

	describe("formatResult", () => {
		const questions = STRUCTURED;

		it("leaves the text untouched when there are no notes", () => {
			const result = { answers: { q1: [{ label: "Fast", value: "fast" }] }, skipped: [], unanswered: [] };
			const formatted = formatResult(result, questions);
			expect(formatted.content[0].text).toBe(JSON.stringify(result));
			expect("note" in formatted.details).toBe(false);
			expect("questionNotes" in formatted.details).toBe(false);
		});

		it("writes the shared note as a line above the JSON", () => {
			const result = { answers: {}, skipped: [], unanswered: ["q1"], note: "nothing without tests" };
			const [first, ...rest] = formatResult(result, questions).content[0].text.split("\n");
			expect(first).toBe("User note: nothing without tests");
			expect(JSON.parse(rest.join("\n")).note).toBe("nothing without tests");
		});

		it("names the question a question note belongs to", () => {
			const result = { answers: {}, skipped: [], unanswered: [], questionNotes: { q2: "free-form answer here" } };
			const text = formatResult(result, questions).content[0].text;
			expect(text).toContain('User note on q2 ("Free-form?"): free-form answer here');
		});

		it("keeps a multi-line note to one header line and the JSON to itself", () => {
			const result = { answers: {}, skipped: [], unanswered: [], note: "first\n\tsecond" };
			const [first, json] = [
				formatResult(result, questions).content[0].text.split("\n")[0],
				formatResult(result, questions).content[0].text.split("\n").slice(1).join("\n"),
			];
			expect(first).toBe("User note: first second");
			expect(JSON.parse(json).note).toBe("first\n\tsecond");
		});

		it("mirrors both notes into details for the transcript renderer", () => {
			const formatted = formatResult(
				{ answers: {}, skipped: [], unanswered: [], note: "shared", questionNotes: { q1: "one" } },
				questions,
			);
			expect(formatted.details.note).toBe("shared");
			expect(formatted.details.questionNotes).toEqual({ q1: "one" });
		});
	});
});
