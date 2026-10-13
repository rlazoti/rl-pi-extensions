import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

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

test("picker: getVisibleList returns filtered when searching, EXTENSIONS otherwise", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		pickerSource.includes("private getVisibleList()"),
		"picker should have getVisibleList helper",
	);
	assert.ok(
		pickerSource.includes("filtered.length > 0 ? filtered : EXTENSIONS"),
		"getVisibleList should return filtered list when searching, EXTENSIONS otherwise",
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
		spaceHandler[0].includes("isExtensionEnabled"),
		"space toggle should check current enabled state",
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
		pickerSource.includes("isExtensionEnabled"),
		"Space should update pendingChanges map based on current enabled state",
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
		"Render should check pendingChanges before falling back to isExtensionEnabled",
	);

	// enabledCount respects pending state
	assert.ok(
		pickerSource.includes("pendingChanges.get(e.name)"),
		"enabledCount should check pendingChanges before falling back to isExtensionEnabled",
	);

	// Does NOT call toggleExtension (which immediately modifies symlinks)
	assert.ok(
		!pickerSource.includes("toggleExtension("),
		"picker should not call toggleExtension (which immediately modifies symlinks)",
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

	// Status line must use the same pending-aware count as the list markers
	assert.ok(
		pickerSource.match(/\/\/ Status line[\s\S]*?const enabledCount = this\.enabledCount\(\)/),
		"status line should use the pending-aware enabledCount() helper",
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

function frameCallHasTitle(source: string, title: string): boolean {
	return source.includes(`frameLines(this.theme, content, safeWidth, paddingY, ${title})`);
}
