import assert from "node:assert/strict";
import test from "node:test";
import {
	AUTO_NAME_SYSTEM_PROMPT,
	AUTO_NAME_SYSTEM_PROMPT_FORCE,
	SESSION_EMOJI,
	TITLE_COLORS,
	randomEmoji,
	randomTitleColor,
	fgHex,
	detectWorldContext,
	parseSessionName,
	formatSessionName,
	adoptExistingSessionName,
	buildTerminalTitle,
	buildAutoNameContext,
	reduceAutoNameContextText,
	cleanGeneratedName,
	parseGeneratedName,
	splitLeadingEmoji,
	extractText,
	parseBooleanEnv,
	parseTitleOrder,
	classifyHerdrLabel,
	MAX_AUTO_NAME_CHARS,
	parseEnumEnv,
	type TitleOrder,
} from "./helpers.ts";

// ─── randomEmoji / randomTitleColor / fgHex ───────────────────────────────

test("randomEmoji: returns an emoji from the pool", () => {
	const emoji = randomEmoji();
	assert.ok(SESSION_EMOJI.includes(emoji));
});

test("randomTitleColor: returns a color from the pool", () => {
	const color = randomTitleColor();
	assert.ok(TITLE_COLORS.includes(color));
});

test("fgHex: wraps text in 24-bit ANSI color codes", () => {
	const result = fgHex("#FF0000", "hello");
	assert.equal(result, "\x1b[38;2;255;0;0mhello\x1b[0m");
});

test("fgHex: parses mixed hex values", () => {
	const result = fgHex("#1A2B3C", "test");
	assert.equal(result, "\x1b[38;2;26;43;60mtest\x1b[0m");
});

// ─── detectWorldContext ───────────────────────────────────────────────────

test("detectWorldContext: returns null for non-world paths", () => {
	assert.deepEqual(detectWorldContext("/home/user/project"), {
		treeName: null,
		zone: null,
	});
});

test("detectWorldContext: detects tree name at src root", () => {
	assert.deepEqual(detectWorldContext("/Users/me/world/trees/root/src"), {
		treeName: "root",
		zone: null,
	});
});

test("detectWorldContext: detects tree name and zone", () => {
	assert.deepEqual(detectWorldContext("/Users/me/world/trees/t1/src/areas/core/myapp"), {
		treeName: "t1",
		zone: "areas/core/myapp",
	});
});

test("detectWorldContext: truncates zone to 3 segments", () => {
	assert.deepEqual(detectWorldContext("/Users/me/world/trees/root/src/a/b/c/d/e"), {
		treeName: "root",
		zone: "a/b/c",
	});
});

test("detectWorldContext: handles 1-segment zone", () => {
	assert.deepEqual(detectWorldContext("/Users/me/world/trees/t2/src/libraries"), {
		treeName: "t2",
		zone: "libraries",
	});
});

test("detectWorldContext: handles 2-segment zone", () => {
	assert.deepEqual(detectWorldContext("/Users/me/world/trees/t3/src/areas/tools"), {
		treeName: "t3",
		zone: "areas/tools",
	});
});

// ─── parseSessionName ─────────────────────────────────────────────────────

test("parseSessionName: returns empty for empty string", () => {
	const result = parseSessionName("");
	assert.equal(result.emoji, "");
	assert.equal(result.label, "");
	assert.equal(result.titleColor, "");
});

test("parseSessionName: parses emoji + label format", () => {
	const result = parseSessionName("🔮 fix checkout bug");
	assert.equal(result.emoji, "🔮");
	assert.equal(result.label, "fix checkout bug");
	assert.ok(TITLE_COLORS.includes(result.titleColor));
});

test("parseSessionName: handles plain name without emoji", () => {
	const result = parseSessionName("fix checkout bug");
	assert.ok(SESSION_EMOJI.includes(result.emoji));
	assert.equal(result.label, "fix checkout bug");
	assert.ok(TITLE_COLORS.includes(result.titleColor));
});

