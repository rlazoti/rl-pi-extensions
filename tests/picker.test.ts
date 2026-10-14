import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExtensionPicker } from "../extensions/rl-extensions/picker.ts";
import { setExtensionsDirForTesting } from "../extensions/symlink-manager.ts";

// Behavioral harness: a real ExtensionPicker rendered against a fake TUI/theme/
// keybindings and a temp extensions dir. The source-string tests in this file
// only pin the shape of the module; the interaction bugs (hidden filter,
// phantom rows, off-screen selection) are only observable by rendering.
interface PickerHarness {
	picker: ExtensionPicker;
	readonly rows: string[];
	close(): void;
}

function createPickerHarness(terminalRows = 40, terminalCols = 80): PickerHarness {
	const dir = mkdtempSync(join(tmpdir(), "rl-picker-test-"));
	setExtensionsDirForTesting(dir);
	const theme = {
		fg: (_style: string, text: string) => text,
		bg: (_style: string, text: string) => text,
		getBgAnsi: () => "",
	} as never;
	const tui = { terminal: { rows: terminalRows, cols: terminalCols }, requestRender() {} } as never;
	const keybindings = {
		matches: (data: string, id: string) =>
			(id === "tui.select.up" && data === "up") ||
			(id === "tui.select.down" && data === "down") ||
			(id === "tui.select.confirm" && data === "enter"),
	} as never;
	const picker = new ExtensionPicker(tui, theme, keybindings, () => {});
	return {
		picker,
		get rows() {
			return picker.render(terminalCols).map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trimEnd());
		},
		close() {
			setExtensionsDirForTesting(undefined);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function searchLine(rows: string[]): string | undefined {
	return rows.find((row) => row.includes("Search"));
}

function listRows(rows: string[]): string[] {
	return rows.filter((row) =>
		/tmux-feedback|session-banner|session-attention|snippets|emacs-feedback/.test(row),
	);
}

// Test that the picker module exists and exports the expected symbols
test("picker: module exports openExtensionPicker", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		pickerSource.includes("export async function openExtensionPicker"),
		"picker should export openExtensionPicker",
	);
});

test("picker: module exports ExtensionPickerResult type", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		pickerSource.includes("export type ExtensionPickerResult"),
		"picker should export ExtensionPickerResult type",
	);
});

test("picker: module exports ExtensionPicker class", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		pickerSource.includes("export class ExtensionPicker"),
		"picker should export ExtensionPicker class",
	);
});

test("picker: uses framed panel layout like snippets", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		pickerSource.includes("frameLines"),
		"picker should use frameLines for framed layout",
	);
	assert.ok(
		pickerSource.includes("panelLine"),
		"picker should use panelLine for background coloring",
	);
});

test("picker: supports search functionality", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		pickerSource.includes("searchQuery"),
		"picker should track search query",
	);
	assert.ok(
		pickerSource.includes("filteredExtensions"),
		"picker should filter extensions by search",
	);
	assert.ok(
		pickerSource.includes('"/"'),
		"picker should handle / key to focus search",
	);
});

test("picker: overlay options match snippets picker pattern", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		pickerSource.includes('overlay: true'),
		"picker should use overlay mode",
	);
	assert.ok(
		pickerSource.includes('anchor: "center"'),
		"picker should anchor to center",
	);
	assert.ok(
		pickerSource.includes('width: "80%"'),
		"picker should use 80% width",
	);
});

test("picker: keyboard shortcuts match snippets picker", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		pickerSource.includes('"tui.select.up"') && pickerSource.includes('"tui.select.down"'),
		"picker should support up/down navigation via keybindings",
	);
	assert.ok(
		pickerSource.includes("Key.space"),
		"picker should support space to toggle",
	);
	assert.ok(
		pickerSource.includes('"tui.select.confirm"'),
		"picker should support confirm via keybindings",
	);
	assert.ok(
		pickerSource.includes("Key.escape"),
		"picker should support escape to cancel",
	);
});

test("picker: getVisibleList never falls back to the full catalog", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		pickerSource.includes("private getVisibleList()"),
		"picker should have getVisibleList helper",
	);
	assert.ok(
		pickerSource.includes("return this.filteredExtensions();"),
		"getVisibleList should delegate to the filtered list",
	);
	assert.ok(
		!pickerSource.includes("filtered.length > 0 ? filtered : EXTENSIONS"),
		"a search that matches nothing must not re-render the unfiltered catalog next to " +
			"'No matching extensions' — Space then toggled row 0 of a list that looked empty",
	);
});

test("picker: clampIndex prevents out-of-bounds selection", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		pickerSource.includes("private clampIndex("),
		"picker should have clampIndex helper",
	);
	assert.ok(
		pickerSource.includes("Math.max(0, Math.min(visible.length - 1, index))"),
		"clampIndex should clamp to valid range [0, visible.length - 1]",
	);
});

