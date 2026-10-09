import { describe, it, expect } from "vitest";
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
} from "./helpers";

// ─── randomEmoji ────────────────────────────────────────────────────────────

describe("randomEmoji", () => {
	it("returns an emoji from the pool", () => {
		const emoji = randomEmoji();
		expect(SESSION_EMOJI).toContain(emoji);
	});
});

// ─── randomTitleColor ───────────────────────────────────────────────────────

describe("randomTitleColor", () => {
	it("returns a color from the pool", () => {
		const color = randomTitleColor();
		expect(TITLE_COLORS).toContain(color);
	});
});

// ─── fgHex ──────────────────────────────────────────────────────────────────

describe("fgHex", () => {
	it("wraps text in 24-bit ANSI color codes", () => {
		const result = fgHex("#FF0000", "hello");
		expect(result).toBe("\x1b[38;2;255;0;0mhello\x1b[0m");
	});

	it("parses mixed hex values", () => {
		const result = fgHex("#1A2B3C", "test");
		expect(result).toBe("\x1b[38;2;26;43;60mtest\x1b[0m");
	});
});

// ─── detectWorldContext ─────────────────────────────────────────────────────

describe("detectWorldContext", () => {
	it("returns null for non-world paths", () => {
		expect(detectWorldContext("/home/user/project")).toEqual({
			treeName: null,
			zone: null,
		});
	});

	it("detects tree name at src root", () => {
		expect(detectWorldContext("/Users/me/world/trees/root/src")).toEqual({
			treeName: "root",
			zone: null,
		});
	});

	it("detects tree name and zone", () => {
		expect(detectWorldContext("/Users/me/world/trees/t1/src/areas/core/myapp")).toEqual({
			treeName: "t1",
			zone: "areas/core/myapp",
		});
	});

	it("truncates zone to 3 segments", () => {
		expect(detectWorldContext("/Users/me/world/trees/root/src/a/b/c/d/e")).toEqual({
			treeName: "root",
			zone: "a/b/c",
		});
	});

	it("handles 1-segment zone", () => {
		expect(detectWorldContext("/Users/me/world/trees/t2/src/libraries")).toEqual({
			treeName: "t2",
			zone: "libraries",
		});
	});

	it("handles 2-segment zone", () => {
		expect(detectWorldContext("/Users/me/world/trees/t3/src/areas/tools")).toEqual({
			treeName: "t3",
			zone: "areas/tools",
		});
	});
});

// ─── parseSessionName ───────────────────────────────────────────────────────

describe("parseSessionName", () => {
	it("returns empty for empty string", () => {
		const result = parseSessionName("");
		expect(result.emoji).toBe("");
		expect(result.label).toBe("");
		expect(result.titleColor).toBe("");
	});

	it("parses emoji + label format", () => {
		const result = parseSessionName("🔮 fix checkout bug");
		expect(result.emoji).toBe("🔮");
		expect(result.label).toBe("fix checkout bug");
		expect(TITLE_COLORS).toContain(result.titleColor);
	});

	it("handles plain name without emoji", () => {
		const result = parseSessionName("fix checkout bug");
		expect(SESSION_EMOJI).toContain(result.emoji);
		expect(result.label).toBe("fix checkout bug");
		expect(TITLE_COLORS).toContain(result.titleColor);
	});

	it("parses variation selector emoji", () => {
		const result = parseSessionName("⚡ fast test");
		expect(result.emoji).toBe("⚡");
		expect(result.label).toBe("fast test");
	});

	it("handles multi-codepoint emoji", () => {
		const result = parseSessionName("🛠️ refactor auth");
		expect(result.emoji).toBe("🛠️");
		expect(result.label).toBe("refactor auth");
	});

	it("handles ZWJ-sequence emoji on restore", () => {
		const result = parseSessionName("\u{1F9D1}\u200D\u{1F4BB} pair on parser");
		expect(result.emoji).toBe("\u{1F9D1}\u200D\u{1F4BB}");
		expect(result.label).toBe("pair on parser");
	});
});

// ─── formatSessionName ──────────────────────────────────────────────────────

