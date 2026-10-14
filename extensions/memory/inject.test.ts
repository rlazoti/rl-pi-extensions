import assert from "node:assert/strict";
import test from "node:test";
import { parseTopicFile, type TopicFile } from "./schema.ts";
import { buildStore, type MemoryStore } from "./resolver.ts";
import { decide, type EditPlan, type WriteRequest } from "./gate.ts";
import { estimateTokens, inject, recall, tokenize } from "./inject.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const UI = `# ui

## ui.background
- kind: preference
- scope: global
- asOf: 2026-10-02
- status: active
Use dark grey for the UI background.

## ui.background@2026-06-14
- kind: preference
- scope: global
- asOf: 2026-06-14
- status: superseded
Use navy for the UI background.

## ui.foreground
- kind: preference
- scope: project:rl-pi-extensions
- asOf: 2026-10-14
- status: active
Off-white for terminal text in this project.
`;

const GIT = `# git

## git.push
- kind: rule
- scope: global
- asOf: 2026-10-12
- status: active
Never push changes to GitHub without explicit confirmation.

## test.gate
- kind: procedure
- scope: project:rl-pi-extensions
- asOf: 2026-10-11
- status: active
Run npm test and npm run typecheck before any commit.
`;

const NOTES = `# notes

## pi.scores
- kind: fact
- scope: global
- asOf: 2026-10-10
- status: active
The old extension pushed whatever ranked highest, so three claims reached the model at once.
`;

const BROKEN = `# broken

## bad.scope
- kind: fact
- scope: host:work
- asOf: 2026-10-10
- status: active
A claim whose scope cannot be parsed, mentioning push confirmation github.

## Free-form prose heading
- kind: fact
- scope: global
- asOf: 2026-10-10
- status: active
An entry whose heading is not an assertion key, about push confirmation github.
`;

function storeOf(files: Record<string, string>): MemoryStore {
	return buildStore(Object.entries(files).map(([path, text]) => parseTopicFile(text, path)));
}

const BANK = storeOf({ "knowledge/ui.md": UI, "knowledge/git.md": GIT, "knowledge/notes.md": NOTES });

function keys(injected: Array<{ entry: { key: string } }>): string[] {
	return injected.map((hit) => hit.entry.key).sort();
}

// ─── Tokenize and recall ────────────────────────────────────────────────────

test("tokenize lowercases, drops punctuation and drops stopwords", () => {
	assert.deepEqual(tokenize("Never push changes to GitHub!"), ["never", "push", "changes", "github"]);
	assert.deepEqual(tokenize("the a it"), []);
	assert.deepEqual(tokenize("x y z"), [], "single characters are noise");
});

test("recall returns every entry that matches, not only the best one", () => {
	const hits = recall(BANK, "github confirmation grey navy");
	assert.equal(hits[0]!.entry.key, "git.push");
	assert.ok(hits.some((hit) => hit.entry.key === "ui.background"), "other matches stay candidates; retrieval chooses candidates, the resolver chooses truth");
	assert.deepEqual(hits[0]!.matched.sort(), ["confirmation", "github"]);
});

test("matching the assertion key outranks matching the same word in prose", () => {
	const store = storeOf({
		"knowledge/git.md": `# git\n\n## git.push\n- kind: rule\n- scope: global\n- asOf: 2026-10-12\nNever push without explicit confirmation.\n`,
		"knowledge/notes.md": `# notes\n\n## notes.history\n- kind: fact\n- scope: global\n- asOf: 2026-10-10\nYears ago we would push constantly, before there were any rules at all.\n`,
	});
	const hits = recall(store, "push");
	assert.equal(hits.length, 2);
	assert.equal(hits[0]!.entry.key, "git.push");
	assert.ok(hits[0]!.score > hits[1]!.score);
});

test("a term in the heading outweighs the same term buried in a body", () => {
	const store = storeOf({
		"knowledge/a.md": `# a\n\n## ui.background\n- kind: preference\n- scope: global\n- asOf: 2026-01-01\nDark grey.\n`,
		"knowledge/b.md": `# b\n\n## colors.palette\n- kind: fact\n- scope: global\n- asOf: 2026-01-01\nThe background colour of the palette is dark grey.\n`,
	});
	const hits = recall(store, "background");
	assert.equal(hits.length, 2);
	assert.equal(hits[0]!.entry.key, "ui.background", "matching the assertion key wins over matching the prose");
});