test("picker: navigation uses clampIndex instead of direct bounds", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	// Should use clampIndex for navigation
	assert.ok(
		pickerSource.includes("this.clampIndex(this.selectedIndex - 1)"),
		"up navigation should use clampIndex",
	);
	assert.ok(
		pickerSource.includes("this.clampIndex(this.selectedIndex + 1)"),
		"down navigation should use clampIndex",
	);

	// Should NOT use direct Math.min/Math.max with filtered.length
	const handleInputMatch = pickerSource.match(/handleInput[\s\S]*?changed\(\);\s*\}/);
	assert.ok(handleInputMatch, "should find handleInput method");
	const handleInput = handleInputMatch[0];
	assert.ok(
		!handleInput.includes("filtered.length - 1"),
		"navigation should not reference filtered.length directly",
	);
	assert.ok(
		!handleInput.includes("Math.max(0, this.selectedIndex"),
		"navigation should not use Math.max for index bounds",
	);
});

test("picker: toggle uses getVisibleList for extension lookup", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	// Space key handler should get visible list and update pendingChanges
	const spaceHandler = pickerSource.match(/matchesKey\(data,\s*Key\.space\)[\s\S]*?pendingChanges\.set/);
	assert.ok(spaceHandler, "should find space key handler");
	assert.ok(
		spaceHandler[0].includes("getVisibleList()"),
		"space toggle should use getVisibleList to find extension",
	);
	assert.ok(
		spaceHandler[0].includes("getExtensionStatus"),
		"space toggle should classify the current state (enabled/broken/disabled)",
	);
});

test("picker: space on a broken extension marks it for repair (enable)", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);
	const spaceStart = pickerSource.indexOf("matchesKey(data, Key.space)");
	assert.ok(spaceStart >= 0, "picker should have a space handler");
	const spaceBlock = pickerSource.slice(spaceStart, pickerSource.indexOf("} else if", spaceStart));

	// effective = pending ?? (status === "enabled") — a broken extension has
	// effective=false, so Space sets pending=true, which repairs the symlink
	// by re-pointing it at this checkout
	assert.ok(
		spaceBlock.includes('getExtensionStatus(ext.name) === "enabled"'),
		"effective state must derive enabled-ness from getExtensionStatus",
	);
	assert.ok(
		spaceBlock.includes("this.pendingChanges.get(ext.name)"),
		"space toggle must consult the pending state",
	);
});

test("picker: derives monorepo root from module location, not process.cwd()", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		pickerSource.includes("getAvailableExtensions(getMonorepoRoot())"),
		"extension paths must come from getMonorepoRoot() so symlinks point at this checkout",
	);
	assert.ok(
		!pickerSource.includes("process.cwd()"),
		"extension paths must not come from process.cwd() (the user's project)",
	);
});

test("picker: reports per-extension apply errors to the caller", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		pickerSource.includes("errors: readonly string[]"),
		"apply result should carry per-extension errors",
	);
	assert.ok(
		pickerSource.includes('kind: "apply", enabledCount: this.enabledCount(), errors'),
		"apply should return collected errors",
	);
	assert.ok(
		!pickerSource.includes("getEnabledExtensions"),
		"picker should not use the unused getEnabledExtensions helper",
	);
});

test("picker: tracks pending changes for undoable toggles", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	// Space updates pendingChanges (in-memory), not symlinks directly
	assert.ok(
		pickerSource.includes("pendingChanges.set") &&
		pickerSource.includes("getExtensionStatus"),
		"Space should update pendingChanges map based on the classified state",
	);

	// Enter applies pending changes via enable/disableExtension
	assert.ok(
		pickerSource.includes("pendingChanges.clear()") &&
		pickerSource.includes("enableExtension") &&
		pickerSource.includes("disableExtension"),
		"Enter should apply pending changes and clear the map",
	);

	// Render respects pending state
	assert.ok(
		pickerSource.includes("pendingChanges.get(ext.name)"),
		"Render should check pendingChanges before falling back to getExtensionStatus",
	);

	// enabledCount respects pending state
	assert.ok(
		pickerSource.includes("pendingChanges.get(e.name)"),
		"enabledCount should check pendingChanges before falling back to getExtensionStatus",
	);

	// Does NOT call toggleExtension (which immediately modifies symlinks)
	assert.ok(
		!pickerSource.includes("toggleExtension("),
		"picker should not call toggleExtension (which immediately modifies symlinks)",
	);
});