describe("formatSessionName", () => {
	it("joins emoji and label with a single space", () => {
		expect(formatSessionName("🔮", "fix checkout bug")).toBe("🔮 fix checkout bug");
	});
});

// ─── adoptExistingSessionName ───────────────────────────────────────────────

describe("adoptExistingSessionName", () => {
	it("returns null for empty names", () => {
		expect(adoptExistingSessionName("")).toBeNull();
		expect(adoptExistingSessionName("   ")).toBeNull();
	});

	it("preserves an existing emoji-prefixed session name", () => {
		const result = adoptExistingSessionName("🔮 fix checkout bug");
		expect(result!.emoji).toBe("🔮");
		expect(result!.label).toBe("fix checkout bug");
		expect(result!.sessionName).toBe("🔮 fix checkout bug");
		expect(TITLE_COLORS).toContain(result!.titleColor);
	});

	it("normalizes a plain existing name with a generated emoji", () => {
		const result = adoptExistingSessionName("  fix checkout bug  ");
		expect(SESSION_EMOJI).toContain(result!.emoji);
		expect(result!.label).toBe("fix checkout bug");
		expect(result!.sessionName).toBe(`${result!.emoji} fix checkout bug`);
		expect(TITLE_COLORS).toContain(result!.titleColor);
	});
});

// ─── buildTerminalTitle ─────────────────────────────────────────────────────

describe("buildTerminalTitle", () => {
	it("returns π alone when no context", () => {
		expect(buildTerminalTitle(null, null, "", "")).toBe("π");
	});

	it("includes tree name", () => {
		expect(buildTerminalTitle("root", null, "", "")).toBe("π root");
	});

	it("includes zone", () => {
		expect(buildTerminalTitle("root", "areas/core", "", "")).toBe("π root //areas/core");
	});

	it("includes label with emoji", () => {
		expect(buildTerminalTitle("t1", "areas/core", "🔮", "fix bug")).toBe(
			"π t1 //areas/core — 🔮 fix bug",
		);
	});

	it("skips label segment when label is empty", () => {
		expect(buildTerminalTitle("root", "areas/tools", "🎯", "")).toBe("π root //areas/tools");
	});

	describe("label-first order", () => {
		it("puts the label first and tree/zone context at the end", () => {
			expect(buildTerminalTitle("t1", "areas/core", "🔮", "fix bug", { order: "label-first" })).toBe(
				"π 🔮 fix bug — t1 //areas/core",
			);
		});

		it("renders context alone when label is empty", () => {
			expect(buildTerminalTitle("root", "areas/tools", "🎯", "", { order: "label-first" })).toBe(
				"π root //areas/tools",
			);
		});

		it("renders label alone when there is no world context", () => {
			expect(buildTerminalTitle(null, null, "🔮", "fix bug", { order: "label-first" })).toBe("π 🔮 fix bug");
		});

		it("returns π alone when no context and no label", () => {
			expect(buildTerminalTitle(null, null, "", "", { order: "label-first" })).toBe("π");
		});
	});
});

// ─── parseTitleOrder ───────────────────────────────────────────────────────────

describe("parseTitleOrder", () => {
	it("defaults to zone-first when unset", () => {
		expect(parseTitleOrder(undefined)).toBe("zone-first");
	});

	it("recognizes label-first case-insensitively with whitespace", () => {
		expect(parseTitleOrder("label-first")).toBe("label-first");
		expect(parseTitleOrder(" LABEL-FIRST ")).toBe("label-first");
	});

	it("recognizes zone-first explicitly", () => {
		expect(parseTitleOrder("zone-first")).toBe("zone-first");
	});

	it("falls back to zone-first on unrecognized values", () => {
		expect(parseTitleOrder("labelfirst")).toBe("zone-first");
		expect(parseTitleOrder("")).toBe("zone-first");
		expect(parseTitleOrder("first")).toBe("zone-first");
	});
});

