import assert from "node:assert/strict";
import test from "node:test";

import { BM25_RANKER, MIN_SCORE_SHARE, bm25, claimRanker, createRanker, stem, tokenize, type RankedText } from "./rank.ts";
import type { Claim } from "./grammar.ts";

function claim(key: string, body: string, overrides: Partial<Claim> = {}): Claim {
	return {
		key,
		kind: "rule",
		scope: "global",
		asOf: "2026-01-01",
		source: "a test",
		body,
		aliases: [],
		tags: [],
		links: [],
		origin: "agent",
		state: "approved",
		...overrides,
	};
}

function text(key: string, extra: Partial<RankedText> = {}): RankedText {
	return { key, scope: "global", kind: "rule", body: "", aliases: [], tags: [], links: [], ...extra };
}

test("rank: tokenizing splits keys and words, and keeps the useful ones", () => {
	// Stopwords are gone and what is left is stemmed, so a plural and a singular
	// land on the same term (R32.1).
	assert.deepEqual(tokenize("git-standards.branch-naming"), ["git", "standard", "branch", "nam"]);
	assert.deepEqual(tokenize("BM25 key, aliases"), ["bm25", "key", "alias"]);
	assert.deepEqual(tokenize("node --test C++"), ["nod", "test", "c"]);
	assert.deepEqual(tokenize(""), []);
	assert.deepEqual(tokenize("the rules are named"), ["rul", "nam"]);
});

test("rank: the stopword list has no holes in the words a prompt actually says", () => {
	// An alphabetical list loses a word whenever a neighbour is edited, and a
	// missing "is" is enough to rank a bank by grammar (R32.1).
	const words = "a an the and but or nor if then else when while where why how who whom whose which what that this these those there here is are was were be been being am do does did doing have has had having will would shall should can could may might must ought to of from in on at by for with within without into onto over under above below between through during before after again once no not only own same so than too very just also about as like though although whether unless until since each every all any both few more most some such he him his she her hers it its they them their theirs mine ours yours whoever whatever whichever".split(/\s+/);
	assert.ok(words.length > 100);
	for (const word of words) {
		assert.deepEqual(tokenize(word), [], `"${word}" is a stopword and must never be a search term`);
	}
});

test("rank: stemming folds a word family onto one term and leaves the rest alone", () => {
	for (const family of [["branch", "branches", "branched", "branching"], ["name", "names", "named", "naming"], ["use", "uses", "used", "using"], ["log", "logs", "logged", "logging"], ["commit", "commits", "committed", "committing"], ["rule", "rules", "ruled", "ruling"], ["message", "messages", "messaged"], ["entry", "entries"], ["address", "addresses", "addressed"]]) {
		const stems = family.map(stem);
		assert.deepEqual(stems, stems.map(() => stems[0]!), `${family.join("/")} all stem to "${stems[0]}"`);
	}
	// A word that only looks like it has a suffix keeps its shape (R32.1).
	for (const word of ["status", "alias", "class", "address", "index", "business"]) {
		assert.equal(stem(word), word, `"${word}" must not lose its final s`);
	}
	assert.equal(stem("bus"), "bus");
	assert.equal(stem("bias"), "bias");
});

test("rank: stopwords decide nothing, in a query or in a claim (R32.1)", () => {
	// The three queries the review reports, as a table: a query and the keys in order.
	const corpus = [
		text("git.flow", { body: "Branches are named rl-MM-DD-topic, then squash merged.", tags: ["git"] }),
		text("banking.wire.local", { kind: "fact", body: "A local Canadian wire transfer is a PDF form at the teller, not an API call." }),
		text("tmux.status-substitution", { kind: "fact", body: "tmux evaluates a status format only while a client is attached." }),
		text("style.commits", { body: "Commit messages use the imperative mood; the body gives the reason.", tags: ["git"] }),
	];
	const keysFor = (query: string): string[] => bm25(query, corpus).map((hit) => hit.entry.key);
	const table: [string, string[]][] = [
		["what is the branch naming rule", ["git.flow"]],
		["branch naming", ["git.flow"]],
		["how do I name a branch", ["git.flow"]],
		["wire transfers", ["banking.wire.local"]],
		["commit messages", ["style.commits"]],
		["is it good now?", []],
		["can you check what is in the logs for this?", []],
		["yes", []],
		["ok do it", []],
		["do it now, please", []],
	];
	for (const [query, expected] of table) {
		assert.deepEqual(keysFor(query), expected, `"${query}"`);
	}
});

