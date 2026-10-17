import assert from "node:assert/strict";
import test from "node:test";

import { BM25_RANKER, bm25, claimRanker, createRanker, tokenize, type RankedText } from "./rank.ts";
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
	assert.deepEqual(tokenize("git-standards.branch-naming"), ["git", "standards", "branch", "naming"]);
	assert.deepEqual(tokenize("BM25 over key, aliases"), ["bm25", "over", "key", "aliases"]);
	assert.deepEqual(tokenize("node --test and C++"), ["node", "test", "and", "c"]);
	assert.deepEqual(tokenize(""), []);
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