describe("parseEnumEnv", () => {
	const COLORS = ["red", "green"] as const;

	it("falls back on undefined, empty, and whitespace-only values", () => {
		expect(parseEnumEnv(undefined, COLORS, "red")).toBe("red");
		expect(parseEnumEnv("", COLORS, "green")).toBe("green");
		expect(parseEnumEnv("   ", COLORS, "red")).toBe("red");
	});

	it("matches members case-insensitively with surrounding whitespace", () => {
		expect(parseEnumEnv(" GREEN ", COLORS, "red")).toBe("green");
		expect(parseEnumEnv("red", COLORS, "green")).toBe("red");
	});

	it("falls back on non-member values", () => {
		expect(parseEnumEnv("blue", COLORS, "red")).toBe("red");
	});
});

describe("buildTerminalTitle defensive default", () => {
	it("renders the zone-first layout for an order value that bypassed parseTitleOrder", () => {
		const bogus = "sideways" as unknown as TitleOrder;
		expect(buildTerminalTitle("t1", "areas/core", "🔮", "fix bug", { order: bogus })).toBe(
			"π t1 //areas/core — 🔮 fix bug",
		);
		expect(buildTerminalTitle("t1", "areas/core", "", "", { order: bogus })).toBe("π t1 //areas/core");
		expect(buildTerminalTitle(null, null, "🔮", "fix bug", { order: bogus })).toBe("π — 🔮 fix bug");
	});
});

// ─── extractText ────────────────────────────────────────────────────────────

describe("extractText", () => {
	it("returns trimmed string when content is a string", () => {
		expect(extractText("  hello world  ")).toBe("hello world");
	});

	it("returns empty string when content is null/non-array/non-string", () => {
		expect(extractText(null)).toBe("");
		expect(extractText(undefined)).toBe("");
		expect(extractText({ foo: "bar" })).toBe("");
		expect(extractText(42)).toBe("");
	});

	it("joins text parts from a content-parts array", () => {
		const content = [
			{ type: "text", text: "first" },
			{ type: "image", source: "x" },
			{ type: "text", text: "second" },
		];
		expect(extractText(content)).toBe("first\nsecond");
	});

	it("ignores parts that are not text-shaped", () => {
		expect(extractText([null, "raw", { type: "text" }, { text: "orphan" }])).toBe("");
	});
});

// ─── reduceAutoNameContextText ──────────────────────────────────────────────

describe("reduceAutoNameContextText", () => {
	it("reduces GitHub PR and issue links to their numeric identifiers", () => {
		expect(
			reduceAutoNameContextText(
				"check https://github.com/example/world/pull/926696/files and https://github.com/example/issues-consumer-agent/issues/973.",
			),
		).toBe("check 926696 and 973");
	});

	it("reduces both GitHub hosts and PR link forms to their numeric identifiers", () => {
		for (const url of [
			"https://github.com/github/pr/example/storefront-components/1532?pnid=abc",
			"https://github.com/github/example/storefront-components/pull/1532",
			"https://github.com/github/pr/example/storefront-components/1532",
			"https://github.com/github/example/storefront-components/pull/1532",
		]) {
			expect(reduceAutoNameContextText(`revisit ${url}`)).toBe("revisit 1532");
		}
	});

	it("reduces artifact links followed by sentence punctuation", () => {
		expect(
			reduceAutoNameContextText(
				"review https://github.com/example/world/pull/926696: then fix https://github.com/example/world/issues/973!",
			),
		).toBe("review 926696 then fix 973");
	});

	it("removes opaque Slack links and normalizes the surrounding whitespace", () => {
		expect(
			reduceAutoNameContextText(
				"before  https://slack.com/archives/C123/p456?thread_ts=456  after",
			),
		).toBe("before after");
		for (const url of [
			"https://slack.com/archives/C123/p456",
			"https://slack.com/app_redirect?channel=C123&team=T123",
			"https://app.slack.com/client/T123/C123",
			"https://files.slack.com/files-pri/T123-F123/download/file.txt",
			"https://hooks.slack.com/services/T123/B123/secret",
		]) {
			expect(reduceAutoNameContextText(url)).toBe("");
		}
		expect(
			reduceAutoNameContextText(
				"(https://slack.com/app_redirect?channel=C123&team=T123), https://slack.com/archives/C123/p456;",
			),
		).toBe("");
	});

	it("preserves Slack and other URLs whose paths carry useful topic context", () => {
		for (const url of [
			"https://example.com/docs/session-naming?mode=automatic",
			"https://api.slack.com/methods/conversations.history",
			"https://slack.com/api/conversations.history",
			"https://status.slack.com/",
		]) {
			expect(reduceAutoNameContextText(`explain ${url}`)).toBe(`explain ${url}`);
		}
	});

	it("preserves unrecognized and malformed URL shapes", () => {
		const commit = "https://github.com/example/world/commit/abcdef";
		const invalidPr = "https://github.com/github/pr/example/storefront-components/not-a-number";
		const malformed = "https://%";
		expect(reduceAutoNameContextText(`${commit} ${invalidPr} ${malformed}`)).toBe(
			`${commit} ${invalidPr} ${malformed}`,
		);
	});
});

