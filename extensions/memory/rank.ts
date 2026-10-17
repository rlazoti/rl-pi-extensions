/**
 * Retrieval (R32): a `Ranker` interface and one implementation, BM25 over key,
 * aliases, tags and body.
 *
 * The interface is the point. Nothing in this component knows how a ranker
 * scores: a semantic ranker would be a second `rank()` beside this one, chosen
 * by `config.ranker`, with no changes to injection, eligibility or the budget.
 *
 * BM25 is here because it needs no model, no network and no dependency, and it
 * answers the question the injector actually asks — "which claims use the words
 * of this request?" — well enough to be worth the tokens.
 */

import type { Claim } from "./grammar.js";

export interface Scored<T> {
	entry: T;
	score: number;
}

export interface Ranker<T = RankedText> {
	name: string;
	rank(query: string, entries: T[]): Scored<T>[];
}

/** The text a ranker can see for one claim. */
export interface RankedText {
	key: string;
	scope: string;
	kind: string;
	body: string;
	aliases: string[];
	tags: string[];
	links: string[];
}

const WORD = /[\p{L}\p{N}_]+/gu;

export function tokenize(text: string): string[] {
	return (text.toLowerCase().match(WORD) ?? []).filter((token) => token.length > 1 || token === "c" || token === "x" || token === "i");
}

/** Field weights: a hit in the key is worth more than a hit in the body. */
const WEIGHTS = { key: 3, aliases: 2, tags: 2, body: 1 } as const;

interface Document {
	entry: RankedText;
	terms: Map<string, number>;
	length: number;
}

function documentFor(entry: RankedText): Document {
	const terms = new Map<string, number>();
	const add = (text: string, weight: number): void => {
		for (const token of tokenize(text)) terms.set(token, (terms.get(token) ?? 0) + weight);
	};
	add(entry.key, WEIGHTS.key);
	for (const alias of entry.aliases) add(alias, WEIGHTS.aliases);
	for (const tag of entry.tags) add(tag, WEIGHTS.tags);
	add(entry.body, WEIGHTS.body);
	let length = 0;
	for (const count of terms.values()) length += count;
	return { entry, terms, length };
}

export interface Bm25Options {
	k1?: number;
	b?: number;
}

/**
 * Score a corpus against a query. Documents with no query term in common score
 * nothing and are left out entirely: an unrelated claim must not be injected
 * just because the budget has room (R35).
 */
export function bm25(query: string, entries: RankedText[], options: Bm25Options = {}): Scored<RankedText>[] {
	const k1 = options.k1 ?? 1.4;
	const b = options.b ?? 0.75;
	const docs = entries.map(documentFor);
	if (docs.length === 0) return [];
	const avg = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length;
	const queryTerms = [...new Set(tokenize(query))];
	if (queryTerms.length === 0) return [];

	// idf over this corpus only: the corpus is one bank, not the web.
	const idf = new Map<string, number>();
	for (const term of queryTerms) {
		const containing = docs.filter((doc) => doc.terms.has(term)).length;
		if (containing === 0) continue;
		idf.set(term, Math.log(1 + (docs.length - containing + 0.5) / (containing + 0.5)));
	}

	const scored: Scored<RankedText>[] = [];
	for (const doc of docs) {
		let score = 0;
		for (const term of queryTerms) {
			const weight = idf.get(term);
			const tf = doc.terms.get(term);
			if (weight === undefined || tf === undefined) continue;
			score += weight * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / (avg || 1)))));
		}
		if (score > 0) scored.push({ entry: doc.entry, score });
	}
	return scored.sort((a, b2) => b2.score - a.score || rankKey(a.entry).localeCompare(rankKey(b2.entry)));
}

function rankKey(entry: RankedText): string {
	return `${entry.key}\u0000${entry.scope}`;
}

/** Adaptation from claims to rankable text, and back to the claim that scored. */
export function textOf(claim: Claim): RankedText {
	return { key: claim.key, scope: claim.scope, kind: claim.kind, body: claim.body, aliases: claim.aliases, tags: claim.tags, links: claim.links };
}

export function claimRanker(name: string, options: Bm25Options = {}): Ranker<Claim> {
	return {
		name,
		rank(query: string, entries: Claim[]): Scored<Claim>[] {
			const text = entries.map(textOf);
			const byText = new Map(text.map((item, index) => [rankKey(item), entries[index]!]));
			return bm25(query, text, options).map((scored) => ({ entry: byText.get(rankKey(scored.entry))!, score: scored.score }));
		},
	};
}

/** The ranker a session uses, by name. Unknown names fall back to BM25 at the call site. */
export const BM25_RANKER: Ranker<Claim> = claimRanker("bm25");

export function createRanker(name: string): { ranker: Ranker<Claim>; known: boolean } {
	if (name === "bm25" || name === "") return { ranker: BM25_RANKER, known: true };
	return { ranker: BM25_RANKER, known: false };
}
