import assert from "node:assert/strict";
import test from "node:test";

import { ReviewCard, wrap, type ReviewHandlers, type ReviewItem, type ReviewResult } from "./review.ts";

/**
 * The card is driven through the same fake TUI harness the picker tests use:
 * a review that shows only the key is exactly the bug this component exists to
 * fix, so the body text has to be asserted in the rendered rows.
 */

interface Harness {
	card: ReviewCard;
	rows: string[];
	renders: number;
	result?: ReviewResult;
	calls: string[];
}

function item(overrides: Partial<ReviewItem> = {}): ReviewItem {
	return {
		key: "git.flow",
		scope: "global",
		kind: "rule",
		asOf: "2026-01-01",
		source: "migrated from knowledge/git-standards.md",
		origin: "migration",
		tags: ["always"],
		body: "Never push changes to GitHub without explicit confirmation. Always verify changes before committing.",
		ageDays: 1,
		flagged: false,
		file: "claims/rules/git.md",
		...overrides,
	};
}

function harness(items: ReviewItem[], options: { rows?: number; cols?: number; handlers?: Partial<ReviewHandlers> } = {}): Harness {
	const state: Harness = { card: undefined as unknown as ReviewCard, rows: [], renders: 0, result: undefined, calls: [] };
	const tui = {
		terminal: { rows: options.rows ?? 24, cols: options.cols ?? 80 },
		requestRender() {
			state.renders++;
		},
	};
	const theme = {
		fg: (_style: string, text: string) => text,
		bg: (_style: string, text: string) => text,
		getBgAnsi: () => "",
	} as never;
	const handlers: ReviewHandlers = {
		approve: (entry) => {
			state.calls.push(`approve ${entry.key}`);
			return `approved ${entry.key} @ ${entry.scope}`;
		},
		reject: (entry) => {
			state.calls.push(`reject ${entry.key}`);
			return `rejected ${entry.key} @ ${entry.scope}`;
		},
		defer: (entry) => {
			state.calls.push(`defer ${entry.key}`);
			return `deferred ${entry.key} @ ${entry.scope}`;
		},
		...options.handlers,
	};
	let result: ReviewResult | undefined;
	state.card = new ReviewCard(tui as never, theme, undefined as never, items, handlers, (value) => {
		result = value;
	});
	Object.defineProperty(state, "rows", {
		get: () => state.card.render(options.cols ?? 80).map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trimEnd()),
	});
	Object.defineProperty(state, "result", { get: () => result });
	return state;
}

test("review card: the claim's own words are on the screen, not just its name (R18)", () => {
	const card = harness([item({ replaces: "Push is fine, just be careful." })]);
	const rows = card.rows.join("\n");
	assert.match(rows, /Review 1\/1 — git\.flow @ global/);
	assert.match(rows, /rule · as of 2026-01-01 · 1 day\(s\) pending · migrated · tags: always/);
	assert.match(rows, /source: migrated from knowledge\/git-standards\.md/);
	assert.match(rows, /The claim:/);
	assert.match(rows, /Never push changes to GitHub without explicit confirmation\. Always verify/);
	assert.match(rows, /replaces: Push is fine, just be careful\./);
	assert.match(rows, /a approve · x reject · d defer · e edit wording/);
});

test("review card: a body that does not fit is truncated on whole lines and says how to read the rest", () => {
	const long = item({ body: "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey x-ray yankee zulu ".repeat(6), file: "claims/rules/long.md" });
	const card = harness([long], { rows: 24, cols: 60 });
	const rows = card.rows;
	assert.ok(rows.every((row) => row.length <= 60), "no row is wider than the panel");
	const text = rows.join("\n");
	assert.match(text, /more: memory_read claims\/rules\/long\.md/);
	const shown = rows.filter((row) => /alpha|bravo/.test(row));
	assert.ok(shown.length > 0, "the body still starts on screen");
	// Whole words only: a wrapped body row never ends inside a word.
	const bodyRows = rows.filter((row) => /\b(alpha|bravo|charlie|delta|echo|foxtrot|golf|hotel|india|juliet|kilo|lima|mike|november|oscar|papa|quebec|romeo|sierra|tango|uniform|victor|whiskey|x-ray|yankee|zulu)\b/.test(row));
	assert.ok(bodyRows.length > 3, "several body rows are shown");
	const alphabet = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "x-ray", "yankee", "zulu"];
	for (const row of bodyRows) {
		const last = row.replace(/[║═╔╚]/g, "").trimEnd().split(/\s+/).pop() ?? "";
		assert.ok(alphabet.includes(last), `"${last}" is a whole word, not a fragment`);
	}
	assert.ok(bodyRows.every((row) => /\s$/.test(row) || /[a-z]+\s*$/.test(row.trimEnd()) === false || true));
});

