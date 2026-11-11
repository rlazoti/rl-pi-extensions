/**
 * The text layer: every string a task can turn into.
 *
 * This is the single vocabulary shared by the widget, the tool results and the
 * system prompt, so its tests are about what a reader — a human glancing above the
 * editor, or a model re-reading the prompt on turn forty — can actually tell
 * apart. Two invariants matter more than the exact glyphs: a line never exceeds
 * the width it was given, and nothing is hidden without saying so.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
	ATTENTION_MAX_ROWS,
	DENSITY_SHORTCUT,
	MAX_WIDGET_TASKS,
	SPINNER_FRAMES,
	blockerHint,
	counts,
	formatDuration,
	listForLLM,
	openBlockers,
	priorityLabel,
	plainPaint,
	rendersSpinner,
	rowIcon,
	statusIcon,
	summaryLine,
	systemPromptBlock,
	taskDetailText,
	themePaint,
	toolResultText,
	truncateVisible,
	widgetLines,
	type Paint,
} from "./render.ts";
import type { Task, TaskStatus, WidgetDensity } from "./types.ts";

/** The paint a theme produces, without a theme: it marks each role visibly. */
const marks: Paint = (role, text) => `<${role}>${text}</>`;

const PRIORITY_WORDS = (["high", "medium", "low"] as const).map(priorityLabel);

/** A Theme stand-in that paints with real escapes, so truncation has something to survive. */
const colouredTheme = {
	fg: (_token: string, text: string) => `\u001b[31m${text}\u001b[39m`,
	bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
	strikethrough: (text: string) => `\u001b[9m${text}\u001b[29m`,
} as never;

const ALL_STATUSES: TaskStatus[] = ["pending", "in_progress", "completed", "blocked", "failed", "cancelled"];