test("parseSessionName: parses variation selector emoji", () => {
	const result = parseSessionName("⚡ fast test");
	assert.equal(result.emoji, "⚡");
	assert.equal(result.label, "fast test");
});

test("parseSessionName: handles multi-codepoint emoji", () => {
	const result = parseSessionName("🛠️ refactor auth");
	assert.equal(result.emoji, "🛠️");
	assert.equal(result.label, "refactor auth");
});

test("parseSessionName: handles ZWJ-sequence emoji on restore", () => {
	const result = parseSessionName("\u{1F9D1}\u200D\u{1F4BB} pair on parser");
	assert.equal(result.emoji, "\u{1F9D1}\u200D\u{1F4BB}");
	assert.equal(result.label, "pair on parser");
});

// ─── formatSessionName ────────────────────────────────────────────────────

test("formatSessionName: joins emoji and label with a single space", () => {
	assert.equal(formatSessionName("🔮", "fix checkout bug"), "🔮 fix checkout bug");
});

// ─── adoptExistingSessionName ─────────────────────────────────────────────

test("adoptExistingSessionName: returns null for empty names", () => {
	assert.equal(adoptExistingSessionName(""), null);
	assert.equal(adoptExistingSessionName("   "), null);
});

test("adoptExistingSessionName: preserves an existing emoji-prefixed session name", () => {
	const result = adoptExistingSessionName("🔮 fix checkout bug")!;
	assert.equal(result.emoji, "🔮");
	assert.equal(result.label, "fix checkout bug");
	assert.equal(result.sessionName, "🔮 fix checkout bug");
	assert.ok(TITLE_COLORS.includes(result.titleColor));
});

test("adoptExistingSessionName: normalizes a plain existing name with a generated emoji", () => {
	const result = adoptExistingSessionName("  fix checkout bug  ")!;
	assert.ok(SESSION_EMOJI.includes(result.emoji));
	assert.equal(result.label, "fix checkout bug");
	assert.equal(result.sessionName, `${result.emoji} fix checkout bug`);
	assert.ok(TITLE_COLORS.includes(result.titleColor));
});

// ─── buildTerminalTitle ───────────────────────────────────────────────────

test("buildTerminalTitle: returns π alone when no context", () => {
	assert.equal(buildTerminalTitle(null, null, "", ""), "π");
});

test("buildTerminalTitle: includes tree name", () => {
	assert.equal(buildTerminalTitle("root", null, "", ""), "π root");
});

test("buildTerminalTitle: includes zone", () => {
	assert.equal(buildTerminalTitle("root", "areas/core", "", ""), "π root //areas/core");
});

test("buildTerminalTitle: includes label with emoji", () => {
	assert.equal(buildTerminalTitle("t1", "areas/core", "🔮", "fix bug"), "π t1 //areas/core — 🔮 fix bug");
});

test("buildTerminalTitle: skips label segment when label is empty", () => {
	assert.equal(buildTerminalTitle("root", "areas/tools", "🎯", ""), "π root //areas/tools");
});

test("buildTerminalTitle: label-first puts the label first and context at the end", () => {
	assert.equal(
		buildTerminalTitle("t1", "areas/core", "🔮", "fix bug", { order: "label-first" }),
		"π 🔮 fix bug — t1 //areas/core",
	);
});

test("buildTerminalTitle: label-first renders context alone when label is empty", () => {
	assert.equal(
		buildTerminalTitle("root", "areas/tools", "🎯", "", { order: "label-first" }),
		"π root //areas/tools",
	);
});

test("buildTerminalTitle: label-first renders label alone when there is no world context", () => {
	assert.equal(
		buildTerminalTitle(null, null, "🔮", "fix bug", { order: "label-first" }),
		"π 🔮 fix bug",
	);
});

test("buildTerminalTitle: label-first returns π alone when no context and no label", () => {
	assert.equal(buildTerminalTitle(null, null, "", "", { order: "label-first" }), "π");
});

