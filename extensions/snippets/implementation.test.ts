import assert from "node:assert/strict";
import test from "node:test";
import {
	displaySafe,
	assertTerminalSafe,
	parsePlaceholderTemplate,
} from "./display-safe.js";
import {
	normalizeSource,
	extractBody,
} from "./catalog.js";

// --- displaySafe tests ---

test("displaySafe: returns string as-is when safe", () => {
	assert.equal(displaySafe("Hello world"), "Hello world");
});

test("displaySafe: converts Error to message", () => {
	const error = new Error("Something went wrong");
	assert.equal(displaySafe(error), "Something went wrong");
});

test("displaySafe: converts non-string to string", () => {
	assert.equal(displaySafe(123), "123");
	assert.equal(displaySafe(null), "null");
	assert.equal(displaySafe(undefined), "undefined");
});

// --- assertTerminalSafe tests ---

test("assertTerminalSafe: does not throw for safe input", () => {
	assert.doesNotThrow(() => assertTerminalSafe("Hello world"));
});

test("assertTerminalSafe: throws for unsafe input", () => {
	assert.throws(() => assertTerminalSafe("Line1\nLine2"), /must be a single line/);
});

// --- parsePlaceholderTemplate tests ---

test("parsePlaceholderTemplate: parses simple template", () => {
	const result = parsePlaceholderTemplate("Hello {{name}}");
	assert.equal(result.type, "template");
	assert.equal(result.parts.length, 2);
	assert.equal(result.parts[0].type, "literal");
	assert.equal(result.parts[0].value, "Hello ");
	assert.equal(result.parts[1].type, "placeholder");
	assert.equal(result.parts[1].name, "name");
});

test("parsePlaceholderTemplate: handles no placeholders", () => {
	const result = parsePlaceholderTemplate("Hello world");
	assert.equal(result.type, "literal");
	assert.equal(result.value, "Hello world");
});

test("parsePlaceholderTemplate: handles multiple placeholders", () => {
	const result = parsePlaceholderTemplate("{{first}} {{last}}");
	assert.equal(result.parts.length, 3);
	assert.equal(result.parts[0].name, "first");
	assert.equal(result.parts[2].name, "last");
});

// --- normalizeSource tests ---

test("normalizeSource: removes BOM", () => {
	const withBom = "\uFEFFHello world";
	assert.equal(normalizeSource(withBom), "Hello world");
});

test("normalizeSource: converts CRLF to LF", () => {
	assert.equal(normalizeSource("Line1\r\nLine2"), "Line1\nLine2");
});

test("normalizeSource: converts CR to LF", () => {
	assert.equal(normalizeSource("Line1\rLine2"), "Line1\nLine2");
});

test("normalizeSource: handles mixed line endings", () => {
	const mixed = "Line1\r\nLine2\rLine3\nLine4";
	assert.equal(normalizeSource(mixed), "Line1\nLine2\nLine3\nLine4");
});

// --- extractBody tests ---

test("extractBody: returns text without frontmatter", () => {
	assert.equal(extractBody("Hello world"), "Hello world");
});

test("extractBody: extracts body after frontmatter", () => {
	const input = "---\nname: test\n---\nBody text";
	assert.equal(extractBody(input), "Body text");
});

test("extractBody: handles empty frontmatter", () => {
	const input = "---\n---\nBody text";
	assert.equal(extractBody(input), "Body text");
});

test("extractBody: preserves blank lines in body", () => {
	const input = "---\n---\n\nBody with blank line\n";
	assert.equal(extractBody(input), "\nBody with blank line\n");
});