// ─── buildAutoNameContext ───────────────────────────────────────────────────

function userMsg(text: string) {
	return { type: "message" as const, message: { role: "user" as const, content: text } };
}
function assistantMsg(text: string) {
	return { type: "message" as const, message: { role: "assistant" as const, content: text } };
}

describe("buildAutoNameContext", () => {
	it("returns empty string for an empty branch", () => {
		expect(buildAutoNameContext([])).toBe("");
	});

	it("skips entries without a message and entries with empty text", () => {
		const branch = [
			{ type: "compaction" },
			{ type: "message", message: { role: "user", content: "" } },
			{ type: "message" }, // missing message field after type-narrowing
			userMsg("hello"),
		];
		expect(buildAutoNameContext(branch as any)).toBe("User: hello");
	});

	it("includes all user messages when there are 5 or fewer", () => {
		const branch = [userMsg("a"), userMsg("b"), userMsg("c")];
		expect(buildAutoNameContext(branch)).toBe("User: a\n\nUser: b\n\nUser: c");
	});

	it("compresses to first 2 + elision + last 3 user messages when there are more than 5", () => {
		const branch = Array.from({ length: 8 }, (_, i) => userMsg(`m${i}`));
		const result = buildAutoNameContext(branch);
		expect(result).toContain("User: m0");
		expect(result).toContain("User: m1");
		expect(result).toContain("[... 3 more user messages ...]");
		expect(result).toContain("User: m5");
		expect(result).toContain("User: m6");
		expect(result).toContain("User: m7");
		// m2/m3/m4 are elided
		expect(result).not.toContain("User: m3");
	});

	it("silently ignores messages with unknown roles", () => {
		const branch = [
			userMsg("hi"),
			{ type: "message" as const, message: { role: "system" as const, content: "system content" } },
			{ type: "message" as const, message: { role: "tool" as const, content: "tool output" } },
		];
		expect(buildAutoNameContext(branch as any)).toBe("User: hi");
	});

	it("appends the most recent assistant reply, clipped to 1500 chars", () => {
		const long = "x".repeat(2000);
		const branch = [userMsg("hi"), assistantMsg("first"), userMsg("again"), assistantMsg(long)];
		const result = buildAutoNameContext(branch);
		expect(result).toContain("User: hi");
		expect(result).toContain("User: again");
		expect(result).toContain(`Assistant: ${"x".repeat(1500)}`);
		expect(result).not.toContain("first"); // only the LAST assistant reply
	});

	it("appends pendingUserMessage when the branch hasn't received it yet", () => {
		const branch = [userMsg("first prompt")];
		const result = buildAutoNameContext(branch, { pendingUserMessage: "  second prompt  " });
		expect(result).toBe("User: first prompt\n\nUser: second prompt");
	});

	it("reduces URLs in user, assistant, and pending context", () => {
		const branch = [
			userMsg("is this https://github.com/example/issues-consumer-agent/issues/973"),
			assistantMsg("compare https://github.com/example/storefront-components/pull/1491 https://slack.com/archives/C123/p456"),
		];
		const result = buildAutoNameContext(branch, {
			pendingUserMessage: "recheck https://github.com/github/pr/example/storefront-components/1532",
		});
		expect(result).toBe("User: is this 973\n\nUser: recheck 1532\n\nAssistant: compare 1491");
	});

	it("omits pendingUserMessage when its reduced text duplicates the last user text", () => {
		const url = "https://github.com/example/issues-consumer-agent/issues/973";
		const branch = [userMsg(`is this ${url}`)];
		const result = buildAutoNameContext(branch, { pendingUserMessage: `is this ${url}` });
		expect(result).toBe("User: is this 973");
	});

	it("uses pendingUserMessage as the only user text when the branch has none", () => {
		const result = buildAutoNameContext([], { pendingUserMessage: "first ever prompt" });
		expect(result).toBe("User: first ever prompt");
	});

	it("omits Slack-only pending context followed by wrapper punctuation", () => {
		const result = buildAutoNameContext([], {
			pendingUserMessage: "(https://slack.com/app_redirect?channel=C123&team=T123),",
		});
		expect(result).toBe("");
	});

	it("ignores empty/whitespace pendingUserMessage", () => {
		expect(buildAutoNameContext([userMsg("hi")], { pendingUserMessage: "   " })).toBe("User: hi");
		expect(buildAutoNameContext([userMsg("hi")], { pendingUserMessage: undefined })).toBe("User: hi");
		expect(buildAutoNameContext([userMsg("hi")], {})).toBe("User: hi");
	});
});