test("buildTerminalTitle: renders the zone-first layout for a bogus order value", () => {
	const bogus = "sideways" as unknown as TitleOrder;
	assert.equal(buildTerminalTitle("t1", "areas/core", "🔮", "fix bug", { order: bogus }), "π t1 //areas/core — 🔮 fix bug");
	assert.equal(buildTerminalTitle("t1", "areas/core", "", "", { order: bogus }), "π t1 //areas/core");
	assert.equal(buildTerminalTitle(null, null, "🔮", "fix bug", { order: bogus }), "π — 🔮 fix bug");
});

// ─── parseTitleOrder / parseEnumEnv ───────────────────────────────────────

test("parseTitleOrder: defaults to zone-first when unset", () => {
	assert.equal(parseTitleOrder(undefined), "zone-first");
});

test("parseTitleOrder: recognizes label-first case-insensitively with whitespace", () => {
	assert.equal(parseTitleOrder("label-first"), "label-first");
	assert.equal(parseTitleOrder(" LABEL-FIRST "), "label-first");
});

test("parseTitleOrder: recognizes zone-first explicitly", () => {
	assert.equal(parseTitleOrder("zone-first"), "zone-first");
});

test("parseTitleOrder: falls back to zone-first on unrecognized values", () => {
	assert.equal(parseTitleOrder("labelfirst"), "zone-first");
	assert.equal(parseTitleOrder(""), "zone-first");
	assert.equal(parseTitleOrder("first"), "zone-first");
});

test("parseEnumEnv: falls back on undefined, empty, and whitespace-only values", () => {
	const COLORS = ["red", "green"] as const;
	assert.equal(parseEnumEnv(undefined, COLORS, "red"), "red");
	assert.equal(parseEnumEnv("", COLORS, "green"), "green");
	assert.equal(parseEnumEnv("   ", COLORS, "red"), "red");
});

test("parseEnumEnv: matches members case-insensitively with surrounding whitespace", () => {
	const COLORS = ["red", "green"] as const;
	assert.equal(parseEnumEnv(" GREEN ", COLORS, "red"), "green");
	assert.equal(parseEnumEnv("red", COLORS, "green"), "red");
});

test("parseEnumEnv: falls back on non-member values", () => {
	const COLORS = ["red", "green"] as const;
	assert.equal(parseEnumEnv("blue", COLORS, "red"), "red");
});

// ─── extractText ──────────────────────────────────────────────────────────

test("extractText: returns trimmed string when content is a string", () => {
	assert.equal(extractText("  hello world  "), "hello world");
});

test("extractText: returns empty string when content is null/non-array/non-string", () => {
	assert.equal(extractText(null), "");
	assert.equal(extractText(undefined), "");
	assert.equal(extractText({ foo: "bar" }), "");
	assert.equal(extractText(42), "");
});

test("extractText: joins text parts from a content-parts array", () => {
	const content = [
		{ type: "text", text: "first" },
		{ type: "image", source: "x" },
		{ type: "text", text: "second" },
	];
	assert.equal(extractText(content), "first\nsecond");
});

test("extractText: ignores parts that are not text-shaped", () => {
	assert.equal(extractText([null, "raw", { type: "text" }, { text: "orphan" }]), "");
});

// ─── reduceAutoNameContextText ────────────────────────────────────────────

test("reduceAutoNameContextText: reduces GitHub PR and issue links to their numeric identifiers", () => {
	assert.equal(
		reduceAutoNameContextText(
			"check https://github.com/example/world/pull/926696/files and https://github.com/example/issues-consumer-agent/issues/973.",
		),
		"check 926696 and 973",
	);
});

