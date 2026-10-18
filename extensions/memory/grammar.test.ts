import assert from "node:assert/strict";
import test from "node:test";

import {
	BODY_MAX_CHARS,
	charCount,
	formatIdentity,
	identityOf,
	isAlwaysRule,
	normalizeBody,
	parseStore,
	renderEntry,
	renderStore,
	validateClaim,
	wrapBody,
	type Claim,
} from "./grammar.ts";

/** A claim with every field set, used by the round-trip tests. */
function fullClaim(overrides: Partial<Claim> = {}): Claim {
	return {
		key: "git-standards.branch-naming",
		kind: "rule",
		scope: "global",
		asOf: "2026-05-02",
		source: "Rodrigo, AGENTS.md §6",
		body: "All Git branches are named rl-<MM>-<DD>-<short_description> with the current local month and day, zero-padded.",
		aliases: ["branch name", "branch pattern"],
		tags: ["git", "always"],
		links: ["https://github.com/rlazoti/rl-pi-extensions", "file://~/Projects/x/AGENTS.md"],
		origin: "migration",
		state: "pending",
		proposedAt: "2026-10-16",
		deferredAt: "2026-10-17",
		supersededAt: "2026-10-18",
		rejectedAt: "2026-10-19",
		statusOverride: "the sha is part of the rule's example, not status",
		...overrides,
	};
}

const CANONICAL = `# Claims about git
Preamble prose stays where it is.

## git-standards.branch-naming
kind: rule
scope: global
asOf: 2026-05-02
source: Rodrigo, AGENTS.md §6

All Git branches are named rl-<MM>-<DD>-<short_description>, with the current local
month and day, zero-padded.
`;

test("grammar: a full claim round-trips through render and parse", () => {
	const claim = fullClaim();
	const text = renderStore("# Claims\n", [claim]);
	const parsed = parseStore(text, "claims/rules/git-standards.md");
	assert.deepEqual(parsed.errors, []);
	assert.equal(parsed.entries.length, 1);
	assert.deepEqual(parsed.entries[0]!.claim, claim);
});

test("grammar: write → read → write is byte-stable (R6)", () => {
	const first = renderStore("# Claims\n", [fullClaim(), fullClaim({ key: "git-cli.force-push", origin: "agent", state: "approved", aliases: [], tags: [], links: [], proposedAt: undefined, deferredAt: undefined, supersededAt: undefined, rejectedAt: undefined, statusOverride: undefined })]);
	const parsed = parseStore(first, "claims/rules/git.md");
	assert.deepEqual(parsed.errors, []);
	const second = renderStore(parsed.preamble, parsed.entries.map((e) => e.claim));
	assert.equal(second, first);
	// And a third pass, for good measure: stability is a fixed point, not a flip.
	const reparsed = parseStore(second, "claims/rules/git.md");
	assert.equal(renderStore(reparsed.preamble, reparsed.entries.map((e) => e.claim)), second);
});

test("grammar: the hand-written canonical file is re-rendered byte for byte", () => {
	const parsed = parseStore(CANONICAL, "claims/rules/git-standards.md");
	assert.deepEqual(parsed.errors, []);
	assert.equal(renderStore(parsed.preamble, parsed.entries.map((e) => e.claim)), CANONICAL);
});

test("grammar: defaults are parsed but not written", () => {
	const parsed = parseStore("## a.key\nkind: fact\nscope: global\nasOf: 2026-01-01\nsource: a PR review\n\nBody prose.\n", "claims/facts/a.md");
	assert.deepEqual(parsed.errors, []);
	assert.equal(parsed.entries[0]!.claim.origin, "agent");
	assert.equal(parsed.entries[0]!.claim.state, "approved");
	const rendered = renderEntry(parsed.entries[0]!.claim).join("\n");
	assert.ok(!rendered.includes("origin:"), "default origin is not written");
	assert.ok(!rendered.includes("state:"), "default state is not written");
});

test("grammar: body is one paragraph and wraps deterministically", () => {
	const body = "The quick brown fox jumps over the lazy dog, then repeats itself until the line is long enough to wrap twice more for testing.";
	const lines = wrapBody(body);
	assert.ok(lines.length > 1);
	for (const line of lines) assert.ok(!line.startsWith("#"));
	assert.equal(normalizeBody(lines.join(" ")), body);
	const long = "supercalifragilisticexpialidocious-and-then-some-more-text-that-does-not-fit";
	assert.deepEqual(wrapBody(long, 20), [long], "a word longer than the column overflows rather than being split");
});

