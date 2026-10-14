import assert from "node:assert/strict";
import test from "node:test";
import { displaySafe } from "./display-safe.ts";
import {
	assertTerminalSafe,
	parsePlaceholderTemplate,
	PlaceholderError,
} from "./placeholders.ts";
import { normalizedSource, extractBody } from "./catalog.ts";

// --- displaySafe tests ---

test("displaySafe: returns plain text unchanged", () => {
	assert.equal(displaySafe("Hello world"), "Hello world");
});

test("displaySafe: escapes named whitespace controls", () => {
	assert.equal(displaySafe("a\tb\nc\rd"), "a\\tb\\nc\\rd");
});

test("displaySafe: escapes other C0, DEL, and C1 controls as \\uXXXX", () => {
	assert.equal(displaySafe("a\u0007b"), "a\\u0007b");
	assert.equal(displaySafe("a\u007fb"), "a\\u007Fb");
	assert.equal(displaySafe("a\u009bb"), "a\\u009Bb");
});

// --- assertTerminalSafe tests ---

test("assertTerminalSafe: does not throw for safe input", () => {
	assert.doesNotThrow(() => assertTerminalSafe("Hello world", "snippet"));
});

test("assertTerminalSafe: allows newlines, tabs, and carriage returns", () => {
	assert.doesNotThrow(() => assertTerminalSafe("Line1\nLine2\tTabbed\rCRLF", "snippet"));
});

test("assertTerminalSafe: throws PlaceholderError naming label, codepoint, and offset", () => {
	assert.throws(
		() => assertTerminalSafe("a\u0007b", "snippet body"),
		(error) =>
			error instanceof PlaceholderError &&
			error.code === "unsafe-control" &&
			error.offset === 1 &&
			error.message.includes("snippet body") &&
			error.message.includes("U+0007") &&
			error.message.includes("offset 1"),
	);
});

// --- parsePlaceholderTemplate tests ---

test("parsePlaceholderTemplate: parses simple template", () => {
	const template = parsePlaceholderTemplate("Hello {{name}}");
	assert.deepEqual(template.fields, [{ name: "name", initialValue: "" }]);
	assert.equal(template.render(), "Hello ");
	assert.equal(template.render(new Map([["name", "World"]])), "Hello World");
});

test("parsePlaceholderTemplate: handles no placeholders", () => {
	const template = parsePlaceholderTemplate("Hello world");
	assert.deepEqual(template.fields, []);
	assert.equal(template.render(), "Hello world");
});

test("parsePlaceholderTemplate: handles multiple placeholders", () => {
	const template = parsePlaceholderTemplate("{{first}} {{last}}");
	assert.deepEqual(
		template.fields.map((field) => field.name),
		["first", "last"],
	);
	assert.equal(template.render(new Map([["first", "Ada"], ["last", "Lovelace"]])), "Ada Lovelace");
});

test("parsePlaceholderTemplate: supports explicit defaults via {{name:default}}", () => {
	const template = parsePlaceholderTemplate("Hi {{name:fallback}}");
	assert.deepEqual(template.fields, [{ name: "name", initialValue: "fallback" }]);
	assert.equal(template.render(), "Hi fallback");
	assert.equal(template.render(new Map([["name", "Ada"]])), "Hi Ada");
});

test("parsePlaceholderTemplate: a present empty value wins over the default", () => {
	const template = parsePlaceholderTemplate("{{name:fallback}}");
	assert.equal(template.render(new Map([["name", ""]])), "");
});

test("parsePlaceholderTemplate: repeated name without new default keeps the first default", () => {
	const template = parsePlaceholderTemplate("{{a:x}} mid {{a}}");
	assert.deepEqual(template.fields, [{ name: "a", initialValue: "x" }]);
	assert.equal(template.render(), "x mid x");
});

test("parsePlaceholderTemplate: throws on conflicting defaults", () => {
	assert.throws(
		() => parsePlaceholderTemplate("{{a:x}} {{a:y}}"),
		(error) => error instanceof PlaceholderError && error.code === "conflicting-default",
	);
});

test("parsePlaceholderTemplate: escapes \\{{ as literal text", () => {
	const template = parsePlaceholderTemplate("literal \\{{name}} here");
	assert.deepEqual(template.fields, []);
	assert.equal(template.render(), "literal {{name}} here");
});

test("parsePlaceholderTemplate: throws on unterminated placeholder", () => {
	assert.throws(
		() => parsePlaceholderTemplate("{{name"),
		(error) => error instanceof PlaceholderError && error.code === "unterminated-placeholder",
	);
});

test("parsePlaceholderTemplate: throws on nested placeholder syntax", () => {
	assert.throws(
		() => parsePlaceholderTemplate("{{a{{b}}}}"),
		(error) => error instanceof PlaceholderError && error.code === "nested-placeholder",
	);
});

test("parsePlaceholderTemplate: throws on invalid placeholder names", () => {
	assert.throws(
		() => parsePlaceholderTemplate("{{1abc}}"),
		(error) => error instanceof PlaceholderError && error.code === "invalid-name",
	);
});

test("parsePlaceholderTemplate: render rejects non-string values", () => {
	const template = parsePlaceholderTemplate("{{name}}");
	assert.throws(
		() => template.render(new Map<string, unknown>([["name", 123]]) as ReadonlyMap<string, string>),
		(error) => error instanceof PlaceholderError && error.code === "invalid-value",
	);
});

test("parsePlaceholderTemplate: render rejects values with terminal controls", () => {
	const template = parsePlaceholderTemplate("{{name}}");
	assert.throws(
		() => template.render(new Map([["name", "bad\u0007value"]])),
		(error) => error instanceof PlaceholderError && error.code === "unsafe-control",
	);
});

test("parsePlaceholderTemplate: __proto__ is an ordinary field name", () => {
	const template = parsePlaceholderTemplate("{{__proto__}}");
	assert.deepEqual(template.fields, [{ name: "__proto__", initialValue: "" }]);
	assert.equal(template.render(new Map([["__proto__", "ok"]])), "ok");
});

// --- normalizedSource tests ---

test("normalizedSource: removes BOM", () => {
	const withBom = "\uFEFFHello world";
	assert.equal(normalizedSource(withBom), "Hello world");
});

test("normalizedSource: converts CRLF to LF", () => {
	assert.equal(normalizedSource("Line1\r\nLine2"), "Line1\nLine2");
});

test("normalizedSource: converts CR to LF", () => {
	assert.equal(normalizedSource("Line1\rLine2"), "Line1\nLine2");
});

test("normalizedSource: handles mixed line endings", () => {
	const mixed = "Line1\r\nLine2\rLine3\nLine4";
	assert.equal(normalizedSource(mixed), "Line1\nLine2\nLine3\nLine4");
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

test("extractBody: throws when the frontmatter is never closed", () => {
	assert.throws(
		() => extractBody("---\nname: test\nNo closing delimiter"),
		/missing a closing ---/,
	);
});

test("extractBody: rejects a closing delimiter that is not exactly ---", () => {
	assert.throws(
		() => extractBody("---\nname: test\n----\nBody"),
		/closing delimiter must be a line containing only ---/,
	);
});