test("reduceAutoNameContextText: reduces github.com pull and issue links across supported path forms", () => {
	for (const url of [
		"https://github.com/example/storefront-components/pull/1532",
		"https://github.com/example/storefront-components/pull/1532/files",
		"https://github.com/example/storefront-components/pull/1532.diff",
	]) {
		assert.equal(reduceAutoNameContextText(`revisit ${url}`), "revisit 1532");
	}
	assert.equal(
		reduceAutoNameContextText("revisit https://github.com/example/storefront-components/issues/973"),
		"revisit 973",
	);
	assert.equal(
		reduceAutoNameContextText("https://github.com/example/storefront-components/PULL/1532"),
		"1532",
	);
});

test("reduceAutoNameContextText: preserves non-standard GitHub path shapes", () => {
	// The implementation only reduces the canonical /org/repo/(pull|issues)/N
	// shape on github.com; deeper or differently-shaped paths are preserved
	// rather than guessed at.
	for (const url of [
		"https://github.com/org/a/b/pull/1532",
		"https://github.com/org/repo/pr/1532",
		"https://github.com/org/repo/commit/abcdef",
	]) {
		assert.equal(reduceAutoNameContextText(`revisit ${url}`), `revisit ${url}`);
	}
});

test("reduceAutoNameContextText: reduces artifact links followed by sentence punctuation", () => {
	assert.equal(
		reduceAutoNameContextText(
			"review https://github.com/example/world/pull/926696: then fix https://github.com/example/world/issues/973!",
		),
		"review 926696 then fix 973",
	);
});

test("reduceAutoNameContextText: removes opaque Slack links and normalizes the surrounding whitespace", () => {
	assert.equal(
		reduceAutoNameContextText("before  https://slack.com/archives/C123/p456?thread_ts=456  after"),
		"before after",
	);
	for (const url of [
		"https://slack.com/archives/C123/p456",
		"https://slack.com/app_redirect?channel=C123&team=T123",
		"https://app.slack.com/client/T123/C123",
		"https://files.slack.com/files-pri/T123-F123/download/file.txt",
		"https://hooks.slack.com/services/T123/B123/secret",
	]) {
		assert.equal(reduceAutoNameContextText(url), "");
	}
	assert.equal(
		reduceAutoNameContextText(
			"(https://slack.com/app_redirect?channel=C123&team=T123), https://slack.com/archives/C123/p456;",
		),
		"",
	);
});

test("reduceAutoNameContextText: preserves Slack and other URLs whose paths carry useful topic context", () => {
	for (const url of [
		"https://example.com/docs/session-naming?mode=automatic",
		"https://api.slack.com/methods/conversations.history",
		"https://slack.com/api/conversations.history",
		"https://status.slack.com/",
	]) {
		assert.equal(reduceAutoNameContextText(`explain ${url}`), `explain ${url}`);
	}
});

test("reduceAutoNameContextText: preserves unrecognized and malformed URL shapes", () => {
	const commit = "https://github.com/example/world/commit/abcdef";
	const invalidPr = "https://github.com/github/pr/example/storefront-components/not-a-number";
	const malformed = "https://%";
	assert.equal(reduceAutoNameContextText(`${commit} ${invalidPr} ${malformed}`), `${commit} ${invalidPr} ${malformed}`);
});

// ─── buildAutoNameContext ─────────────────────────────────────────────────

function userMsg(text: string) {
	return { type: "message" as const, message: { role: "user" as const, content: text } };
}
function assistantMsg(text: string) {
	return { type: "message" as const, message: { role: "assistant" as const, content: text } };
}

test("buildAutoNameContext: returns empty string for an empty branch", () => {
	assert.equal(buildAutoNameContext([]), "");
});

test("buildAutoNameContext: skips entries without a message and entries with empty text", () => {
	const branch = [
		{ type: "compaction" },
		{ type: "message", message: { role: "user", content: "" } },
		{ type: "message" }, // missing message field after type-narrowing
		userMsg("hello"),
	];
	assert.equal(buildAutoNameContext(branch), "User: hello");
});

