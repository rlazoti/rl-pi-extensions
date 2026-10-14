import assert from "node:assert/strict";
import test from "node:test";
import {
	ENTRY_KINDS,
	compareAuthority,
	hasError,
	identityOf,
	isAssertionKey,
	isInjectable,
	parseScope,
	parseTopicFile,
	renderEntry,
	renderTopicFile,
	splitRevision,
	scopeKey,
	specificityRank,
	type MemoryEntry,
} from "./schema.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** The exact scenario the entry schema exists to prevent. */
const CONFLICTING_TOPICS = `# UI

## ui.background
- kind: preference
- scope: global
- asOf: 2026-10-02
- source: PR review rl-pi-extensions
- status: active
Use dark grey for the UI background.

## ui.background@2026-06-14
- kind: preference
- scope: global
- asOf: 2026-06-14
- source: Slack
- status: superseded
- supersedes: ui.background@2026-05-01
Use navy for the UI background.
`;

function parse(text: string, path = "knowledge/ui.md") {
	return parseTopicFile(text, path);
}

function issueCodes(issues: { code: string }[]): string[] {
	return issues.map((issue) => issue.code);
}

function entryByHeading(file: { entries: MemoryEntry[] }, heading: string): MemoryEntry {
	const entry = file.entries.find((candidate) => candidate.heading === heading);
	assert.ok(entry, `entry "${heading}" exists`);
	return entry;
}

// ─── Grammar helpers ────────────────────────────────────────────────────────

test("isAssertionKey: lowercase dotted slugs only", () => {
	assert.equal(isAssertionKey("ui.background"), true);
	assert.equal(isAssertionKey("git.branch-naming_v2"), true);
	assert.equal(isAssertionKey("a"), true);
	assert.equal(isAssertionKey("UI.Background"), false, "uppercase is not a key");
	assert.equal(isAssertionKey("ui background"), false, "spaces are not a key");
	assert.equal(isAssertionKey("ui.background@2026-06-14"), false, "revision is not part of a key");
	assert.equal(isAssertionKey(".ui"), false, "must not start with a separator");
	assert.equal(isAssertionKey("背景"), false, "non-ASCII keys are rejected, bodies are not");
});

test("splitRevision: strips a date suffix, leaves anything else alone", () => {
	assert.deepEqual(splitRevision("ui.background@2026-06-14"), { key: "ui.background", revision: "2026-06-14" });
	assert.deepEqual(splitRevision("ui.background"), { key: "ui.background" });
	assert.deepEqual(splitRevision("ui.background@June"), { key: "ui.background@June" });
});

test("parseScope: three legal shapes, everything else is invalid — never global", () => {
	assert.deepEqual(parseScope("global"), { level: "global", raw: "global" });
	assert.deepEqual(parseScope("  global  "), { level: "global", raw: "global" });
	assert.deepEqual(parseScope("project:money-manager"), { level: "project", value: "money-manager", raw: "project:money-manager" });
	assert.deepEqual(parseScope("path:src/ui/**"), { level: "path", value: "src/ui/**", raw: "path:src/ui/**" });
	assert.deepEqual(parseScope("project:"), { level: "invalid", raw: "project:" });
	assert.deepEqual(parseScope("host:work"), { level: "invalid", raw: "host:work" });
	assert.deepEqual(parseScope(""), { level: "invalid", raw: "" });
});

test("scopeKey + specificityRank: project > path > global > invalid", () => {
	assert.equal(scopeKey(parseScope("global")), "global");
	assert.equal(scopeKey(parseScope("project:money-manager")), "project:money-manager");
	assert.equal(scopeKey(parseScope("host:work")), "invalid:host:work");
	assert.deepEqual(
		[parseScope("project:x"), parseScope("path:x"), parseScope("global"), parseScope("nope")].map(specificityRank),
		[3, 2, 1, 0],
	);
});

// ─── Structural parsing ─────────────────────────────────────────────────────

