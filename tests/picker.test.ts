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
