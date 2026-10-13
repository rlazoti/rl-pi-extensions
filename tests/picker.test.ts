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

test("picker: space toggle flips the effective state, not the disk alone (v1.1.0 regression)", () => {
	const pickerSource = readFileSync(
		new URL("../extensions/rl-extensions/picker.ts", import.meta.url),
		"utf-8",
	);
	const spaceStart = pickerSource.indexOf("matchesKey(data, Key.space)");
	const spaceBlock = pickerSource.slice(spaceStart, pickerSource.indexOf("} else if", spaceStart));
	assert.ok(
		spaceBlock.match(/!\s*effective\b/) !== null,
		"space toggle must store the negation of the effective state; computing from the " +
			"disk alone made toggle-off-then-toggle-on a no-op and Enter would disable an " +
			"extension the user had re-selected",
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