test("parseTopicFile: reads a supersede chain as two entries in one topic file", () => {
	const file = parse(CONFLICTING_TOPICS);
	assert.equal(file.title, "UI");
	assert.equal(file.path, "knowledge/ui.md");
	assert.deepEqual(file.entries.map((entry) => entry.heading), [
		"ui.background",
		"ui.background@2026-06-14",
	]);
	assert.deepEqual(file.issues, []);

	const active = entryByHeading(file, "ui.background");
	assert.equal(active.key, "ui.background");
	assert.equal(active.revision, undefined);
	assert.equal(active.status, "active");
	assert.equal(active.kind, "preference");
	assert.equal(active.asOf, "2026-10-02");
	assert.equal(active.source, "PR review rl-pi-extensions");
	assert.equal(active.body, "Use dark grey for the UI background.");
	assert.equal(active.range.start, 3);

	const tombstone = entryByHeading(file, "ui.background@2026-06-14");
	assert.equal(tombstone.key, "ui.background", "revision suffix is stripped from the key");
	assert.equal(tombstone.revision, "2026-06-14");
	assert.equal(tombstone.status, "superseded");
	assert.equal(tombstone.supersedes, "ui.background@2026-05-01");
});

test("identityOf: a claim is its key + scope, revision ignored", () => {
	const file = parse(CONFLICTING_TOPICS);
	const active = entryByHeading(file, "ui.background");
	const tombstone = entryByHeading(file, "ui.background@2026-06-14");
	assert.equal(identityOf(active), identityOf(tombstone));

	const otherScope = entryByHeading(
		parse(`# UI

## ui.background
- scope: project:money-manager
- asOf: 2026-10-02
- status: active
Navy here only.
`),
		"ui.background",
	);
	assert.notEqual(identityOf(active), identityOf(otherScope));
	assert.equal(identityOf(entryByHeading(parse(`## Ship It\n- scope: global\nBody.\n`), "Ship It")), null, "invalid key has no identity");
});

