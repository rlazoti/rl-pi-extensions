import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const panelSource = readFileSync(new URL("../extensions/panel.ts", import.meta.url), "utf-8");

test("panel: exports the four shared layout helpers", () => {
	assert.ok(panelSource.includes("export function fit("), "should export fit");
	assert.ok(panelSource.includes("export function panelLine("), "should export panelLine");
	assert.ok(panelSource.includes("export function frameLines("), "should export frameLines");
	assert.ok(panelSource.includes("export function fillRows("), "should export fillRows");
});

test("panel: frameLines takes the title as a parameter (pickers pass their own)", () => {
	assert.ok(
		panelSource.match(/export function frameLines\([\s\S]*?title: string/),
		"frameLines should accept the frame title as an explicit parameter",
	);
	assert.ok(
		!panelSource.includes('" Extensions "') && !panelSource.includes('" Snippets "'),
		"panel.ts must not hardcode either picker's title — pickers pass it at the call site",
	);
});

test("panel: fit delegates to truncateToWidth with a 1-column floor", () => {
	assert.ok(
		panelSource.includes("truncateToWidth(line, Math.max(1, width), \"\", true)"),
		"fit should truncate to at least 1 column",
	);
});

test("panel: panelLine paints the whole row with customMessageBg", () => {
	assert.ok(
		panelSource.includes('theme.getBgAnsi("customMessageBg")') &&
			panelSource.includes('theme.bg("customMessageBg", restored)'),
		"panelLine should pad then paint the row background, preserving ANSI resets",
	);
});

test("panel: fillRows pads with empty rows and never returns more than rows", () => {
	assert.ok(
		panelSource.includes('lines[index] ?? ""'),
		"fillRows should pad missing rows with empty strings",
	);
});

test("panel: frameLines preserves the double-line frame + paddingY structure", () => {
	assert.ok(panelSource.includes("╔") && panelSource.includes("╗"), "top border corners");
	assert.ok(panelSource.includes("╚") && panelSource.includes("╝"), "bottom border corners");
	assert.ok(
		panelSource.includes("Array<string>(paddingY).fill(blank)"),
		"paddingY blank rows above and below the body",
	);
	assert.ok(
		panelSource.includes("(line) => panelLine(theme, line, width)"),
		"every framed row should be panel-colored",
	);
});