test("buildAutoNameContext: includes all user messages when there are 5 or fewer", () => {
	const branch = [userMsg("a"), userMsg("b"), userMsg("c")];
	assert.equal(buildAutoNameContext(branch), "User: a\n\nUser: b\n\nUser: c");
});

test("buildAutoNameContext: compresses to first 2 + elision + last 3 user messages when there are more than 5", () => {
	const branch = Array.from({ length: 8 }, (_, i) => userMsg(`m${i}`));
	const result = buildAutoNameContext(branch);
	assert.ok(result.includes("User: m0"));
	assert.ok(result.includes("User: m1"));
	assert.ok(result.includes("[... 3 more user messages ...]"));
	assert.ok(result.includes("User: m5"));
	assert.ok(result.includes("User: m6"));
	assert.ok(result.includes("User: m7"));
	assert.ok(!result.includes("User: m3"), "m2/m3/m4 are elided");
});

test("buildAutoNameContext: silently ignores messages with unknown roles", () => {
	const branch = [
		userMsg("hi"),
		{ type: "message" as const, message: { role: "system" as const, content: "system content" } },
		{ type: "message" as const, message: { role: "tool" as const, content: "tool output" } },
	];
	assert.equal(buildAutoNameContext(branch), "User: hi");
});

test("buildAutoNameContext: appends the most recent assistant reply, clipped to 1500 chars", () => {
	const long = "x".repeat(2000);
	const branch = [userMsg("hi"), assistantMsg("first"), userMsg("again"), assistantMsg(long)];
	const result = buildAutoNameContext(branch);
	assert.ok(result.includes("User: hi"));
	assert.ok(result.includes("User: again"));
	assert.ok(result.includes(`Assistant: ${"x".repeat(1500)}`));
	assert.ok(!result.includes("first"), "only the LAST assistant reply");
});

test("buildAutoNameContext: appends pendingUserMessage when the branch hasn't received it yet", () => {
	const branch = [userMsg("first prompt")];
	const result = buildAutoNameContext(branch, { pendingUserMessage: "  second prompt  " });
	assert.equal(result, "User: first prompt\n\nUser: second prompt");
});

test("buildAutoNameContext: reduces URLs in user, assistant, and pending context", () => {
	const branch = [
		userMsg("is this https://github.com/example/issues-consumer-agent/issues/973"),
		assistantMsg("compare https://github.com/example/storefront-components/pull/1491 https://slack.com/archives/C123/p456"),
	];
	const result = buildAutoNameContext(branch, {
		pendingUserMessage: "recheck https://github.com/example/storefront-components/pull/1532",
	});
	assert.equal(result, "User: is this 973\n\nUser: recheck 1532\n\nAssistant: compare 1491");
});

test("buildAutoNameContext: omits pendingUserMessage when its reduced text duplicates the last user text", () => {
	const url = "https://github.com/example/issues-consumer-agent/issues/973";
	const branch = [userMsg(`is this ${url}`)];
	const result = buildAutoNameContext(branch, { pendingUserMessage: `is this ${url}` });
	assert.equal(result, "User: is this 973");
});

test("buildAutoNameContext: uses pendingUserMessage as the only user text when the branch has none", () => {
	const result = buildAutoNameContext([], { pendingUserMessage: "first ever prompt" });
	assert.equal(result, "User: first ever prompt");
});

test("buildAutoNameContext: omits Slack-only pending context followed by wrapper punctuation", () => {
	const result = buildAutoNameContext([], {
		pendingUserMessage: "(https://slack.com/app_redirect?channel=C123&team=T123),",
	});
	assert.equal(result, "");
});

test("buildAutoNameContext: ignores empty/whitespace pendingUserMessage", () => {
	assert.equal(buildAutoNameContext([userMsg("hi")], { pendingUserMessage: "   " }), "User: hi");
	assert.equal(buildAutoNameContext([userMsg("hi")], { pendingUserMessage: undefined }), "User: hi");
	assert.equal(buildAutoNameContext([userMsg("hi")], {}), "User: hi");
});