// ─── cleanGeneratedName ─────────────────────────────────────────────────────

describe("cleanGeneratedName", () => {
	it("returns null for empty input", () => {
		expect(cleanGeneratedName("")).toBeNull();
		expect(cleanGeneratedName("\n\n")).toBeNull();
	});

	it("returns null when stripping leaves nothing", () => {
		expect(cleanGeneratedName("###  ")).toBeNull();
	});

	it("takes the first non-empty line", () => {
		expect(cleanGeneratedName("\n\nfix bug\nmore stuff")).toBe("fix bug");
	});

	it("strips leading markdown headings", () => {
		expect(cleanGeneratedName("## cool title")).toBe("cool title");
	});

	it("strips surrounding quotes and backticks", () => {
		expect(cleanGeneratedName('"foo bar"')).toBe("foo bar");
		expect(cleanGeneratedName("`code-ish`")).toBe("code-ish");
	});

	it("strips trailing punctuation", () => {
		expect(cleanGeneratedName("refactor things.")).toBe("refactor things");
		expect(cleanGeneratedName("fix bug!?")).toBe("fix bug");
	});

	it("applies transforms in a single pass (order-sensitive)", () => {
		// The quote/backtick stripper runs BEFORE the trailing-punct stripper, so when
		// a backtick is shielded by a trailing `!` it survives this pass. Documented
		// here so a future refactor doesn't accidentally change the output.
		expect(cleanGeneratedName("## `noisy`!")).toBe("noisy`");
	});

	it("truncates to MAX_AUTO_NAME_CHARS", () => {
		const input = "a".repeat(MAX_AUTO_NAME_CHARS + 10);
		const out = cleanGeneratedName(input);
		expect(out).toHaveLength(MAX_AUTO_NAME_CHARS);
	});

	it("keeps names at exactly the limit", () => {
		const input = "a".repeat(MAX_AUTO_NAME_CHARS);
		expect(cleanGeneratedName(input)).toBe(input);
	});

	it("returns null for the SKIP sentinel", () => {
		expect(cleanGeneratedName("SKIP")).toBeNull();
		expect(cleanGeneratedName("skip")).toBeNull();
		expect(cleanGeneratedName("  Skip  ")).toBeNull();
		expect(cleanGeneratedName("SKIP.")).toBeNull(); // trailing punctuation stripped first
	});

	it("does not treat SKIP-containing titles as the sentinel", () => {
		expect(cleanGeneratedName("SKIPPING failed tests")).toBe("SKIPPING failed tests");
		expect(cleanGeneratedName("do not SKIP this")).toBe("do not SKIP this");
	});
});

// ─── splitLeadingEmoji ────────────────────────────────────────────