test("picker: README does not document controls the picker does not implement", () => {
	const readme = readFileSync(
		new URL("../extensions/rl-extensions/README.md", import.meta.url),
		"utf-8",
	);

	// Regression guard: a "Done button" (Tab) was documented in the v1.1.0
	// release but never implemented. Keep the README in sync with the keys
	// the picker actually handles (up/down/space///enter/escape).
	assert.ok(
		!readme.includes("Done button"),
		"README must not document a Done button (picker.ts has none)",
	);
	assert.ok(
		!readme.includes("`Tab`"),
		"README must not document Tab focus (picker has no Tab focus target)",
	);
});
test("picker: does not import getEnabledExtensions (M1)", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		!pickerSource.includes("getEnabledExtensions"),
		"picker should not import getEnabledExtensions — it is unused and broader than its name implies",
	);
});

test("picker: imports Theme from pi-coding-agent, not pi-tui (M10)", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		pickerSource.match(/import\s+type\s*{[^}]*Theme[^}]*}\s*from\s*"@earendil-works\/pi-coding-agent"/),
		"Theme type must come from pi-coding-agent — pi-tui does not export Theme",
	);
	const piTuiImport = pickerSource.match(/import\s*{[\s\S]*?}\s*from\s*"@earendil-works\/pi-tui"/)?.[0] ?? "";
	assert.ok(
		!piTuiImport.includes("Theme"),
		"pi-tui import block must not reference Theme",
	);
});

test("picker: status line is pending-aware and shows pending count (M2)", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	// Status line must derive its counts from the pending-aware
	// effective statuses, not raw live symlinks
	assert.ok(
		pickerSource.includes("const effectiveStatuses"),
		"status line should count pending-aware effective statuses",
	);
	assert.ok(
		!pickerSource.match(/Status line[\s\S]*?isExtensionEnabled\(e\.name\)\)\.length/),
		"status line must not count raw live symlinks (would disagree with pending markers)",
	);
	assert.ok(
		pickerSource.includes('pendingChanges.size > 0') && pickerSource.includes("pending`"),
		"status line should surface the number of pending (unapplied) toggles",
	);
});

test("picker: search keystrokes clamp the selection instead of resetting it (M3)", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	const searchBlock = pickerSource.match(/if \(this\.searchFocused\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? "";
	assert.ok(searchBlock, "should find the search-focused input block");
	assert.ok(
		searchBlock.includes("this.clampIndex(this.selectedIndex)"),
		"search keystrokes should clamp the current selection to the (possibly smaller) visible list",
	);
	assert.ok(
		!searchBlock.includes("this.selectedIndex = 0"),
		"search keystrokes must not reset the selection to 0",
	);
});

test("picker: shared panel layout comes from ../panel.js (M4)", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		pickerSource.match(/import\s*{\s*fit\s*,\s*fillRows\s*,\s*frameLines\s*,\s*panelLine\s*}\s*from\s*"..\/panel\.js"/),
		"picker should import fit/fillRows/frameLines/panelLine from the shared panel module",
	);
	assert.ok(
		frameCallHasTitle(pickerSource, '" Extensions "'),
		"picker should pass its frame title to the shared frameLines",
	);
	assert.ok(
		!pickerSource.includes("function frameLines(") &&
			!pickerSource.includes("function panelLine(") &&
			!pickerSource.includes("function fillRows(") &&
			!pickerSource.match(/function fit\(/),
		"picker should not define its own panel layout helpers anymore",
	);
});

test("snippets picker: shared panel layout comes from ../panel.js (M4)", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/snippets/picker.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		pickerSource.match(/import\s*{\s*fit\s*,\s*fillRows\s*,\s*frameLines\s*,\s*panelLine\s*}\s*from\s*"..\/panel\.js"/),
		"snippets picker should import fit/fillRows/frameLines/panelLine from the shared panel module",
	);
	assert.ok(
		frameCallHasTitle(pickerSource, '" Snippets "'),
		"snippets picker should pass its frame title to the shared frameLines",
	);
	assert.ok(
		!pickerSource.includes("function frameLines(") &&
			!pickerSource.includes("function panelLine(") &&
			!pickerSource.includes("function fillRows(") &&
			!pickerSource.match(/function fit\(/),
		"snippets picker should not define its own panel layout helpers anymore",
	);
});

test("picker: space toggle flips the effective state, not the disk alone (v1.1.0 regression)", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);
	const spaceStart = pickerSource.indexOf("matchesKey(data, Key.space)");
	assert.ok(spaceStart >= 0, "picker should have a space handler");
	const spaceBlock = pickerSource.slice(spaceStart, pickerSource.indexOf("} else if", spaceStart));
	assert.ok(
		spaceBlock.includes("this.pendingChanges.get(ext.name)"),
		"space toggle must read the pending state (effective = pending ?? disk); computing " +
			"!isExtensionEnabled() from the disk alone made toggle-off-then-toggle-on a no-op " +
			"and Enter would disable an extension the user had re-selected",
	);
	assert.ok(
		spaceBlock.match(/!\s*effective\b/) !== null,
		"space toggle must store the negation of the effective state",
	);
});