// ─── cleanGeneratedName ───────────────────────────────────────────────────

test("cleanGeneratedName: returns null for empty input", () => {
	assert.equal(cleanGeneratedName(""), null);
	assert.equal(cleanGeneratedName("\n\n"), null);
});

test("cleanGeneratedName: returns null when stripping leaves nothing", () => {
	assert.equal(cleanGeneratedName("###  "), null);
});

test("cleanGeneratedName: takes the first non-empty line", () => {
	assert.equal(cleanGeneratedName("\n\nfix bug\nmore stuff"), "fix bug");
});

test("cleanGeneratedName: strips leading markdown headings", () => {
	assert.equal(cleanGeneratedName("## cool title"), "cool title");
});

test("cleanGeneratedName: strips surrounding quotes and backticks", () => {
	assert.equal(cleanGeneratedName('"foo bar"'), "foo bar");
	assert.equal(cleanGeneratedName("`code-ish`"), "code-ish");
});

test("cleanGeneratedName: strips trailing punctuation", () => {
	assert.equal(cleanGeneratedName("refactor things."), "refactor things");
	assert.equal(cleanGeneratedName("fix bug!?"), "fix bug");
});

test("cleanGeneratedName: applies transforms in a single pass (order-sensitive)", () => {
	// The quote/backtick stripper runs BEFORE the trailing-punct stripper, so when
	// a backtick is shielded by a trailing `!` it survives this pass. Documented
	// here so a future refactor doesn't accidentally change the output.
	assert.equal(cleanGeneratedName("## `noisy`!"), "noisy`");
});

test("cleanGeneratedName: truncates to MAX_AUTO_NAME_CHARS", () => {
	const input = "a".repeat(MAX_AUTO_NAME_CHARS + 10);
	assert.equal(cleanGeneratedName(input)!.length, MAX_AUTO_NAME_CHARS);
});

test("cleanGeneratedName: keeps names at exactly the limit", () => {
	const input = "a".repeat(MAX_AUTO_NAME_CHARS);
	assert.equal(cleanGeneratedName(input), input);
});

test("cleanGeneratedName: returns null for the SKIP sentinel", () => {
	assert.equal(cleanGeneratedName("SKIP"), null);
	assert.equal(cleanGeneratedName("skip"), null);
	assert.equal(cleanGeneratedName("  Skip  "), null);
	assert.equal(cleanGeneratedName("SKIP."), null); // trailing punctuation stripped first
});

test("cleanGeneratedName: does not treat SKIP-containing titles as the sentinel", () => {
	assert.equal(cleanGeneratedName("SKIPPING failed tests"), "SKIPPING failed tests");
	assert.equal(cleanGeneratedName("do not SKIP this"), "do not SKIP this");
});

// ─── splitLeadingEmoji ────────────────────────────────────────────────────

test("splitLeadingEmoji: splits a single leading emoji from the rest", () => {
	assert.deepEqual(splitLeadingEmoji("\u{1F41B} fix checkout bug"), { emoji: "\u{1F41B}", rest: "fix checkout bug" });
});

test("splitLeadingEmoji: handles variation-selector and ZWJ-sequence emoji", () => {
	assert.deepEqual(splitLeadingEmoji("\u{1F6E0}\uFE0F refactor auth"), { emoji: "\u{1F6E0}\uFE0F", rest: "refactor auth" });
	assert.deepEqual(splitLeadingEmoji("\u{1F9D1}\u200D\u{1F4BB} pair on parser"), {
		emoji: "\u{1F9D1}\u200D\u{1F4BB}",
		rest: "pair on parser",
	});
});

test("splitLeadingEmoji: returns an empty emoji when there is no leading emoji", () => {
	assert.deepEqual(splitLeadingEmoji("plain title here"), { emoji: "", rest: "plain title here" });
});

test("splitLeadingEmoji: does not treat a leading ASCII digit as an emoji", () => {
	assert.deepEqual(splitLeadingEmoji("3 retries left"), { emoji: "", rest: "3 retries left" });
});