describe("splitLeadingEmoji", () => {
	it("splits a single leading emoji from the rest", () => {
		expect(splitLeadingEmoji("\u{1F41B} fix checkout bug")).toEqual({ emoji: "\u{1F41B}", rest: "fix checkout bug" });
	});

	it("handles variation-selector and ZWJ-sequence emoji", () => {
		expect(splitLeadingEmoji("\u{1F6E0}\uFE0F refactor auth")).toEqual({ emoji: "\u{1F6E0}\uFE0F", rest: "refactor auth" });
		expect(splitLeadingEmoji("\u{1F9D1}\u200D\u{1F4BB} pair on parser")).toEqual({
			emoji: "\u{1F9D1}\u200D\u{1F4BB}",
			rest: "pair on parser",
		});
	});

	it("returns an empty emoji when there is no leading emoji", () => {
		expect(splitLeadingEmoji("plain title here")).toEqual({ emoji: "", rest: "plain title here" });
	});

	it("does not treat a leading ASCII digit as an emoji", () => {
		expect(splitLeadingEmoji("3 retries left")).toEqual({ emoji: "", rest: "3 retries left" });
	});

	it("requires whitespace after the emoji (no false match on glued text)", () => {
		expect(splitLeadingEmoji("\u{1F41B}fix")).toEqual({ emoji: "", rest: "\u{1F41B}fix" });
	});
});

// ─── parseGeneratedName ─────────────────────────────────────────

describe("parseGeneratedName", () => {
	it("extracts the contextual emoji and label", () => {
		expect(parseGeneratedName("\u{1F41B} fix flaky pagination test")).toEqual({
			emoji: "\u{1F41B}",
			label: "fix flaky pagination test",
		});
	});

	it("returns an empty emoji when the model omits it (caller falls back to random)", () => {
		expect(parseGeneratedName("fix flaky pagination test")).toEqual({
			emoji: "",
			label: "fix flaky pagination test",
		});
	});

	it("cleans markdown/quotes before splitting the emoji", () => {
		expect(parseGeneratedName('"\u{1F50D} review PR 1001"')).toEqual({ emoji: "\u{1F50D}", label: "review PR 1001" });
	});

	it("returns null for SKIP and empty/markdown-only input", () => {
		expect(parseGeneratedName("SKIP")).toBeNull();
		expect(parseGeneratedName("")).toBeNull();
		expect(parseGeneratedName("###")).toBeNull();
	});

	it("returns null for a stray-prefixed sentinel like an emoji + SKIP", () => {
		expect(parseGeneratedName("\u{1F914} SKIP")).toBeNull();
	});
});

// ─── system prompts ───────────────────────────────────────────────────────────────────
describe("AUTO_NAME_SYSTEM_PROMPT (early call)", () => {
	it("includes the SKIP rule and compact content-free examples", () => {
		expect(AUTO_NAME_SYSTEM_PROMPT).toContain("SKIP rule");
		expect(AUTO_NAME_SYSTEM_PROMPT).toContain('Examples that should SKIP: "hi", "hello", "?", "help", "test", "thanks"');
	});

	it("instructs the model to prefix a single contextual emoji", () => {
		expect(AUTO_NAME_SYSTEM_PROMPT).toContain("a single emoji that best captures the session");
	});

	it("omits title examples and artifact-specific naming instructions", () => {
		expect(AUTO_NAME_SYSTEM_PROMPT).not.toMatch(/\breview\b/i);
		expect(AUTO_NAME_SYSTEM_PROMPT).not.toContain("Examples of valid outputs");
		expect(AUTO_NAME_SYSTEM_PROMPT).not.toContain("Include PR or issue numbers");
		expect(AUTO_NAME_SYSTEM_PROMPT).not.toContain("Lead with the verb");
		expect(AUTO_NAME_SYSTEM_PROMPT).not.toContain(
			"Mention the repo / component / file / feature when it's clear",
		);
	});
});