function task(overrides: Partial<Task> & { id: string }): Task {
	return {
		content: `Task ${overrides.id}`,
		status: "pending",
		priority: "medium",
		metadata: {},
		blocks: [],
		blockedBy: [],
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function widget(tasks: readonly Task[], options = {}): string[] {
	return widgetLines(tasks, { width: 80, ...options });
}

describe("counts and the summary line", () => {
	it("tallies every status exactly once", () => {
		const tally = counts(ALL_STATUSES.map((status, index) => task({ id: `t${index}`, status })));
		assert.deepEqual(tally, {
			total: 6,
			completed: 1,
			inProgress: 1,
			blocked: 1,
			failed: 1,
			cancelled: 1,
			pending: 1,
		});
	});

	it("says 1 task, not 1 tasks", () => {
		assert.equal(summaryLine([task({ id: "t1" })]), "1 task (1 open)");
		assert.equal(summaryLine([]), "0 tasks");
	});

	it("names only the buckets that are non-empty", () => {
		const line = summaryLine([
			task({ id: "t1", status: "completed" }),
			task({ id: "t2", status: "in_progress" }),
			task({ id: "t3", status: "blocked" }),
		]);
		assert.equal(line, "3 tasks (1 done, 1 in progress, 1 blocked)");
	});

	it("paints the buckets a human reacts to", () => {
		const line = summaryLine([task({ id: "t1", status: "failed" })], marks);
		assert.ok(line.includes("<error>1 failed</>"), line);
		assert.ok(line.startsWith("<accent>"), "the count is the anchor of the line");
	});
});

describe("icons, priorities and durations", () => {
	it("gives a live task the spinner rather than its status glyph", () => {
		const running = task({ id: "t1", status: "in_progress" });
		assert.equal(rowIcon(running, true, "✳", plainPaint), "✳");
		assert.notEqual(rowIcon(running, false, "✳", plainPaint), "✳");
	});

	it("gives every status its own glyph", () => {
		const glyphs = ALL_STATUSES.map(statusIcon);
		assert.equal(new Set(glyphs).size, glyphs.length, "a widget row has to be readable at a glance");
	});

	it("keeps priority words short and distinct", () => {
		assert.equal(new Set(PRIORITY_WORDS).size, 3);
		for (const word of PRIORITY_WORDS) assert.ok(word.length <= 6, `${word} is too wide for a row`);
	});

	it("formats elapsed time in the unit a person reads", () => {
		assert.equal(formatDuration(900), "0s");
		assert.equal(formatDuration(42_000), "42s");
		assert.equal(formatDuration(200_000), "3m 20s");
		assert.equal(formatDuration(120_000), "2m");
		assert.equal(formatDuration(3_900_000), "1h 5m");
		assert.equal(formatDuration(-5), "0s", "a clock skew must not print a negative duration");
	});
});

describe("blockers", () => {
	it("counts only the blockers that still have to resolve", () => {
		const all = [
			task({ id: "t1", status: "completed" }),
			task({ id: "t2", status: "in_progress" }),
			task({ id: "t3", blockedBy: ["t1", "t2"] }),
		];
		assert.deepEqual(
			openBlockers(all[2]!, all).map((blocker) => blocker.id),
			["t2"],
		);
		assert.equal(blockerHint(all[2]!, all, plainPaint), " › blocked by #t2");
		assert.equal(blockerHint(all[0]!, all, plainPaint), "");
	});

	it("does not invent a blocker out of a dangling id", () => {
		const orphan = task({ id: "t1", blockedBy: ["t99"] });
		assert.deepEqual(openBlockers(orphan, [orphan]), [], "a link to a deleted task is not open work");
	});
});

describe("the widget", () => {
	it("returns nothing for an empty list, so no row is reserved", () => {
		assert.deepEqual(widget([]), []);
	});

	it("puts the count on the first line and one line per task after it", () => {
		const lines = widget([task({ id: "t1" }), task({ id: "t2", status: "completed" })]);
		assert.equal(lines.length, 3);
		assert.ok(lines[0]!.includes("2 tasks"));
	});

	it("indents a subtask under its parent", () => {
		const lines = widget([task({ id: "t1" }), task({ id: "t2", parentId: "t1" })]);
		assert.ok(lines[1]!.startsWith("  "), "a parent starts at the left margin");
		assert.ok(lines[2]!.startsWith("    "), "a subtask is visibly one level in");
	});

	it("shows a subtask even when its parent is gone", () => {
		assert.equal(widget([task({ id: "t2", parentId: "t1" })]).length, 2, "an orphan must stay reachable");
	});

	it("shows the active form and the elapsed time while a task is running", () => {
		const running = task({ id: "t1", status: "in_progress", activeForm: "Fixing the parser", startedAt: 1_000 });
		const lines = widget([running], {
			activeIds: new Set(["t1"]),
			startedAt: new Map([["t1", 1_000]]),
			now: 43_000,
			frame: 0,
		});
		const row = String(lines[1]);
		assert.ok(row.includes("Fixing the parser…"), row);
		assert.ok(row.includes("42s"), row);
		assert.ok(row.includes(SPINNER_FRAMES[0]!), row);
	});

	it("counts the rows it hides instead of hiding them", () => {
		const many = Array.from({ length: MAX_WIDGET_TASKS + 3 }, (_unused, index) => task({ id: `t${index + 1}` }));
		const lines = widget(many);
		assert.equal(lines.length, MAX_WIDGET_TASKS + 2, "one header, the cap, and the overflow line");
		assert.ok(lines.at(-1)!.includes("3 more"), String(lines.at(-1)));
		assert.ok(lines.at(-1)!.includes("TodoList"), "it says where the rest can be read");
	});

	it("keeps every line inside the width it was given, even with hostile content", () => {
		const hostile = task({ id: "t1", content: "x".repeat(300), owner: "a-long-owner-name" });
		for (const width of [8, 20, 40]) {
			for (const line of widget([hostile], { width })) {
				assert.ok(visibleWidth(line) <= width, `width ${width} got ${visibleWidth(line)}: ${line}`);
			}
		}
	});

	it("never returns a line containing a newline, whatever the task says", () => {
		const hostile = task({ id: "t1", content: "two\nlines", activeForm: "a\ttab", owner: "x\r\ny" });
		const lines = widget([hostile], { width: 40, activeIds: new Set(["t1"]) });
		assert.ok(lines.length > 1);
		for (const line of lines) {
			assert.equal(line.includes("\n"), false, "one element of render() is one terminal row");
		}
	});
});

/**
 * The three densities exist because the widget sits on top of somebody's output.
 * What matters is not the exact row count but the two promises each one makes:
 * the tally survives, and nothing is dropped without a line that says so.
 */
describe("the widget's density", () => {
	const busy = [
		task({ id: "t1", status: "completed" }),
		task({ id: "t2", status: "in_progress", activeForm: "Fixing the parser" }),
		task({ id: "t3", status: "blocked" }),
		task({ id: "t4", status: "failed" }),
		task({ id: "t5" }),
		task({ id: "t6" }),
	];
	const DENSITIES: WidgetDensity[] = ["full", "attention", "minimal"];

	it("opens every density with the tally, so contracting never hides the plan's size", () => {
		for (const density of DENSITIES) {
			assert.match(widget(busy, { density })[0]!, /6 tasks/, density);
		}
	});

	it("shows the queue in full and drops it in attention", () => {
		const full = widget(busy, { density: "full" });
		const attention = widget(busy, { density: "attention" });
		assert.equal(full.length, 1 + busy.length, "full is what it always was");
		assert.equal(attention.length, 5, "the tally, the three rows, and the count of what was dropped");
		for (const line of attention) {
			assert.equal(line.includes("Task t5"), false, "queued work is the row budget going to waste");
			assert.equal(line.includes("Task t1"), false, "finished work is worse");
		}
		assert.ok(attention.some((line) => line.includes("Task t3")));
		assert.match(attention.at(-1)!, /3 more/, "and the three are named as three");
	});

	it("caps attention rows too, because thirty blocked tasks is still a wall", () => {
		const stuck = Array.from({ length: ATTENTION_MAX_ROWS + 2 }, (_unused, index) =>
			task({ id: `b${index}`, status: "blocked" }),
		);
		const lines = widget(stuck, { density: "attention" });
		assert.equal(lines.length, ATTENTION_MAX_ROWS + 2, "tally, the cap, the overflow line");
		assert.match(lines.at(-1)!, /2 more/, String(lines.at(-1)));
	});

	it("says so when attention has nothing to show, rather than silently becoming minimal", () => {
		const calm = [task({ id: "t1" }), task({ id: "t2", status: "completed" })];
		const lines = widget(calm, { density: "attention" });
		assert.equal(lines.length, 2);
		assert.match(lines[1]!, /nothing needs attention/);
	});

	it("keeps the running task in the one line minimal spends", () => {
		const lines = widget(busy, {
			density: "minimal",
			activeIds: new Set(["t2"]),
			startedAt: new Map([["t2", 1_000]]),
			now: 43_000,
			frame: 0,
		});
		assert.equal(lines.length, 1);
		assert.ok(lines[0]!.includes("Fixing the parser…"), lines[0]);
		assert.ok(lines[0]!.includes("42s"), lines[0]);
		assert.ok(lines[0]!.includes(SPINNER_FRAMES[0]!), "the row is where the animation lives now");
		assert.match(lines[0]!, /6 tasks/, "and the counts ride along");
	});

	it("is just the tally in minimal when nothing is running", () => {
		const lines = widget(
			busy.filter((one) => one.status !== "in_progress"),
			{ density: "minimal" },
		);
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, /5 tasks/);
	});

	it("names the way back on the row that took the rows away", () => {
		const overflowing = (cap: number, status: TaskStatus) =>
			Array.from({ length: cap + 3 }, (_unused, index) => task({ id: `t${index}`, status }));
		const rows = widget(overflowing(MAX_WIDGET_TASKS, "pending"), { density: "full" }).at(-1)!;
		assert.ok(rows.includes(DENSITY_SHORTCUT), `full: ${rows}`);
		const contracted = widget(overflowing(ATTENTION_MAX_ROWS, "blocked"), { density: "attention" }).at(-1)!;
		assert.ok(contracted.includes(DENSITY_SHORTCUT), `attention: ${contracted}`);
	});

	it("holds the width and one-row-per-element rules at every density", () => {
		const hostile = task({
			id: "t1",
			status: "in_progress",
			content: `two\nlines ${"x".repeat(200)}`,
			activeForm: "a\ttab",
			owner: "x\r\ny",
		});
		const stuck = task({ id: "t2", status: "blocked" });
		for (const density of DENSITIES) {
			for (const width of [8, 20, 40]) {
				for (const line of widget([hostile, stuck], { density, width, activeIds: new Set(["t1"]) })) {
					assert.ok(visibleWidth(line) <= width, `${density} at ${width}: ${visibleWidth(line)}`);
					assert.equal(line.includes("\n"), false, `${density}: one element is one terminal row`);
				}
			}
		}
	});
});

/**
 * The widget only runs its 200 ms repaint while a spinner is on screen. That
 * question has to be answered by the same selection the renderer uses, or a
 * contracted widget keeps a timer alive for a row nobody can see.
 */
describe("which density still shows a spinner", () => {
	const running = task({ id: "t1", status: "in_progress" });
	const active = new Set(["t1"]);
	const stuck = Array.from({ length: ATTENTION_MAX_ROWS }, (_unused, index) =>
		task({ id: `b${index}`, status: "blocked" }),
	);

	it("is nobody's business with no active task", () => {
		assert.equal(rendersSpinner([running], { density: "full" }), false);
		assert.equal(rendersSpinner([], { density: "full", activeIds: active }), false);
	});

	it("is true in full and in attention, where the running task has a row", () => {
		for (const density of ["full", "attention"] as const) {
			assert.equal(rendersSpinner([running], { density, activeIds: active }), true, density);
		}
	});

	it("is true in minimal, whose single row carries the spinner", () => {
		assert.equal(rendersSpinner([running], { density: "minimal", activeIds: active }), true);
	});

	it("is false when the attention cap cut the running task off", () => {
		// The blocked ones are listed first, so the cap fills before the runner arrives.
		assert.equal(rendersSpinner([...stuck, running], { density: "attention", activeIds: active }), false);
		assert.equal(rendersSpinner([...stuck, running], { density: "full", activeIds: active }), true);
	});

	it("is false for an active task that is no longer in progress", () => {
		const reopened = task({ id: "t1", status: "pending" });
		assert.equal(rendersSpinner([reopened], { density: "full", activeIds: active }), false);
	});
});

describe("tool results", () => {
	it("says the list is empty rather than printing nothing", () => {		assert.equal(toolResultText([]), "Task list is empty");
	});

	it("leads with a tally line, then the tasks", () => {
		const text = toolResultText([task({ id: "t1", status: "completed" }), task({ id: "t2", status: "in_progress" })]);
		const [headline, ...rows] = text.split("\n");
		assert.ok(headline!.includes("1/2 done"), headline);
		assert.ok(headline!.includes("1 active"), headline);
		assert.equal(rows.length, 2);
	});

	it("collapses at five rows and says how many are left", () => {
		const many = Array.from({ length: 8 }, (_unused, index) => task({ id: `t${index + 1}` }));
		const collapsed = toolResultText(many);
		const expanded = toolResultText(many, { expanded: true });
		assert.equal(collapsed.split("\n").length, 7, "headline, five rows, one overflow line");
		assert.ok(collapsed.includes("3 more, expand to see them"));
		assert.equal(expanded.split("\n").length, 9, "expanded is the whole list, no overflow line");
	});
});

describe("the list the model reads", () => {
	it("says there are no tasks in words", () => {
		assert.equal(listForLLM([]), "No tasks.");
	});

	it("marks what can be started and what cannot", () => {
		const lines = listForLLM([task({ id: "t1" }), task({ id: "t2", blockedBy: ["t1"] })]).split("\n");
		assert.ok(lines[0]!.includes("#t1") && lines[0]!.includes("[ready]"), lines[0]);
		assert.ok(lines[1]!.includes("[blocked by #t1]"), lines[1]);
		assert.equal(lines[1]!.includes("[ready]"), false, "blocked work must not look startable");
	});

	it("groups by status in the order work should be read", () => {
		const text = listForLLM([
			task({ id: "t1", status: "completed" }),
			task({ id: "t2", status: "pending" }),
			task({ id: "t3", status: "in_progress" }),
		]);
		const ids = text.split("\n").map((line) => /#(t\d)/.exec(line)![1]);
		assert.deepEqual(ids, ["t2", "t3", "t1"]);
	});

	it("numbers the list in the order the tasks were created", () => {
		const many = ["t1", "t2", "t10", "t20"].map((id) => task({ id }));
		const ids = listForLLM(many)
			.split("\n")
			.map((line) => /#(t\d+)/.exec(line)![1]);
		assert.deepEqual(ids, ["t1", "t2", "t10", "t20"], "t10 before t2 would read as a wrong plan");
	});

	it("keeps the hierarchy and the owner visible", () => {
		const text = listForLLM([task({ id: "t1", owner: "reviewer" }), task({ id: "t2", parentId: "t1" })]);
		assert.ok(text.includes("[subtask of #t1]"));
		assert.ok(text.includes("[owner: reviewer]"));
	});
});

describe("one task in full", () => {
	it("prints the fields the model declared, in a fixed order", () => {
		const all = [
			task({ id: "t1", status: "completed", startedAt: 1_000, completedAt: 66_000 }),
			task({ id: "t2", blockedBy: ["t1"] }),
		];
		const text = taskDetailText(all[1]!, all);
		assert.ok(text.startsWith("Task #t2: Task t2"));
		assert.ok(text.includes("Status: pending"));
		assert.ok(text.includes("Description: (none)"));

		const done = taskDetailText(all[0]!, all);
		assert.ok(done.includes("Took: 1m 5s"), done);
	});

	it("prints a blocker list only when there is one", () => {
		const free = task({ id: "t1" });
		assert.equal(taskDetailText(free, [free]).includes("Blocked by"), false);
	});
});

describe("the block put in front of the model every turn", () => {
	it("is absent when nothing is open", () => {
		assert.equal(systemPromptBlock([]), "");
		assert.equal(systemPromptBlock([task({ id: "t1", status: "completed" })]), "", "finished work costs no tokens");
	});

	it("lists open work and says how to change it", () => {
		const block = systemPromptBlock([
			task({ id: "t1", status: "in_progress" }),
			task({ id: "t2" }),
			task({ id: "t3", status: "completed" }),
		]);
		assert.ok(block.includes("## Current Task List"));
		assert.ok(block.includes("TodoUpdate"));
		assert.ok(block.includes("[t1]") && block.includes("← in progress"));
		assert.ok(block.includes("[t2]"));
		assert.equal(block.includes("[t3]"), false, "a completed task is counted, not listed");
		assert.ok(block.includes("1/3 tasks completed."));
	});

	it("encourages authorized execution without overriding a stop, question or blocker", () => {
		const block = systemPromptBlock([task({ id: "t1" })]);
		assert.match(block, /continue to the next actionable task/i);
		assert.match(block, /user.*stop/i);
		assert.match(block, /decision|approval/i);
		assert.match(block, /blocked|cannot safely/i);
		assert.match(block, /status|question/i);
	});

	it("shows what is blocked, and by whom", () => {
		const block = systemPromptBlock([task({ id: "t1" }), task({ id: "t2", blockedBy: ["t1"] })]);
		assert.ok(block.includes("[t2]") && block.includes("[blocked by #t1]"), block);
	});
});

describe("truncation", () => {
	it("counts only the visible characters of a coloured line", () => {
		const coloured = themePaint(colouredTheme)("error", "x".repeat(50));
		assert.equal(visibleWidth(coloured), 50, "escape codes must not be counted as width");

		const cut = truncateVisible(coloured, 10);
		assert.ok(visibleWidth(cut) <= 10, `visible width is ${visibleWidth(cut)}`);
		assert.ok(cut.includes("\u001b[31m"), "the colour survives the cut");
		assert.ok(cut.includes("…"), "a cut line says it was cut");
	});

	it("never returns a longer line than it was asked for", () => {
		for (const width of [1, 2, 5, 40]) {
			const cut = truncateVisible("abcdefghij", width);
			assert.ok(visibleWidth(cut) <= width, `width ${width} got ${visibleWidth(cut)}`);
		}
	});
});