test("review card: the keys decide, advance, and finish the batch in one dialog", () => {
	const items = [item({ key: "a.one" }), item({ key: "b.two" }), item({ key: "c.three" })];
	const card = harness(items);
	card.card.handleInput("a"); // decide the first
	assert.deepEqual(card.calls, ["approve a.one"]);
	assert.match(card.rows.join("\n"), /Review 2\/3 — b\.two @ global/);
	assert.match(card.rows.join("\n"), /approved: approved a\.one @ global/);

	card.card.handleInput("x");
	card.card.handleInput("d");
	assert.deepEqual(card.calls, ["approve a.one", "reject b.two", "defer c.three"]);
	assert.deepEqual(card.result, {
		acted: [
			{ key: "a.one", action: "approved" },
			{ key: "b.two", action: "rejected" },
			{ key: "c.three", action: "deferred" },
		],
		stopped: false,
		at: 2,
	});
});

test("review card: n and p move without deciding, Esc keeps what was already decided", () => {
	const items = [item({ key: "a.one" }), item({ key: "b.two" }), item({ key: "c.three" })];
	const card = harness(items);
	card.card.handleInput("n");
	card.card.handleInput("n");
	assert.match(card.rows.join("\n"), /Review 3\/3 — c\.three/);
	assert.deepEqual(card.calls, [], "browsing decides nothing");
	card.card.handleInput("p");
	assert.match(card.rows.join("\n"), /Review 2\/3 — b\.two/);
	card.card.handleInput("a");
	card.card.handleInput("\u001b");
	assert.deepEqual(card.calls, ["approve b.two"]);
	// The cursor moved on after the decision, so stopping leaves it on the next
	// undecided claim — that is where a reopened review picks up.
	assert.deepEqual(card.result, { acted: [{ key: "b.two", action: "approved" }], stopped: true, at: 2 });
});

test("review card: editing hands the claim back, because no dialog opens inside a dialog", () => {
	const card = harness([item({ key: "a.one" }), item({ key: "b.two" })]);
	card.card.handleInput("n");
	card.card.handleInput("e");
	assert.equal(card.result?.edit?.key, "b.two");
	assert.equal(card.result?.stopped, true);
	assert.equal(card.result?.at, 1);
	assert.deepEqual(card.calls, [], "the edit itself is done by the caller with the editor");
});

test("review card: the frame fits the overlay it is drawn in, so the keys are never cut off", () => {
	// The overlay is 80% of the terminal; a card the height of the terminal puts its
	// footer past the overlay's edge.
	const card = harness([item({ body: "one two three four five six seven eight nine ten ".repeat(20) })], { rows: 40, cols: 80 });
	const budget = Math.floor((40 * 80) / 100);
	const bottom = card.rows.findIndex((row) => row.includes("╝"));
	assert.ok(bottom >= 0 && bottom < budget, `frame ends at row ${bottom + 1} of a ${budget}-row overlay`);
	assert.match(card.rows.slice(0, bottom).join("\n"), /a approve · x reject/, "the decision keys are inside the frame");
});

test("review card: an empty batch says so instead of rendering an empty frame", () => {
	const card = harness([]);
	assert.match(card.rows.join("\n"), /Nothing left in this batch\./);
});

test("wrap: whole words, nothing lost, an over-long word cut and kept", () => {
	assert.deepEqual(wrap("one two three", 9), ["one two", "three"]);
	assert.deepEqual(wrap("supercalifragilistic", 8), ["supercal", "ifragili", "stic"]);
	assert.deepEqual(wrap("a  b\tc", 5), ["a b c"], "whitespace runs collapse, as everywhere else");
	// The invariant that matters: wrapping never loses a character, and never
	// emits a row wider than the column.
	const long = wrap("x".repeat(31) + " tail", 7);
	assert.equal(long.join("").replace(/\s+/g, ""), "x".repeat(31) + "tail");
	assert.ok(long.every((line) => line.length <= 7), JSON.stringify(long));
});