test("picker: an active search query stays visible after leaving the search box", () => {
	const harness = createPickerHarness();
	try {
		harness.picker.handleInput("/");
		for (const char of "emacs") harness.picker.handleInput(char);
		assert.ok(
			searchLine(harness.rows)?.includes("Search › emacs"),
			"the focused search box shows the query",
		);

		harness.picker.handleInput("\u001b"); // Esc leaves the box; the filter stays applied
		const line = searchLine(harness.rows);
		assert.ok(
			line?.includes("emacs"),
			`an unfocused search box must keep showing the active filter, got: ${JSON.stringify(line)}`,
		);
		assert.ok(
			!line?.includes("name or description"),
			"the placeholder must not mask an active filter (users otherwise act on a list they\n" +
				"believe is unfiltered — the bug that let Space toggle a row the search had filtered out)",
		);
	} finally {
		harness.close();
	}
});

test("picker: a search that matches nothing renders no rows and cannot be toggled", () => {
	const harness = createPickerHarness();
	try {
		harness.picker.handleInput("/");
		for (const char of "zzz") harness.picker.handleInput(char);

		const rows = harness.rows;
		assert.ok(
			rows.some((row) => row.includes("No matching extensions")),
			"the empty state should be shown",
		);
		assert.deepEqual(
			listRows(rows),
			[],
			"no extension rows may be rendered when the search matches nothing: " +
				"the old fallback listed all five rows and Space toggled the first one",
		);

		harness.picker.handleInput("\u001b"); // leave the search box
		harness.picker.handleInput(" "); // Space with nothing on screen must do nothing
		assert.ok(
			harness.rows.some((row) => row.includes("0/5 enabled") && !row.includes("pending")),
			`no toggle may be queued while the list is empty, got: ${JSON.stringify(
				harness.rows.filter((row) => row.includes("enabled")),
			)}`,
		);
	} finally {
		harness.close();
	}
});

test("picker: a matching search narrows the list to just the matches", () => {
	const harness = createPickerHarness();
	try {
		harness.picker.handleInput("/");
		for (const char of "emacs") harness.picker.handleInput(char);
		const rows = listRows(harness.rows);
		assert.equal(rows.length, 1, `expected only emacs-feedback, got: ${JSON.stringify(rows)}`);
		assert.ok(rows[0]?.includes("emacs-feedback"));
	} finally {
		harness.close();
	}
});

test("picker: keeps the selected row on screen when the list is taller than the panel", () => {
	const harness = createPickerHarness(18, 80);
	try {
		for (let step = 0; step < 4; step++) harness.picker.handleInput("down");

		const rows = harness.rows;
		const marked = rows.filter((row) => row.includes("›"));
		assert.equal(
			marked.length,
			1,
			`exactly one row must carry the selection marker, got: ${JSON.stringify(marked)}`,
		);
		assert.ok(
			marked[0]?.includes("emacs-feedback"),
			`the fifth row must be scrolled into view instead of leaving the panel, got: ${JSON.stringify(marked[0])}`,
		);

		harness.picker.handleInput(" ");
		assert.ok(
			harness.rows.some((row) => row.includes("emacs-feedback") && row.includes("●")),
			"Space must toggle the row the marker is on, not an off-screen one",
		);
	} finally {
		harness.close();
	}
});

test("picker: short terminals keep list rows and the footer they can afford", () => {
	for (const terminalRows of [10, 12, 14, 16, 18, 20, 22, 24, 26, 30, 40]) {
		const harness = createPickerHarness(terminalRows, 80);
		try {
			const rendered = harness.rows;
			const drawn = listRows(rendered).length;
			const footer = rendered.some((row) => row.includes("↑↓ navigate"));

			assert.ok(drawn > 0, `terminal height ${terminalRows} must render at least one extension row`);
			if (terminalRows >= 19) {
				assert.ok(footer, `terminal height ${terminalRows} must keep the key-hint footer`);
			}
			if (terminalRows >= 22) {
				assert.equal(drawn, 5, `terminal height ${terminalRows} must draw every extension`);
			}
		} finally {
			harness.close();
		}
	}
});

test("picker: the status line says when rows are hidden by a short panel", () => {
	const harness = createPickerHarness(18, 80);
	try {
		const status = harness.rows.find((row) => row.includes("enabled"));
		assert.ok(
			status?.includes("4/5 shown"),
			`a truncated list must announce how much it hid, got: ${JSON.stringify(status)}`,
		);
	} finally {
		harness.close();
	}
});

function frameCallHasTitle(source: string, title: string): boolean {
	return source.includes(`frameLines(this.theme, content, safeWidth, paddingY, ${title})`);
}