test("grammar: a wrapped body re-parses to the same claim", () => {
	const claim = fullClaim({ body: "x".repeat(60) + " " + "y".repeat(60) + " " + "z".repeat(200) });
	const text = renderStore("", [claim]);
	const parsed = parseStore(text, "claims/rules/x.md");
	assert.deepEqual(parsed.errors, []);
	assert.equal(parsed.entries[0]!.claim.body, normalizeBody(claim.body));
});

test("grammar: a missing asOf is refused and says it is never filled in (R5)", () => {
	const problems = validateClaim(fullClaim({ asOf: "" }));
	assert.ok(problems.some((p) => p.includes("asOf is required and is never filled in")));
	assert.ok(validateClaim(fullClaim({ asOf: "yesterday" })).some((p) => p.includes("asOf must be a real YYYY-MM-DD")));
	assert.ok(validateClaim(fullClaim({ asOf: "2026-02-30" })).some((p) => p.includes("asOf must be a real YYYY-MM-DD")));
});

test("grammar: a missing source is refused and says it is never filled in (R5)", () => {
	assert.ok(validateClaim(fullClaim({ source: "  " })).some((p) => p.includes("source is required and is never filled in")));
});

test("grammar: kind, scope, state and origin are checked", () => {
	assert.ok(validateClaim(fullClaim({ kind: "preference" as Claim["kind"] })).some((p) => p.includes("kind must be rule | fact")));
	for (const scope of ["global", "project:rlazoti/rl-pi-extensions", "path:extensions/memory/**"]) {
		assert.deepEqual(validateClaim(fullClaim({ scope })), []);
	}
	for (const scope of ["", "project:", "path:", "user:rodrigo", "Global"]) {
		assert.ok(validateClaim(fullClaim({ scope })).some((p) => p.includes("scope must be global")), scope);
	}
	assert.ok(validateClaim(fullClaim({ state: "staged" as Claim["state"] })).some((p) => p.includes("state must be approved | pending")));
	assert.ok(validateClaim(fullClaim({ origin: "human" as Claim["origin"] })).some((p) => p.includes("origin must be agent | migration")));
});

test("grammar: body length limit is characters, not UTF-16 units", () => {
	assert.ok(validateClaim(fullClaim({ body: "a".repeat(BODY_MAX_CHARS + 1) })).some((p) => p.includes(`is ${BODY_MAX_CHARS + 1} characters`)));
	const emoji = `${"a".repeat(BODY_MAX_CHARS - 1)}🎉`;
	assert.equal(charCount(emoji), BODY_MAX_CHARS);
	assert.deepEqual(validateClaim(fullClaim({ body: emoji })), []);
	assert.ok(charCount("🎉") < "🎉".length, "a code point is not a UTF-16 unit");
});

test("grammar: a body may not smuggle a heading", () => {
	assert.ok(validateClaim(fullClaim({ body: "fine ## not fine" })).some((p) => p.includes("may not contain a markdown heading")));
});

test("grammar: a list value containing the separator is refused", () => {
	assert.ok(validateClaim(fullClaim({ tags: ["git; always"] })).some((p) => p.includes('may not contain ";"')));
});

test("grammar: a hand edit that breaks the grammar names the file and line, and only that entry is dropped (R7)", () => {
	const broken = `# Claims

## good.one
kind: rule
scope: global
asOf: 2026-01-01
source: Rodrigo

Still parsed.

## bad.one
kind: rule
scope: global
source: Rodrigo

Missing asOf, so this one is out.

## bad.two
kind: rule
nonsense: nope
scope: global
asOf: 2026-01-01
source: Rodrigo

Field line that is not a field.

## good.two
kind: fact
scope: global
asOf: 2026-01-02
source: a test

Also parsed.
`;
	const parsed = parseStore(broken, "claims/rules/mixed.md");
	assert.deepEqual(parsed.entries.map((e) => e.claim.key), ["good.one", "good.two"]);
	assert.equal(parsed.errors.length, 2);
	assert.equal(parsed.errors[0]!.file, "claims/rules/mixed.md");
	assert.equal(parsed.errors[0]!.line, 11, "the bad entry's heading line");
	assert.match(parsed.errors[0]!.message, /missing required field "asOf"/);
	assert.equal(parsed.errors[1]!.line, 18);
	assert.match(parsed.errors[1]!.message, /unknown field "nonsense"/);
});