test("rank: a hit below a quarter of the top hit is not a hit (D20)", () => {
	const corpus = [
		text("git.flow", { body: "branch naming rule, the branch naming rule for branches" }),
		text("weak.match", { body: "one rule, and a great many other words that carry nothing to do with the query at all, none whatsoever" }),
		text("mid.match", { body: "a branch, said once among many other unrelated words here" }),
	];
	const query = "branch naming rule";
	const unfloored = bm25(query, corpus, { minShare: 0 });
	const floored = bm25(query, corpus);
	assert.equal(unfloored.length, 3, "every claim matches a query term, so without the floor all three are hits");
	const top = unfloored[0]!.score;
	assert.deepEqual(floored.map((hit) => hit.entry.key), unfloored.filter((hit) => hit.score >= MIN_SCORE_SHARE * top).map((hit) => hit.entry.key));
	assert.ok(floored.length < unfloored.length, "the floor stops at least one weak hit");
	for (const hit of floored) assert.ok(hit.score >= MIN_SCORE_SHARE * top, `${hit.entry.key} is at or above the floor`);
	// A lone weak hit survives: the floor is a share of the top hit, never a floor
	// on the score itself, which would scale with the size of the bank.
	const lone = bm25("branch", [text("weak.match", { body: "one branch among many other words that mean nothing here at all whatsoever" })]);
	assert.deepEqual(lone.map((hit) => hit.entry.key), ["weak.match"]);
	assert.equal(MIN_SCORE_SHARE, 0.25);
});

test("rank: a hit in the key beats a hit in the body", () => {
	const scored = bm25("branch naming", [
		text("rl.branch-naming", { body: "talks about many things including a branch once" }),
		text("git.flow", { body: "the branch naming convention is written out here" }),
	]);
	assert.equal(scored.length, 2);
	assert.equal(scored[0]!.entry.key, "rl.branch-naming");
	assert.ok(scored[0]!.score > scored[1]!.score);
});

test("rank: an unrelated claim scores nothing and is left out (R35)", () => {
	const scored = bm25("ledger entries", [text("ledger.debit-first", { body: "debits come before credits in every ledger entry" }), text("macos.ram", { body: "the memory pressure widget lives in the menu bar" })]);
	assert.deepEqual(scored.map((hit) => hit.entry.key), ["ledger.debit-first"]);
	assert.deepEqual(bm25("nothing matches this at all", [text("ledger.debit-first", { body: "debits before credits" })]), []);
	assert.deepEqual(bm25("", [text("a", { body: "x" })]), []);
	assert.deepEqual(bm25("x", []), []);
});

test("rank: aliases and tags are searchable fields", () => {
	const withAlias = bm25("rodrigo preference", [text("style.commits", { aliases: ["rodrigo preference"], body: "imperative mood" })]);
	assert.equal(withAlias.length, 1);
	const withTag = bm25("git", [text("style.commits", { tags: ["git"], body: "imperative mood" })]);
	assert.equal(withTag.length, 1);
});

test("rank: ties break by key and scope, so the order never depends on iteration", () => {
	const a = bm25("ledger", [text("b.two", { body: "ledger" }), text("a.one", { body: "ledger" })]);
	assert.deepEqual(a.map((hit) => hit.entry.key), ["a.one", "b.two"]);
	const first = bm25("ledger", [text("b.two", { body: "ledger" }), text("a.one", { body: "ledger" })]);
	const second = bm25("ledger", [text("a.one", { body: "ledger" }), text("b.two", { body: "ledger" })]);
	assert.deepEqual(first.map((hit) => hit.entry.key), second.map((hit) => hit.entry.key));
});

test("rank: a rare term outranks a term the whole bank shares", () => {
	const corpus = [
		text("macos.ram", { body: "memory pressure widget" }),
		text("ledger.debit", { body: "memory is cheap, debits are not" }),
		text("pi.memory", { body: "the memory extension writes claims" }),
	];
	const scored = bm25("cheap memory", corpus);
	assert.equal(scored[0]!.entry.key, "ledger.debit", "the doc matching the rare word wins");
});

test("rank: the claim ranker returns claims, not text", () => {
	const claims = [claim("ledger.debit-first", "debits before credits"), claim("macos.ram", "memory pressure widget")];
	const scored = claimRanker("bm25").rank("debit credits", claims);
	assert.equal(scored.length, 1);
	assert.equal(scored[0]!.entry.key, "ledger.debit-first");
	assert.ok(scored[0]!.score > 0);
});

test("rank: the named ranker is chosen, and an unknown name is reported", () => {
	assert.equal(BM25_RANKER.name, "bm25");
	assert.deepEqual(createRanker("bm25"), { ranker: BM25_RANKER, known: true });
	const fallback = createRanker("semantic");
	assert.equal(fallback.ranker, BM25_RANKER);
	assert.equal(fallback.known, false, "the injector reports the fallback instead of pretending");
});
