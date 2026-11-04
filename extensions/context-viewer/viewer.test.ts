/**
 * The overlay itself: keys, windows, and what happens when the terminal is
 * smaller than the content. Everything here is driven through the public
 * surface — `handleInput` and `render` — because the bugs this component is
 * prone to (a selection scrolled out of the frame, a search that swallows
 * Escape, a copy that sends the wrong text) are only visible from outside.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ContextViewer, type ViewerTab } from "./viewer.ts";

/** The frame and the theme both add escapes; assertions read the text. */
function stripAnsi(lines: string[]): string[] {
	return lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\[\?25l|\u001b\[\?25h/g, ""));
}

const KEYS = {
	down: "\u001b[B",
	up: "\u001b[A",
	pageDown: "\u001b[6~",
	pageUp: "\u001b[5~",
	home: "\u001b[H",
	end: "\u001b[F",
	escape: "\u001b",
	tab: "\t",
	shiftTab: "\u001b[Z",
	enter: "\r",
	backspace: "\x7f",
	ctrlD: "\u0004",
	ctrlU: "\u0015",
	ctrlC: "\u0003",
} as const;

/** The real theme colours by token; these tests read text, so identity is enough. */
function themeMock() {
	return {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => text,
		getBgAnsi: () => "",
	} as never;
}

function harness(
	tabs: ViewerTab[],
	options: { rows?: number; cols?: number; initialTab?: number; copy?: (text: string) => Promise<string | undefined> | string | undefined } = {},
) {
	const rows = options.rows ?? 40;
	const cols = options.cols ?? 80;
	const renders: string[][] = [];
	let closed = 0;
	const copied: string[] = [];
	const copy = async (text: string) => {
		copied.push(text);
		return options.copy ? await options.copy(text) : undefined;
	};
	const viewer = new ContextViewer(
		tabs,
		// The real theme colours by token; the assertions read text, so identity
		// is enough and keeps the expectations readable.
		themeMock(),
		{ terminal: { rows, columns: cols }, requestRender: () => renders.push([]) } as never,
		() => {
			closed += 1;
		},
		{ initialTab: options.initialTab },
		copy,
	);
	return {
		viewer,
		copied,
		get closed() {
			return closed;
		},
		press(data: string) {
			viewer.handleInput(data);
		},
		async settle() {
			// `y` copies asynchronously; one microtask drain is the copy landing.
			await Promise.resolve();
			await Promise.resolve();
		},
		lines(width = cols): string[] {
			return stripAnsi(viewer.render(width)).map((line) => line.replace(/\s+$/, ""));
		},
		text(): string {
			return this.lines().join("\n");
		},
	};
}

const sample = (count: number, prefix = "line"): string[] => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);

function tabs(count = 3): ViewerTab[] {
	return Array.from({ length: count }, (_, index) => ({
		name: `Tab${index + 1}`,
		lines: sample(30, `t${index + 1}`),
		hint: `hint ${index + 1}`,
	}));
}