test("entry body keeps everything after the metadata block, including nested headings and fences", () => {
	const file = parse(`# Notes

## build.commands
- kind: procedure
- scope: global
- asOf: 2026-10-01
- status: active
Run the gates like this:

\`\`\`bash
npm test
## not a heading inside a fence
\`\`\`

### Sub-step
Second paragraph.
`);
	assert.equal(file.entries.length, 1, "fenced ## is body, and ### does not start an entry");
	const entry = entryByHeading(file, "build.commands");
	assert.match(entry.body, /## not a heading inside a fence/);
	assert.match(entry.body, /### Sub-step\nSecond paragraph\./);
});

test("metadata block ends at the first non-metadata line", () => {
	const file = parse(`# Notes

## ui.spacing
- kind: rule
- scope: global
- asOf: 2026-10-01
- status: active
Prefer 8px multiples.

- this list item is body, not a kind field
`);
	const entry = entryByHeading(file, "ui.spacing");
	assert.equal(entry.kind, "rule");
	assert.match(entry.body, /^Prefer 8px multiples\.\n\n- this list item is body/);
});

test("CRLF input parses identically to LF input", () => {
	const crlf = CONFLICTING_TOPICS.replace(/\n/g, "\r\n");
	assert.deepEqual(parse(crlf).entries, parse(CONFLICTING_TOPICS).entries);
});

test("unclosed fence is reported, not guessed at", () => {
	const file = parse("# UI\n\n## ui.a\n- status: active\n```bash\nnpm test\n");
	assert.deepEqual(issueCodes(file.issues), ["unclosed-fence"]);
	assert.equal(file.entries.length, 1);
});

// ─── Validation ─────────────────────────────────────────────────────────────

test("legacy prose headings are flagged as bad keys and made non-injectable", () => {
	const file = parse(`# Git Standards & Preferences\n\n## Branch Naming Convention\nAll branches use rl-<MM>-<DD>-<slug>.\n`);
	const entry = entryByHeading(file, "Branch Naming Convention");
	assert.deepEqual(issueCodes(entry.issues).includes("bad-key"), true);
	assert.equal(isInjectable(entry), false);
	assert.equal(hasError(entry.issues), true);
});

test("missing kind, scope, and asOf warn and default; nothing invents a date", () => {
	const entry = entryByHeading(parse(`## ui.grid\nKeep it on an 8px grid.\n`), "ui.grid");
	assert.deepEqual(issueCodes(entry.issues), ["missing-kind", "missing-scope", "missing-asOf"], "one warning per defaulted field, in field order");
	assert.equal(entry.kind, "fact");
	assert.deepEqual(entry.scope, { level: "global", raw: "global" });
	assert.equal(entry.asOf, undefined, "no asOf is invented");
	assert.equal(isInjectable(entry), true, "warnings alone do not block injection");
	assert.equal(entry.body, "Keep it on an 8px grid.", "prose with no metadata is still the body");
});

test("empty body warns but a metadata-only entry still parses", () => {
	const entry = entryByHeading(parse(`## ui.grid\n- kind: rule\n- scope: global\n- asOf: 2026-10-01\n`), "ui.grid");
	assert.deepEqual(issueCodes(entry.issues), ["empty-body"]);
});

test("a malformed scope is an error and is never silently global", () => {
	const entry = entryByHeading(parse(`## ui.background\n- scope: host:work\n- asOf: 2026-10-01\nDark grey.\n`), "ui.background");
	assert.equal(entry.scope.level, "invalid");
	assert.deepEqual(issueCodes(entry.issues), ["missing-kind", "bad-scope"]);
	assert.equal(isInjectable(entry), false);
	assert.equal(identityOf(entry), null, "an uncomparable entry cannot be used to detect conflicts either");
});

test("bad kind normalizes case, but an unknown kind is an error", () => {
	const folded = entryByHeading(parse(`## a\n- kind: Preference\n- status: active\nBody.\n`), "a");
	assert.equal(folded.kind, "preference");
	assert.deepEqual(issueCodes(folded.issues), ["bad-kind", "missing-scope", "missing-asOf"]);

	const bogus = entryByHeading(parse(`## b\n- kind: vibe\nBody.\n`), "b");
	assert.equal(bogus.kind, "fact");
	assert.deepEqual(issueCodes(bogus.issues).includes("bad-kind"), true);
	assert.equal(isInjectable(bogus), false);
	for (const kind of ENTRY_KINDS) {
		assert.equal(entryByHeading(parse(`## ${kind}\n- kind: ${kind}\nBody.\n`), kind).kind, kind);
	}
});

test("bad status, bad asOf, and bad supersedes reference are reported", () => {
	const badStatus = entryByHeading(parse(`## a\n- status: current\nBody.\n`), "a");
	assert.equal(badStatus.status, "active");
	assert.deepEqual(issueCodes(badStatus.issues).includes("bad-status"), true);
	assert.equal(isInjectable(badStatus), false);

	const badDate = entryByHeading(parse(`## b\n- asOf: last tuesday\nBody.\n`), "b");
	assert.deepEqual(issueCodes(badDate.issues), ["missing-kind", "missing-scope", "bad-asOf"]);
	assert.equal(isInjectable(badDate), false);

	const badRef = entryByHeading(parse(`## c\n- supersedes: The Old Rule\nBody.\n`), "c");
	assert.deepEqual(issueCodes(badRef.issues), ["missing-kind", "missing-scope", "missing-asOf", "bad-supersedes"]);
});

test("unknown fields are preserved verbatim and flagged as warnings", () => {
	const entry = entryByHeading(parse(`## a\n- kind: rule\n- owner: rodrigo\n- status: active\nBody.\n`), "a");
	assert.equal(entry.fields.owner, "rodrigo");
	assert.deepEqual(issueCodes(entry.issues), ["missing-scope", "missing-asOf", "unknown-field"]);
});

test("repeated metadata fields keep the first value", () => {
	const entry = entryByHeading(parse(`## a\n- kind: rule\n- kind: fact\n- asOf: 2026-10-01\nBody.\n`), "a");
	assert.equal(entry.kind, "rule");
	assert.deepEqual(issueCodes(entry.issues), ["duplicate-field", "missing-scope"]);
});

test("a file with no entries at all is reported as needing migration", () => {
	const file = parse("# Just Prose\n\nEverything is in paragraphs here.\n");
	assert.deepEqual(issueCodes(file.issues), ["no-entries"]);
	assert.equal(file.entries.length, 0);
});

test("missing top-level heading falls back to the file name", () => {
	const file = parse("## a\n- asOf: 2026-10-01\nBody.\n", "knowledge/money-manager.md");
	assert.equal(file.title, "money-manager");
	assert.deepEqual(issueCodes(file.issues), ["missing-title"]);
});

// ─── The conflict invariant ─────────────────────────────────────────────────

test("two active claims on one identity are both flagged and uninjectable", () => {
	const file = parse(`# UI

## ui.background
- kind: preference
- scope: global
- asOf: 2026-10-02
- status: active
Dark grey.

## ui.background@2026-05-01
- kind: preference
- scope: global
- asOf: 2026-05-01
- status: active
Black.
`);
	const flagged = file.entries.filter((entry) => issueCodes(entry.issues).includes("duplicate-identity"));
	assert.equal(flagged.length, 2, "both sides of the conflict are reported");
	for (const entry of flagged) assert.equal(isInjectable(entry), false);
});

test("a malformed sibling does not turn a clean active claim into a duplicate", () => {
	const file = parse(`# UI

## ui.background
- scope: global
- asOf: 2026-10-02
- status: active
Dark grey.

## ui.background@2026-05-01
- scope: global
- asOf: 2026-05-01
- status: current
Black.
`);
	const clean = entryByHeading(file, "ui.background");
	const broken = entryByHeading(file, "ui.background@2026-05-01");
	assert.equal(broken.status, "active", "an unrecognised status falls back to active but is an error");
	assert.deepEqual(issueCodes(broken.issues), ["missing-kind", "bad-status"]);
	assert.deepEqual(issueCodes(clean.issues), ["missing-kind"], "the clean claim is not flagged as a duplicate of a typo");
	assert.equal(isInjectable(clean), true);
	assert.equal(isInjectable(broken), false);
});

test("active plus superseded, or two scopes, or two revisions in different scopes are fine", () => {
	const chain = parse(CONFLICTING_TOPICS);
	assert.deepEqual(chain.issues, []);
	for (const entry of chain.entries) assert.equal(issueCodes(entry.issues).includes("duplicate-identity"), false);

	const twoScopes = parse(`# UI

## ui.background
- scope: global
- asOf: 2026-10-02
- status: active
Dark grey everywhere.

## ui.background
- scope: project:money-manager
- asOf: 2026-09-01
- status: active
Navy in this app only.
`);
	assert.equal(twoScopes.entries.every((entry) => isInjectable(entry)), true);
	assert.deepEqual(twoScopes.issues, []);
});

test("withdrawn entries do not count as active claims", () => {
	const file = parse(`# UI

## ui.background
- scope: global
- asOf: 2026-05-01
- status: withdrawn
Black — retracted.

## ui.background
- scope: global
- asOf: 2026-10-02
- status: active
Dark grey.
`);
	for (const entry of file.entries) {
		assert.equal(issueCodes(entry.issues).includes("duplicate-identity"), false);
	}
	assert.equal(entryByHeading(file, "ui.background").status, "withdrawn");
	assert.equal(file.entries.filter(isInjectable).length, 1);
});

// ─── Authority order ────────────────────────────────────────────────────────

function entryAt(heading: string, fields: Record<string, string>): MemoryEntry {
	const meta = Object.entries(fields).map(([name, value]) => `- ${name}: ${value}`).join("\n");
	return entryByHeading(parse(`# T\n\n## ${heading}\n${meta}\nBody.\n`), heading);
}

test("compareAuthority: specificity outranks recency", () => {
	const globalOld = entryAt("ui.background", { scope: "global", asOf: "2026-01-01" });
	const projectNew = entryAt("ui.background", { scope: "project:money-manager", asOf: "2020-01-01" });
	assert.ok(compareAuthority(projectNew, globalOld) < 0, "project scope wins even when older");

	const pathMid = entryAt("ui.background", { scope: "path:src/ui/**", asOf: "2019-01-01" });
	assert.ok(compareAuthority(pathMid, globalOld) < 0, "path outranks global");
	assert.ok(compareAuthority(globalOld, pathMid) > 0, "global loses to path");
	assert.ok(compareAuthority(pathMid, projectNew) > 0, "path loses to project");
});

test("compareAuthority: same scope, newer asOf wins; missing date sorts last", () => {
	const newer = entryAt("ui.background", { scope: "global", asOf: "2026-10-02" });
	const older = entryAt("ui.background", { scope: "global", asOf: "2026-06-14" });
	const undated = entryAt("ui.background", { scope: "global" });
	assert.ok(compareAuthority(newer, older) < 0);
	assert.ok(compareAuthority(older, undated) < 0, "an explicit date always beats no date");
});

test("compareAuthority: antisymmetric and total, with a deterministic final tie-break", () => {
	const a = entryAt("ui.background", { scope: "global", asOf: "2026-10-02" });
	const b = entryAt("ui.background@2026-01-01", { scope: "global", asOf: "2026-10-02" });
	const c = entryAt("ui.foreground", { scope: "global", asOf: "2026-10-02" });

	assert.ok(compareAuthority(a, b) < 0, "same key and date: heading ascending decides");
	assert.ok(compareAuthority(b, a) > 0, "antisymmetric");
	assert.ok(compareAuthority(a, c) < 0, "key ascending breaks date ties");
	assert.equal(compareAuthority(a, a), 0);

	for (const pair of [[a, b], [a, c], [b, c]] as [MemoryEntry, MemoryEntry][]) {
		assert.equal(Math.sign(compareAuthority(pair[0], pair[1])) + Math.sign(compareAuthority(pair[1], pair[0])), 0);
	}

	const ranked = [c, b, a].sort(compareAuthority).map((entry) => entry.heading);
	assert.deepEqual(ranked, ["ui.background", "ui.background@2026-01-01", "ui.foreground"]);
	assert.deepEqual([a, b, c].sort(compareAuthority).map((entry) => entry.heading), ranked, "order is input-independent");
});

test("compareAuthority never consults similarity — that is the whole point", () => {
	const terse = entryAt("ui.background", { scope: "global", asOf: "2026-10-02" });
	terse.body = "Dark grey.";
	const verbose = entryAt("ui.background", { scope: "global", asOf: "2026-06-14" });
	verbose.body = "Navy background color UI background color background preferred.";
	assert.ok(compareAuthority(terse, verbose) < 0, "recency wins regardless of term density");
	assert.ok(compareAuthority(verbose, terse) > 0);
});

// ─── Rendering ──────────────────────────────────────────────────────────────

test("renderEntry writes fields in a fixed order and drops nothing", () => {
	const entry = entryByHeading(parse(CONFLICTING_TOPICS), "ui.background@2026-06-14");
	assert.equal(renderEntry(entry), [
		"## ui.background@2026-06-14",
		"- kind: preference",
		"- scope: global",
		"- asOf: 2026-06-14",
		"- source: Slack",
		"- supersedes: ui.background@2026-05-01",
		"- status: superseded",
		"",
		"Use navy for the UI background.",
	].join("\n"));
});

test("rendered unknown fields survive and malformed scopes are not laundered", () => {
	const withOwner = entryByHeading(parse(`## a\n- kind: rule\n- owner: rodrigo\n- asOf: 2026-10-01\nBody.\n`), "a");
	assert.match(renderEntry(withOwner), /- owner: rodrigo/);

	const badScope = entryByHeading(parse(`## a\n- scope: host:work\nBody.\n`), "a");
	assert.match(renderEntry(badScope), /- scope: host:work/, "the bad value is written back unchanged");
});

test("render → parse → render is byte-idempotent and loses no entries", () => {
	const once = renderTopicFile(parse(CONFLICTING_TOPICS));
	const twice = renderTopicFile(parse(once));
	assert.equal(twice, once);

	const reparsed = parse(once);
	assert.deepEqual(reparsed.entries.map((entry) => entry.heading), [
		"ui.background",
		"ui.background@2026-06-14",
	]);
	assert.deepEqual(reparsed.entries, parse(once).entries);
	assert.deepEqual(reparsed.entries.map((entry) => entry.body), [
		"Use dark grey for the UI background.",
		"Use navy for the UI background.",
	]);
});