test("query terms are a set: repeating a word changes nothing", () => {
	const once = recall(BANK, "push github");
	const twice = recall(BANK, "push github push github push");
	assert.deepEqual(twice.map((hit) => [hit.entry.key, hit.score]), once.map((hit) => [hit.entry.key, hit.score]));
});

test("metadata words do not drag unrelated entries into recall", () => {
	assert.deepEqual(recall(BANK, "global rule active fact"), [], "kind, scope and status are not scored");
});

test("empty and unmatchable queries recall nothing", () => {
	assert.deepEqual(recall(BANK, ""), []);
	assert.deepEqual(recall(BANK, "the of and"), []);
	assert.deepEqual(recall(BANK, "xylophone quokka"), []);
	assert.deepEqual(recall(buildStore([]), "push"), []);
});

test("recall limit is respected and stale claims stay candidates", () => {
	const hits = recall(BANK, "background navy grey", 2);
	assert.equal(hits.length, 2);
	assert.ok(hits.some((hit) => hit.entry.heading === "ui.background@2026-06-14"), "a superseded claim must still be recalled, or the redirect cannot fire");
});

test("equal scores order by key, not by scan order", () => {
	const zFile = parseTopicFile(`# z\n\n## zulu.alpha\n- kind: fact\n- scope: global\n- asOf: 2026-01-01\nShared body text.\n`, "knowledge/z.md");
	const aFile = parseTopicFile(`# a\n\n## alpha.alpha\n- kind: fact\n- scope: global\n- asOf: 2026-01-01\nShared body text.\n`, "knowledge/a.md");
	const forward = recall(buildStore([zFile, aFile]), "shared body");
	const reversed = recall(buildStore([aFile, zFile]), "shared body");
	assert.deepEqual(forward.map((hit) => hit.entry.key), reversed.map((hit) => hit.entry.key));
	assert.deepEqual(forward.map((hit) => hit.entry.key), ["alpha.alpha", "zulu.alpha"]);
});

// ─── What reaches the prompt ────────────────────────────────────────────────