test("splitLeadingEmoji: requires whitespace after the emoji (no false match on glued text)", () => {
	assert.deepEqual(splitLeadingEmoji("\u{1F41B}fix"), { emoji: "", rest: "\u{1F41B}fix" });
});

// ─── parseGeneratedName ───────────────────────────────────────────────────

test("parseGeneratedName: extracts the contextual emoji and label", () => {
	assert.deepEqual(parseGeneratedName("\u{1F41B} fix flaky pagination test"), {
		emoji: "\u{1F41B}",
		label: "fix flaky pagination test",
	});
});

test("parseGeneratedName: returns an empty emoji when the model omits it (caller falls back to random)", () => {
	assert.deepEqual(parseGeneratedName("fix flaky pagination test"), {
		emoji: "",
		label: "fix flaky pagination test",
	});
});

test("parseGeneratedName: cleans markdown/quotes before splitting the emoji", () => {
	assert.deepEqual(parseGeneratedName('"\u{1F50D} review PR 1001"'), { emoji: "\u{1F50D}", label: "review PR 1001" });
});

test("parseGeneratedName: returns null for SKIP and empty/markdown-only input", () => {
	assert.equal(parseGeneratedName("SKIP"), null);
	assert.equal(parseGeneratedName(""), null);
	assert.equal(parseGeneratedName("###"), null);
});

test("parseGeneratedName: returns null for a stray-prefixed sentinel like an emoji + SKIP", () => {
	assert.equal(parseGeneratedName("\u{1F914} SKIP"), null);
});

// ─── system prompts ───────────────────────────────────────────────────────

test("AUTO_NAME_SYSTEM_PROMPT: includes the SKIP rule and compact content-free examples", () => {
	assert.ok(AUTO_NAME_SYSTEM_PROMPT.includes("SKIP rule"));
	assert.ok(AUTO_NAME_SYSTEM_PROMPT.includes('Examples that should SKIP: "hi", "hello", "?", "help", "test", "thanks"'));
});

test("AUTO_NAME_SYSTEM_PROMPT: instructs the model to prefix a single contextual emoji", () => {
	assert.ok(AUTO_NAME_SYSTEM_PROMPT.includes("a single emoji that best captures the session"));
});

test("AUTO_NAME_SYSTEM_PROMPT: omits title examples and artifact-specific naming instructions", () => {
	assert.ok(!/\breview\b/i.test(AUTO_NAME_SYSTEM_PROMPT));
	assert.ok(!AUTO_NAME_SYSTEM_PROMPT.includes("Examples of valid outputs"));
	assert.ok(!AUTO_NAME_SYSTEM_PROMPT.includes("Include PR or issue numbers"));
	assert.ok(!AUTO_NAME_SYSTEM_PROMPT.includes("Lead with the verb"));
	assert.ok(!AUTO_NAME_SYSTEM_PROMPT.includes("Mention the repo / component / file / feature when it's clear"));
});

test("AUTO_NAME_SYSTEM_PROMPT_FORCE: strips the SKIP rule and tells the model to always emit a title", () => {
	assert.ok(!AUTO_NAME_SYSTEM_PROMPT_FORCE.includes("SKIP rule"));
	assert.ok(!AUTO_NAME_SYSTEM_PROMPT_FORCE.includes('respond with SKIP"'));
	assert.ok(AUTO_NAME_SYSTEM_PROMPT_FORCE.includes("Always emit a title"));
	assert.ok(AUTO_NAME_SYSTEM_PROMPT_FORCE.includes("Do not respond with SKIP"));
});

test("AUTO_NAME_SYSTEM_PROMPT_FORCE: does not end with the SKIP example line", () => {
	assert.ok(!AUTO_NAME_SYSTEM_PROMPT_FORCE.trimEnd().endsWith("SKIP"));
});