describe("rendering", () => {
	it("draws a frame with the title, the tab bar, the hint and the keys", () => {
		const h = harness(tabs());
		const lines = h.lines();
		assert.match(lines[0], /╔.*Context.*═+╗$/);
		assert.match(lines[lines.length - 1], /╚═+╝$/);
		const text = h.text();
		assert.match(text, /\[ Tab1 \]/);
		assert.match(text, /Tab2/);
		assert.match(text, /hint 1/);
		assert.match(text, /search/);
		assert.match(text, /line|scroll/);
	});

	it("keeps the frame intact when a tab hands it multi-line content", () => {
		// The bug this pins: one element holding a newline is painted as two rows
		// while the frame budgeted one, so the tab bar, the body and the footer all
		// land on the wrong row and the previous screen shows through underneath.
		const h = harness([{ name: "Messages", lines: ["one\ntwo\nthree", "second\nentry"] }]);
		for (const line of h.lines()) assert.ok(!line.includes("\n"), "a rendered row still contains a newline");
		const lines = h.lines();
		assert.match(lines[0], /╔ Context ═+╗/, `no header row: ${lines[0]}`);
		assert.match(lines[lines.length - 1], /╚═+╝/);
		assert.match(h.text(), /\[ Messages \]/);
	});

	it("wraps a long line instead of losing its tail", () => {
		const long = `${"word ".repeat(40)}ENDMARK`;
		const h = harness([{ name: "Wide", lines: [long, "after"] }], { rows: 20, cols: 60 });
		assert.match(h.text(), /ENDMARK/, "the end of a line wider than the frame is gone");
		for (const line of h.lines()) assert.ok(line.length <= 60, `line wider than the frame: ${line.length}`);
	});

	it("reaches the end of a wrapped line by scrolling", () => {
		// Long enough that its tail starts below the window: 2,000 characters at a
		// 56-column body is far more rows than the frame has.
		const long = `${"word ".repeat(400)}ENDMARK`;
		const h = harness([{ name: "Wide", lines: [long] }], { rows: 20, cols: 60 });
		assert.doesNotMatch(h.text(), /ENDMARK/, "the tail was already on screen; the line was not wrapped");
		h.press(KEYS.end);
		assert.match(h.text(), /ENDMARK/);
	});

	it("scrolls a match inside a wrapped line into view", () => {
		const long = `${"filler ".repeat(50)}needle ${"tail ".repeat(50)}`;
		const h = harness([{ name: "Wide", lines: [long, "another", "lines"] }], { rows: 20, cols: 60 });
		for (const ch of "/needle") h.press(ch);
		h.press(KEYS.enter);
		assert.equal(h.viewer.search.matches, 1);
		assert.match(h.text(), /needle/, "the match is counted but its row is not on screen");
	});

	it("breaks lines again when the frame is wider", () => {
		const long = `${"word ".repeat(30)}ENDMARK`;
		// Rows are cached per tab; a cache that ignored the width would keep
		// 40-column rows inside a 200-column frame after a resize.
		const narrow = harness([{ name: "Wide", lines: [long] }], { rows: 20, cols: 40 });
		assert.ok(narrow.lines(40).every((line) => line.length <= 40));
		const wide = harness([{ name: "Wide", lines: [long] }], { rows: 20, cols: 200 });
		assert.ok(
			wide.lines(200).some((line) => line.includes("ENDMARK") && line.includes("word")),
			`the wide frame kept the narrow wrapping\n${wide.lines(200).join("\n")}`,
		);
	});

	it("never draws a line wider than the frame it was asked for", () => {
		for (const cols of [20, 40, 79, 120]) {
			for (const rows of [6, 12, 50]) {
				const h = harness([{ name: "Wide", lines: ["x".repeat(500), ...sample(80)] }], { rows, cols });
				for (const line of h.lines(cols)) {
					assert.ok(line.length <= cols, `${cols}x${rows}: line of ${line.length} columns: ${line.slice(0, 30)}`);
				}
			}
		}
	});

	it("fills the body with content instead of padding it out", () => {
		const h = harness(tabs(1), { rows: 40 });
		const lines = h.lines();
		// Every row between the frame's top and bottom is drawn.
		assert.equal(lines.length - 2, Math.floor((40 * 92) / 100) - 2 * (Math.floor((40 * 92) / 100) >= 14 ? 1 : 0));
		assert.ok(h.text().includes("t1 1"));
	});

	it("keeps the frame intact on a terminal shorter than the content", () => {
		const h = harness(tabs(1), { rows: 6, cols: 40 });
		const lines = h.lines();
		assert.match(lines[0], /╔/);
		assert.match(lines[lines.length - 1], /╚/);
		// No vertical padding, no hint row, and still a body.
		assert.equal(lines.filter((line) => line.includes("hint")).length, 0);
	});

	it("says so when there is nothing to show", () => {
		const h = harness([]);
		assert.match(h.text(), /Empty|nothing/i);
	});
});

describe("scrolling", () => {
	it("moves one line at a time and stops at the end of the content", () => {
		const h = harness(tabs(1), { rows: 20 });
		const first = h.lines().find((line) => line.includes("t1 1"));
		h.press(KEYS.down);
		const after = h.lines();
		assert.equal(after.some((line) => line === first), false, "the first line is still at the top after scrolling down");
		const before = h.lines().find((line) => line.includes("t1 30"));
		assert.equal(before, undefined, "the last line should not be reachable from the top");
		for (let i = 0; i < 100; i += 1) h.press(KEYS.end);
		assert.ok(
			h.lines().some((line) => line.includes("t1 30")),
			"End did not reach the last line",
		);
		for (let i = 0; i < 100; i += 1) h.press(KEYS.home);
		assert.ok(h.lines().some((line) => line.includes("t1 1")), "Home did not return to the first line");
	});

	it("keeps one line of context when paging", () => {
		const h = harness(tabs(1), { rows: 20 });
		const shown = (lines: string[]) =>
			lines.map((line) => line.match(/t1 (\d+)/)?.[1]).filter((value): value is string => value !== undefined);
		const visibleBefore = shown(h.lines());
		h.press(KEYS.pageDown);
		const visibleAfter = shown(h.lines());
		assert.ok(visibleBefore.length > 2 && visibleAfter.length > 2);
		// Overlap by exactly one line is the point of paging rather than jumping.
		const overlap = visibleAfter.filter((line) => visibleBefore.includes(line));
		assert.ok(overlap.length >= 1 && overlap.length < Math.min(visibleBefore.length, visibleAfter.length));
	});
});

