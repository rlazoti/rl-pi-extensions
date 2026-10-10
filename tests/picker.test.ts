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
		pickerSource.includes("Key.up") && pickerSource.includes("Key.down"),
		"picker should support up/down navigation",
	);
	assert.ok(
		pickerSource.includes("Key.space"),
		"picker should support space to toggle",
	);
	assert.ok(
		pickerSource.includes("Key.enter"),
		"picker should support enter to apply",
	);
	assert.ok(
		pickerSource.includes("Key.escape"),
		"picker should support escape to cancel",
	);
});