describe("classifyHerdrLabel", () => {
  it("writes when the current label is missing or unreadable", () => {
    expect(classifyHerdrLabel(null, "🔮 auto title", null)).toBe("write");
    expect(classifyHerdrLabel(undefined, "🔮 auto title", "🔮 previous title")).toBe("write");
    expect(classifyHerdrLabel("", "🔮 auto title", null)).toBe("write");
  });

  it("writes for numeric Herdr fallback labels, including an empty incoming title", () => {
    expect(classifyHerdrLabel("1", "🔮 auto title", null)).toBe("write");
    expect(classifyHerdrLabel("42", "", null)).toBe("write");
  });

  it("writes when the current label already equals the incoming title", () => {
    expect(classifyHerdrLabel("🔮 auto title", "🔮 auto title", null)).toBe("write");
    expect(classifyHerdrLabel("", "", null)).toBe("write");
  });

  it("writes when the current label equals the last title session-banner wrote", () => {
    expect(classifyHerdrLabel("🔮 previous title", "⚡ next title", "🔮 previous title")).toBe("write");
  });

  it("writes when the current label equals persisted ownership for this Herdr tab", () => {
    expect(classifyHerdrLabel("🔮 persisted title", "⚡ next title", null, "🔮 persisted title")).toBe("write");
  });

  it("backs off for non-owned GUI labels, including emoji labels", () => {
    expect(classifyHerdrLabel("User picked this", "🔮 auto title", null)).toBe("back_off");
    expect(classifyHerdrLabel("🔄 Tab Rename Behavior Issue", "🔮 auto title", "🔮 previous title")).toBe(
      "back_off",
    );
  });
});

// ─── parseBooleanEnv ───────────────────────────────────────────────────────

describe("parseBooleanEnv", () => {
	it("returns the fallback for undefined, empty, or whitespace-only values", () => {
		expect(parseBooleanEnv(undefined, true)).toBe(true);
		expect(parseBooleanEnv(undefined, false)).toBe(false);
		expect(parseBooleanEnv("", true)).toBe(true);
		expect(parseBooleanEnv("   ", false)).toBe(false);
	});

	it("parses truthy values case-insensitively", () => {
		for (const v of ["1", "true", "on", "yes", " TRUE ", "On", "YES"]) {
			expect(parseBooleanEnv(v, false)).toBe(true);
		}
	});

	it("parses falsy values case-insensitively", () => {
		for (const v of ["0", "false", "off", "no", " OFF ", "False", "No"]) {
			expect(parseBooleanEnv(v, true)).toBe(false);
		}
	});

	it("returns the fallback for unrecognized values rather than guessing", () => {
		expect(parseBooleanEnv("maybe", true)).toBe(true);
		expect(parseBooleanEnv("2", false)).toBe(false);
	});
});

describe("AUTO_NAME_SYSTEM_PROMPT_FORCE (late call)", () => {
	it("strips the SKIP rule and tells the model to always emit a title", () => {
		expect(AUTO_NAME_SYSTEM_PROMPT_FORCE).not.toContain("SKIP rule");
		expect(AUTO_NAME_SYSTEM_PROMPT_FORCE).not.toContain("respond with SKIP\"");
		expect(AUTO_NAME_SYSTEM_PROMPT_FORCE).toContain("Always emit a title");
		expect(AUTO_NAME_SYSTEM_PROMPT_FORCE).toContain("Do not respond with SKIP");
	});

	it("does not end with the SKIP example line", () => {
		expect(AUTO_NAME_SYSTEM_PROMPT_FORCE.trimEnd().endsWith("SKIP")).toBe(false);
	});

	it("instructs the model to prefix a single contextual emoji", () => {
		expect(AUTO_NAME_SYSTEM_PROMPT_FORCE).toContain("a single emoji that best captures the session");
	});

	it("omits title examples and artifact-specific naming instructions", () => {
		expect(AUTO_NAME_SYSTEM_PROMPT_FORCE).not.toMatch(/\breview\b/i);
		expect(AUTO_NAME_SYSTEM_PROMPT_FORCE).not.toContain("Examples of valid outputs");
		expect(AUTO_NAME_SYSTEM_PROMPT_FORCE).not.toContain("Include PR or issue numbers");
		expect(AUTO_NAME_SYSTEM_PROMPT_FORCE).not.toContain("Lead with the verb");
		expect(AUTO_NAME_SYSTEM_PROMPT_FORCE).not.toContain(
			"Mention the repo / component / file / feature when it's clear",
		);
	});
});