test("grammar: an entry with no blank line after its fields is reported, not swallowed", () => {
	const parsed = parseStore("## a.key\nkind: fact\nscope: global\nasOf: 2026-01-01\nsource: x\n", "claims/facts/a.md");
	assert.deepEqual(parsed.entries, []);
	assert.match(parsed.errors[0]!.message, /body is required/);
});

test("grammar: a body containing a colon stays a body", () => {
	const parsed = parseStore("## a.key\nkind: fact\nscope: global\nasOf: 2026-01-01\nsource: x\n\ncwd: the working directory, per Pi's context.\n", "claims/facts/a.md");
	assert.deepEqual(parsed.errors, []);
	assert.equal(parsed.entries[0]!.claim.body, "cwd: the working directory, per Pi's context.");
});

test("grammar: a file with no entries is a preamble, not an error", () => {
	const parsed = parseStore("# Just prose\n\nNothing keyed here.\n", "archive/old.md");
	assert.deepEqual(parsed.entries, []);
	assert.deepEqual(parsed.errors, []);
	assert.equal(parsed.preamble, "# Just prose\n\nNothing keyed here.");
});

test("grammar: identity is key + scope, and only the key is shown to a human", () => {
	assert.equal(identityOf(fullClaim({ scope: "global" })), identityOf(fullClaim({ scope: "global" })));
	assert.notEqual(identityOf(fullClaim({ scope: "global" })), identityOf(fullClaim({ scope: "project:x/y" })));
	assert.equal(formatIdentity(fullClaim({ key: "a.b", scope: "path:src/**" })), "a.b @ path:src/**");
});

test("grammar: only a rule tagged always is always-on (R35)", () => {
	assert.ok(isAlwaysRule(fullClaim({ kind: "rule", tags: ["git", "Always"] })));
	assert.ok(!isAlwaysRule(fullClaim({ kind: "rule", tags: ["git"] })));
	assert.ok(!isAlwaysRule(fullClaim({ kind: "fact", tags: ["always"] })), "a fact is never an always-on rule");
});

test("grammar: a heading the grammar cannot read keeps its prose out of the claim above (P1)", () => {
	const text = ["# Claims about git", "", "## git.flow", "kind: rule", "scope: global", "asOf: 2026-01-01", "source: probe", "", "Always rebase before pushing.", "", "## Notes — phase 3", "These are my notes, not a claim.", ""].join("\n");
	const parsed = parseStore(text, "claims/rules/git.md");
	assert.equal(parsed.entries.length, 1, "the claim above still reads");
	assert.equal(parsed.entries[0]!.claim.body, "Always rebase before pushing.", "the note did not join the claim");
	assert.deepEqual(parsed.errors, []);
	assert.equal(parsed.unreadable.length, 1);
	assert.equal(parsed.unreadable[0]!.line, 11);
	assert.match(parsed.unreadable[0]!.text, /## Notes — phase 3/);
});

test("grammar: prose below a blank line inside a body is named, and the claim still reads (P1)", () => {
	const text = ["## git.flow", "kind: rule", "scope: global", "asOf: 2026-01-01", "source: probe", "", "The claim body.", "", "NOTE TO SELF: check this after the migration.", ""].join("\n");
	const parsed = parseStore(text, "claims/rules/git.md");
	assert.equal(parsed.entries.length, 1);
	assert.equal(parsed.unreadable.length, 1);
	assert.equal(parsed.unreadable[0]!.line, 9, "the note's own line is named");
	assert.match(parsed.unreadable[0]!.extra ?? "", /one paragraph/);
});

test("grammar: the file's own title stays the preamble, and a second heading of its own is named (P1)", () => {
	const parsed = parseStore("# Claims about git\n\nProse under the title.\n\n## a.b\nkind: fact\nscope: global\nasOf: 2026-01-01\nsource: probe\n\nBody.\n\n# Another title\n\nOrphan prose.\n", "claims/rules/git.md");
	assert.equal(parsed.entries.length, 1);
	assert.equal(parsed.preamble, "# Claims about git\n\nProse under the title.");
	assert.deepEqual(parsed.unreadable.map((problem) => problem.line), [13]);
});
