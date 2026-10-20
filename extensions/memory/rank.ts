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
 *
 * Two rules make that question answerable at all (R32.1, R32.2): the words are
 * compared after stopwords are dropped and inflections are folded, and a claim
 * far behind the best one is not a hit. Without the first, "what is the branch
 * naming rule" is a query about "is"; without the second, everything that shares
 * any word with any request is a candidate.
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

/**
 * Function words and back-channel words: they say how a sentence is built, not
 * what it is about (R32.1).
 *
 * They are removed from the query and from the claims. Left in, they decide
 * retrieval, because a bank of prose contains "is", "the" and "for" almost
 * everywhere and BM25 cannot tell a term that appears everywhere from one that
 * means something. A probe on four claims ranked the Wire fact above the branch
 * rule for "what is the branch naming rule", matched only on "is", and "is it
 * good now?" retrieved a tmux fact.
 *
 * This is an English list, not a language detector: memory has one human and one
 * language, and a second-language ranker is the `Ranker` seam's job (R32).
 */
const STOPWORDS = new Set(
	(
		// The English function words: pronouns, copulas, auxiliaries, articles,
		// determiners, prepositions, conjunctions, question words. Built from the
		// standard 179-word English stop list, de-duplicated, with the contractions
		// that survive word-splitting ("don't" splits to "don").
		"a about above across after again against all almost along already although always am among an and another any anybody anyone anything are around as at away be because been before being below beside between both but by came can could did do does doing done down during each either else enough even ever every everyone everything except few first for from further get gets getting given go goes going had has have having hence her here hers herself him himself his how however i if in inside instead into is it its itself just like made many maybe me might more most much must my myself neither never nobody none nor not nothing now of off on once one only onto or other others ought our ours ourselves out over per perhaps rather same say she should since so some somebody someone something still such than that the their theirs them themselves then thence there therefore these they thing things this those though through throughout thus to together too toward towards under unless until unto up upon us very via was we well were what whatever when whence where wherefore whether which while whoever whom whose why will within without would yet you your yours yourself yourselves " +
		"ain aren cant couldnt didnt doesnt hadn hasnt haven isnt isnt ma mightn shan shouldnt wasnt werent wont wouldnt dont dont " +
		// Checked against a must-stop table in rank.test.ts, because an alphabetical
		// list loses a word the moment a neighbour is edited: "with" and "who" both
		// went missing that way, and "is" survived a first pass.
		"cannot he him his who whoever whichever whom whose thereof shall may might would with no nor own also mine ours theirs yours " +
		// Back-channel: a reply to a question, not a question about a topic. With
		// these removed, "yes" and "ok do it" have no term left to match, which is
		// the answer: a turn that asks for nothing recalls nothing.
		"hmm okay ok yeah yep yup nope nah hey hi hello yo please thanks thank sorry cheers wow " +
		// Fillers that carry a request's tone and none of its subject.
		"uh um eh btw tbh im ive id ill youre youve weve theyre"
	)
		.split(/\s+/)
		.filter((word) => word !== ""),
);

/** Two of the same consonant at the end of a stem: "logged" and "log" are one word. */
const DOUBLED_CONSONANT = /(bb|dd|ff|gg|mm|nn|pp|rr|tt)$/;
/** Endings where a final `s` is the word's spine, not a plural: "status", "alias". */
const S_IS_NOT_A_PLURAL = /(ss|us|is|as|os)$/;

/**
 * Light suffix folding (R32.1): plural `-s`/`-es`, `-ing`, `-ed`, `-ies`, and a
 * silent final `e`.
 *
 * Enough for the shapes one word really takes in a claim ("Branches" against a
 * query for "branch", which left the branch rule unfindable before this), and no
 * further: a full Porter stemmer turns "transfers" into "transf" and buys errors
 * this component cannot see, because it has no corpus to test them against.
 */
export function stem(word: string): string {
	let w = word;
	if (w.length > 3 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
	else if (w.length > 4 && w.endsWith("es")) w = w.slice(0, -2);
	else if (w.length > 3 && w.endsWith("s") && !S_IS_NOT_A_PLURAL.test(w)) w = w.slice(0, -1);
	for (const suffix of ["ing", "ed"] as const) {
		if (!w.endsWith(suffix) || w.length <= suffix.length + 1) continue;
		const base = w.slice(0, -suffix.length);
		// "planned" and "plan" are one word; "use" and "used" are one word, and a
		// two-letter base needs its `e` back to meet the singular form.
		if (DOUBLED_CONSONANT.test(base)) w = base.slice(0, -1);
		else if (base.length >= 3) w = base;
		else if (base.length === 2) w = `${base}e`;
	}
	if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
	return w;
}

/** A stopword is a stopword before and after folding: "having" folds to "hav". */
const STOPPED = new Set<string>([...STOPWORDS, ...[...STOPWORDS].map(stem)]);

/**
 * The terms a query and a claim are compared on: lowercase, folded, and with
 * nothing in the list above (R32, R32.1).
 */
export function tokenize(text: string): string[] {
	return (text.toLowerCase().match(WORD) ?? [])
		.filter((token) => (token.length > 1 || token === "c" || token === "x") && !STOPPED.has(token))
		.map(stem)
		.filter((token) => !STOPPED.has(token) && token.length > 0);
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
	/**
	 * How close to the best hit a claim must be to count as a hit at all
	 * (D20, R32.2). A share of the top score, never an absolute score: BM25 scores
	 * grow with the size of the bank and the length of the documents, so a fixed
	 * number good for 40 claims is wrong for 200.
	 */
	minShare?: number;
}

/**
 * D20: a claim is a hit when it scores at least this share of the best hit.
 *
 * Stopwords explain why a turn retrieved the wrong claims; they do not explain
 * why a claim at 18% of the top hit should cost tokens. The share cuts that tail
 * and keeps everything a reader would call related: over 12 queries against a
 * 20-claim bank every second-place claim a person wanted scored 25% or more, and
 * the noise sat between 14% and 23%. One hit on its own always survives, because
 * it is 100% of itself.
 */
export const MIN_SCORE_SHARE = 0.25;

/**
 * Score a corpus against a query. Documents with no query term in common score
 * nothing and are left out entirely: an unrelated claim must not be injected
 * just because the budget has room (R35). A query made only of stopwords has no
 * term to match, so it retrieves nothing (R32.1), and a claim far behind the top
 * hit is dropped by the floor (R32.2).
 */
export function bm25(query: string, entries: RankedText[], options: Bm25Options = {}): Scored<RankedText>[] {
	const k1 = options.k1 ?? 1.4;
	const b = options.b ?? 0.75;
	const minShare = options.minShare ?? MIN_SCORE_SHARE;
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
	const ranked = scored.sort((a, b2) => b2.score - a.score || rankKey(a.entry).localeCompare(rankKey(b2.entry)));
	if (minShare <= 0 || ranked.length < 2) return ranked;
	const floor = ranked[0]!.score * minShare;
	return ranked.filter((hit) => hit.score >= floor);
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