test("AUTO_NAME_SYSTEM_PROMPT_FORCE: instructs the model to prefix a single contextual emoji", () => {
	assert.ok(AUTO_NAME_SYSTEM_PROMPT_FORCE.includes("a single emoji that best captures the session"));
});

test("AUTO_NAME_SYSTEM_PROMPT_FORCE: omits title examples and artifact-specific naming instructions", () => {
	assert.ok(!/\breview\b/i.test(AUTO_NAME_SYSTEM_PROMPT_FORCE));
	assert.ok(!AUTO_NAME_SYSTEM_PROMPT_FORCE.includes("Examples of valid outputs"));
	assert.ok(!AUTO_NAME_SYSTEM_PROMPT_FORCE.includes("Include PR or issue numbers"));
	assert.ok(!AUTO_NAME_SYSTEM_PROMPT_FORCE.includes("Lead with the verb"));
	assert.ok(!AUTO_NAME_SYSTEM_PROMPT_FORCE.includes("Mention the repo / component / file / feature when it's clear"));
});

// ─── classifyHerdrLabel ───────────────────────────────────────────────────

test("classifyHerdrLabel: writes when the current label is missing or unreadable", () => {
	assert.equal(classifyHerdrLabel(null, "🔮 auto title", null), "write");
	assert.equal(classifyHerdrLabel(undefined, "🔮 auto title", "🔮 previous title"), "write");
	assert.equal(classifyHerdrLabel("", "🔮 auto title", null), "write");
});

test("classifyHerdrLabel: writes for numeric Herdr fallback labels, including an empty incoming title", () => {
	assert.equal(classifyHerdrLabel("1", "🔮 auto title", null), "write");
	assert.equal(classifyHerdrLabel("42", "", null), "write");
});

test("classifyHerdrLabel: writes when the current label already equals the incoming title", () => {
	assert.equal(classifyHerdrLabel("🔮 auto title", "🔮 auto title", null), "write");
	assert.equal(classifyHerdrLabel("", "", null), "write");
});

test("classifyHerdrLabel: writes when the current label equals the last title session-banner wrote", () => {
	assert.equal(classifyHerdrLabel("🔮 previous title", "⚡ next title", "🔮 previous title"), "write");
});

test("classifyHerdrLabel: writes when the current label equals persisted ownership for this Herdr tab", () => {
	assert.equal(classifyHerdrLabel("🔮 persisted title", "⚡ next title", null, "🔮 persisted title"), "write");
});

test("classifyHerdrLabel: backs off for non-owned GUI labels, including emoji labels", () => {
	assert.equal(classifyHerdrLabel("User picked this", "🔮 auto title", null), "back_off");
	assert.equal(classifyHerdrLabel("🔄 Tab Rename Behavior Issue", "🔮 auto title", "🔮 previous title"), "back_off");
});

// ─── parseBooleanEnv ──────────────────────────────────────────────────────

test("parseBooleanEnv: returns the fallback for undefined, empty, or whitespace-only values", () => {
	assert.equal(parseBooleanEnv(undefined, true), true);
	assert.equal(parseBooleanEnv(undefined, false), false);
	assert.equal(parseBooleanEnv("", true), true);
	assert.equal(parseBooleanEnv("   ", false), false);
});

test("parseBooleanEnv: parses truthy values case-insensitively", () => {
	for (const v of ["1", "true", "on", "yes", " TRUE ", "On", "YES"]) {
		assert.equal(parseBooleanEnv(v, false), true);
	}
});

test("parseBooleanEnv: parses falsy values case-insensitively", () => {
	for (const v of ["0", "false", "off", "no", " OFF ", "False", "No"]) {
		assert.equal(parseBooleanEnv(v, true), false);
	}
});

test("parseBooleanEnv: returns the fallback for unrecognized values rather than guessing", () => {
	assert.equal(parseBooleanEnv("maybe", true), true);
	assert.equal(parseBooleanEnv("2", false), false);
});