describe("tabs", () => {
	it("cycles forward and back through the tab list", () => {
		const h = harness(tabs());
		assert.equal(h.viewer.currentTab, 0);
		h.press(KEYS.tab);
		h.press(KEYS.tab);
		assert.equal(h.viewer.currentTab, 2);
		h.press(KEYS.shiftTab);
		assert.equal(h.viewer.currentTab, 1);
		h.press(KEYS.shiftTab);
		h.press(KEYS.shiftTab);
		h.press(KEYS.shiftTab);
		assert.equal(h.viewer.currentTab, 1);
	});

	it("opens on the requested tab", () => {
		const h = harness(tabs(), { initialTab: 2 });
		assert.match(h.text(), /\[ Tab3 \]/);
	});

	it("marks the active tab and drops the search when the tab changes", () => {
		const h = harness(tabs());
		h.press("/");
		h.press("t");
		assert.equal(h.viewer.search.active, true);
		h.press(KEYS.tab);
		assert.equal(h.viewer.search.active, false);
		assert.equal(h.viewer.search.query, "");
	});
});

describe("search", () => {
	it("finds matches case-insensitively as they are typed", () => {
		const h = harness([{ name: "T", lines: ["alpha", "BETA hat", "gamma", "another BETA"] }]);
		h.press("/");
		h.press("b");
		h.press("e");
		h.press("t");
		assert.deepEqual(h.viewer.search, { active: true, filtering: true, query: "bet", matches: 2, position: 0 });
	});

	it("moves through matches and keeps the current one on screen", () => {
		const long = [...sample(60, "filler"), "needle here", ...sample(60, "more"), "needle there"];
		const h = harness([{ name: "T", lines: long }], { rows: 20 });
		h.press("/");
		for (const char of "needle") h.press(char);
		h.press(KEYS.enter);
		assert.equal(h.viewer.search.matches, 2);
		assert.equal(h.lines().some((line) => line.includes("needle here")), true);
		h.press("n");
		assert.equal(h.viewer.search.position, 1);
		assert.equal(h.lines().some((line) => line.includes("needle there")), true);
		h.press("N");
		assert.equal(h.viewer.search.position, 0);
	});

	it("says what happened when there is nothing to find", () => {
		const h = harness([{ name: "T", lines: ["only this"] }]);
		h.press("n");
		assert.match(h.text(), /press \/ to search/);
		h.press("/");
		h.press("z");
		h.press(KEYS.enter);
		h.press("n");
		assert.match(h.text(), /no match for z/);
	});

	it("leaves search on the first Escape and closes on the second", () => {
		const h = harness(tabs(1));
		h.press("/");
		assert.equal(h.viewer.search.active, true);
		h.press(KEYS.escape);
		assert.equal(h.viewer.search.active, false);
		assert.equal(h.closed, 0, "Escape left search and should not also close the viewer");
		h.press(KEYS.escape);
		assert.equal(h.closed, 1);
	});

	it("edits the query with backspace and closes search with Enter", () => {
		const h = harness(tabs(1));
		h.press("/");
		h.press("a");
		h.press("b");
		h.press(KEYS.backspace);
		assert.equal(h.viewer.search.query, "a");
		h.press(KEYS.enter);
		assert.equal(h.viewer.search.active, false, "Enter gives the keyboard back to scrolling");
		assert.equal(h.viewer.search.filtering, true, "Enter keeps the filter applied");
		assert.equal(h.viewer.search.query, "a", "Enter does not undo the query");
	});

	it("accepts a space in the query instead of ignoring it", () => {
		const h = harness([{ name: "T", lines: ["alpha beta", "gamma"] }]);
		h.press("/");
		h.press("a");
		h.press(" ");
		h.press("b");
		assert.equal(h.viewer.search.query, "a b");
		assert.equal(h.viewer.search.matches, 1);
	});
});

describe("copy and close", () => {
	it("copies the whole tab, not the visible window", async () => {
		const h = harness([{ name: "Big", lines: sample(200) }], { rows: 12 });
		h.press("y");
		await h.settle();
		assert.equal(h.copied.length, 1);
		assert.equal(h.copied[0]?.split("\n").length, 200);
		assert.match(h.text(), /copied Big/);
	});

	it("reports a failed copy where the user is looking", async () => {
		const h = harness([{ name: "T", lines: ["a"] }], {
			copy: () => "pbcopy: not found",
		});
		h.press("y");
		await h.settle();
		assert.match(h.text(), /copy failed: pbcopy: not found/);
	});

	it("says so when there is no clipboard, without throwing", async () => {
		const rows = 12;
		let closed = 0;
		const viewer = new ContextViewer([{ name: "T", lines: ["a"] }], themeMock(), { terminal: { rows, cols: 40 }, requestRender() {} } as never, () => {
			closed += 1;
		});
		viewer.handleInput("y");
		await Promise.resolve();
		assert.equal(closed, 0, "a missing clipboard is not a reason to close");
		assert.match(stripAnsi(viewer.render(40)).join("\n"), /clipboard unavailable/);
	});

	it("closes on q and ctrl-c, and ignores keys after closing", () => {
		const q = harness(tabs(1));
		q.press("q");
		assert.equal(q.closed, 1);
		q.press("j");
		q.press(KEYS.escape);
		assert.equal(q.closed, 1, "done() runs once");

		const ctrlC = harness(tabs(1));
		ctrlC.press(KEYS.ctrlC);
		assert.equal(ctrlC.closed, 1);
	});
});