test("a matching rule is injected with the fields that decided it", () => {
	const result = inject(BANK, { query: "may I push to github" });
	assert.match(result.text, /^## Memory — authoritative for this context/);
	assert.match(result.text, /- \[rule · global · 2026-10-12\] git\.push: Never push changes to GitHub without explicit confirmation\./);
	assert.equal(result.tokens > 0, true);
});

test("output is byte-identical for the same store, query and context", () => {
	const a = inject(BANK, { query: "background push" });
	const b = inject(BANK, { query: "background push" });
	assert.equal(a.text, b.text);
	assert.equal(a.tokens, b.tokens);
});

test("presentation follows kind then key, not retrieval score", () => {
	const result = inject(BANK, { query: "push github confirmation scores authority read" });
	const order = result.injected.map((hit) => hit.entry.kind);
	assert.deepEqual(order, [...order].sort((x, y) => kindIndex(x) - kindIndex(y)), "rules before procedures before facts, whatever recall scored");
});

test("one key produces exactly one line, no matter how many claims were recalled", () => {
	const result = inject(BANK, { query: "background navy dark grey" });
	const backgroundLines = result.text.split("\n").filter((line) => line.includes("] ui.background:"));
	assert.equal(backgroundLines.length, 1, "the active claim and its superseded twin cannot both reach the model");
	assert.match(backgroundLines[0]!, /Use dark grey/);
});

test("asking about a retired claim answers with the claim that replaced it", () => {
	const result = inject(BANK, { query: "navy" });
	assert.equal(result.injected.length, 1);
	assert.match(result.text, /\[preference · global · 2026-10-02\] ui\.background: Use dark grey for the UI background\. \(replaces knowledge\/ui\.md#ui\.background@2026-06-14\)/);
	assert.deepEqual(result.redirected.map((pair) => pair.from.heading), ["ui.background@2026-06-14"]);
	assert.equal(result.text.includes("navy"), false, "the retired wording is not quoted back");
});

test("a contested identity injects nothing and tells the model to ask", () => {
	const store = storeOf({
		"knowledge/ui.md": UI,
		"knowledge/appearance.md": `# appearance\n\n## ui.background\n- kind: preference\n- scope: global\n- asOf: 2026-09-01\n- status: active\nNavy blue background.\n`,
	});
	const result = inject(store, { query: "background" });
	assert.equal(result.injected.filter((hit) => hit.entry.key === "ui.background").length, 0);
	assert.equal(result.conflicts.length, 1);
	assert.match(result.text, /Contested — the store holds two live claims/);
	assert.match(result.text, /Ask the human which one stands; do not pick one\./);
});

test("a contested identity is still reported when recall only found one side", () => {
	const store = storeOf({
		"knowledge/ui.md": UI,
		"knowledge/appearance.md": `# appearance\n\n## ui.background\n- kind: preference\n- scope: global\n- asOf: 2026-09-01\n- status: active\nCharcoal wash on the panel chrome.\n`,
	});
	const hits = recall(store, "panel chrome");
	assert.deepEqual(hits.map((hit) => hit.entry.path), ["knowledge/appearance.md"], "only the rival is recalled");
	const result = inject(store, { query: "panel chrome" });
	assert.equal(result.conflicts.length, 1, "authority is a property of the store, not of what retrieval happened to find");
});

test("broken entries are considered, reported and never injected", () => {
	const store = storeOf({ "knowledge/git.md": GIT, "knowledge/broken.md": BROKEN });
	const result = inject(store, { query: "push confirmation github" });
	assert.equal(result.injected.some((hit) => hit.entry.path === "knowledge/broken.md"), false);
	const dropped = result.dropped.filter((drop) => drop.entry?.path === "knowledge/broken.md");
	assert.deepEqual(dropped.map((drop) => drop.reason).sort(), ["unkeyed", "unknown-identity"], "a keyed entry with an unusable scope is a different problem from a heading that is not a key at all");
	assert.match(result.text, /- \[rule · global · 2026-10-12\] git\.push:/);
});

test("a project-scoped claim is out of scope outside that project", () => {
	const inProject = inject(BANK, { query: "terminal text colour", context: { project: "rl-pi-extensions" } });
	assert.deepEqual(inProject.injected.map((hit) => hit.entry.key), ["ui.foreground"]);

	const elsewhere = inject(BANK, { query: "terminal text colour" });
	assert.equal(elsewhere.injected.length, 0);
	assert.deepEqual(elsewhere.outOfScope.map((drop) => drop.entry.key), ["ui.foreground"]);
});

test("a more specific scope shadows the global default instead of arguing with it", () => {
	const store = storeOf({
		"knowledge/ui.md": `# ui\n\n## ui.background\n- kind: preference\n- scope: global\n- asOf: 2026-01-01\nDark grey.\n`,
		"knowledge/finance.md": `# finance\n\n## ui.background\n- kind: preference\n- scope: project:money-manager\n- asOf: 2025-12-01\nNavy, for financial legibility.\n`,
	});
	const result = inject(store, { query: "background", context: { project: "money-manager" } });
	assert.deepEqual(result.injected.map((hit) => hit.entry.body), ["Navy, for financial legibility."]);
	assert.ok(result.dropped.some((drop) => drop.entry?.key === "ui.background" && drop.reason === "shadowed-by-scope"));
});

test("the token budget drops the tail and says so instead of going silent", () => {
	const result = inject(BANK, { query: "github confirmation grey off-white typecheck", context: { project: "rl-pi-extensions" }, budget: { total: 60 } });
	assert.ok(result.injected.length >= 2, "the budget trims the tail, it does not silence everything");
	assert.ok(result.entryTokens <= 60, `entry content stayed inside the budget (${result.entryTokens})`);
	assert.ok(result.tokens >= result.entryTokens, "tokens reports the whole text honestly, notes included");
	assert.ok(result.dropped.some((drop) => drop.reason === "budget"), "something was trimmed by the budget");
	assert.match(result.text, /Not injected this turn \(token budget\)/);
	const uncapped = inject(BANK, { query: "github confirmation grey off-white typecheck", context: { project: "rl-pi-extensions" } });
	assert.ok(uncapped.injected.length > result.injected.length, "and it would have been said without the cap");
});

test("a per-kind cap pushes out rules only, leaving other kinds in", () => {
	const uncapped = inject(BANK, { query: "push commit test typecheck npm", context: { project: "rl-pi-extensions" } });
	assert.ok(uncapped.injected.some((hit) => hit.entry.kind === "rule"));

	const capped = inject(BANK, { query: "push commit test typecheck npm", context: { project: "rl-pi-extensions" }, budget: { perKind: { rule: 0 } } });
	assert.equal(capped.injected.some((hit) => hit.entry.kind === "rule"), false);
	assert.ok(capped.injected.some((hit) => hit.entry.kind === "procedure"), "the procedure still fits");
});

test("the renderer adds no score — only the fields that actually decided", () => {
	const result = inject(BANK, { query: "push github" });
	for (const line of result.text.split("\n").filter((line) => line.startsWith("- ["))) {
		assert.match(line, /^- \[[a-z]+ · [^·]+ · \d{4}-\d{2}-\d{2}\] [a-z][a-z0-9._-]*: /, "kind · scope · asOf, and nothing numeric but the date");
	}
});

test("a body too long for one line is collapsed, not truncated mid-word", () => {
	const store = storeOf({ "knowledge/long.md": `# long\n\n## note.long\n- kind: fact\n- scope: global\n- asOf: 2026-01-01\n${"word ".repeat(200)}\n` });
	const result = inject(store, { query: "word" });
	assert.match(result.text, /\.\.\.\n$/);
	assert.ok(result.injected[0]!.entry.body.length > 300);
});

test("nothing matches, nothing is said", () => {
	const result = inject(BANK, { query: "xylophone" });
	assert.equal(result.text, "");
	assert.equal(result.considered, 0);
	assert.equal(result.tokens, 0);
});

test("estimateTokens is a stated estimate, monotonic and zero for empty", () => {
	assert.equal(estimateTokens(""), 0);
	assert.equal(estimateTokens("abcd"), 1);
	assert.equal(estimateTokens("abcde"), 2);
});

// ─── The two halves agree: what the gate accepted, the prompt shows ─────────

function applied(store: MemoryStore, plan: EditPlan): MemoryStore {
	const touched = new Set(plan.files.map((file) => file.path));
	const files: TopicFile[] = plan.files.map((file) => parseTopicFile(file.content, file.path));
	for (const [path, file] of store.byPath) if (!touched.has(path)) files.push(file);
	return buildStore(files);
}

test("an accepted resolution changes what the prompt says — end to end", () => {
	const store = storeOf({
		"knowledge/ui.md": UI,
		"knowledge/appearance.md": `# appearance\n\n## ui.background\n- kind: preference\n- scope: global\n- asOf: 2026-09-01\n- status: active\nNavy blue background.\n`,
	});
	const before = inject(store, { query: "background" });
	assert.match(before.text, /Contested/);

	const refused = decide(store, {
		file: "knowledge/ui.md",
		key: "ui.background",
		scope: "global",
		kind: "preference",
		body: "Charcoal.",
		asOf: "2026-11-01",
		revision: "2026-11-01",
	} satisfies WriteRequest);
	if (refused.kind !== "conflict") assert.fail("expected a conflict");

	const accepted = decide(store, {
		file: "knowledge/ui.md",
		key: "ui.background",
		scope: "global",
		kind: "preference",
		body: "Charcoal.",
		asOf: "2026-11-01",
		revision: "2026-11-01",
		resolve: "supersede",
		conflictId: refused.conflictId,
		note: "user picked charcoal",
	});
	if (accepted.kind !== "plan") assert.fail("expected a plan");

	const after = inject(applied(store, accepted.plan), { query: "background" });
	assert.equal(after.conflicts.length, 0);
	const line = after.text.split("\n").find((entry) => entry.includes("] ui.background:"))!;
	assert.match(line, /Charcoal\./);
	assert.equal(after.text.includes("Navy blue background."), false);
});

function kindIndex(kind: string): number {
	return ["rule", "procedure", "decision", "preference", "gotcha", "fact"].indexOf(kind);
}

test("the memoised corpus cannot change an answer", () => {
	const first = recall(BANK, "background grey");
	const second = recall(BANK, "background grey");
	const rebuilt = storeOf({ "knowledge/ui.md": UI, "knowledge/git.md": GIT, "knowledge/notes.md": NOTES });
	const fresh = recall(rebuilt, "background grey");
	assert.deepEqual(second.map((hit) => [hit.entry.key, hit.score]), first.map((hit) => [hit.entry.key, hit.score]));
	assert.deepEqual(fresh.map((hit) => [hit.entry.key, hit.score]), first.map((hit) => [hit.entry.key, hit.score]));
});
