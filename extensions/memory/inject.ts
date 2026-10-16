/**
 * Candidate recall and prompt injection (Phase 4).
 *
 * Retrieval picks candidates. It does **not** decide what is true: authority
 * belongs to `resolver.ts`, and this module only chooses which entries are worth
 * asking about, then asks the resolver about them. That split is the whole point
 * of the component — the old memory bank injected whatever ranked highest, which
 * made three indistinguishable files all reach the model at once.
 *
 * Pure again: no filesystem, no clock, no pi. Byte-identical output for a given
 * store + query + context, which is what makes the golden-text tests here mean
 * something.
 *
 * Why the scorer is in this file and not a package: the real bank measures 8
 * files / 24 KB / ~22 knowledge headings, so "indexing" here means scanning a few
 * hundred entries in about a third of a millisecond. A real inverted index would
 * buy latency we do not need and add a cache that can go stale — the same failure
 * class this component exists to remove. MiniSearch (used by the live extension)
 * and qmd (1–2 s hybrid search, already too slow for per-turn injection there)
 * are both larger commitments than a sub-millisecond scan with a documented
 * scoring function. `scripts/bench-recall.mjs` prints the measured curve rather
 * than asserting it: 50 / 200 / 1000 / 5000 entries.
 */

import {
	ENTRY_KINDS,
	scopeKey,
	type EntryKind,
	type MemoryEntry,
} from "./schema.js";
import {
	planInjection,
	type AuthorityResolution,
	type DroppedEntry,
	type InjectionHit,
	type MemoryStore,
	type ScopeContext,
	type ShadowedEntry,
	type ShadowReason,
} from "./resolver.js";

// ─── Recall: BM25 over entries ──────────────────────────────────────────────

/** BM25 parameters, pinned rather than tuned per query. */
const K1 = 1.2;
const B = 0.75;
/** A term in the heading/key counts this much more than a term in the body: the
 *  heading *is* the assertion, so matching it is stronger evidence of relevance
 *  than finding the word somewhere in the prose. */
const HEADING_WEIGHT = 3;

const STOPWORDS: ReadonlySet<string> = new Set([
	"a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does",
	"for", "from", "has", "have", "how", "i", "if", "in", "is", "it", "its",
	"me", "my", "of", "on", "or", "so", "that", "the", "their", "them", "then",
	"there", "these", "they", "this", "to", "too", "up", "us", "was", "we",
	"were", "what", "when", "where", "which", "who", "why", "will", "with", "you",
	"your",
]);

/** Lowercase, split on anything that is not a word character, stopword-free.
 *  Deliberately no stemming: a wrong stem is invisible in the output. */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter((term) => term.length > 1 && !STOPWORDS.has(term));
}

interface DocStats {
	tf: Map<string, number>;
	length: number;
}

interface Corpus {
	docs: DocStats[];
	df: Map<string, number>;
	averageLength: number;
}

/**
 * Corpus statistics are memoised against the store object itself: a new store is
 * a new key, so there is no invalidation rule to get wrong and no on-disk index
 * to go stale — the failure class this component exists to remove. Measured cost
 * without it: ~0.4 ms per turn at 50 entries, ~1.3 ms at 200, ~6.6 ms at 1000.
 */
const corpusCache = new WeakMap<MemoryStore, Corpus>();

function corpusOf(store: MemoryStore): Corpus {
	const cached = corpusCache.get(store);
	if (cached) return cached;
	const docs = store.entries.map((entry) => docStats(entry));
	const df = new Map<string, number>();
	for (const doc of docs) {
		for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
	}
	const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length;
	const corpus = { docs, df, averageLength };
	corpusCache.set(store, corpus);
	return corpus;
}

function docStats(entry: MemoryEntry): DocStats {
	const tf = new Map<string, number>();
	const add = (term: string, weight: number): void => {
		tf.set(term, (tf.get(term) ?? 0) + weight);
	};

	for (const term of tokenize(`${entry.key} ${entry.heading}`)) add(term, HEADING_WEIGHT);
	for (const term of tokenize(entry.body)) add(term, 1);

	let length = 0;
	for (const weight of tf.values()) length += weight;
	return { tf, length };
}

export interface Candidate {
	entry: MemoryEntry;
	score: number;
	/** Query terms this entry matched — the answer to "why was this injected?". */
	matched: string[];
}

/**
 * BM25 over the store's entries. Query terms are treated as a **set**: repeating
 * a word in a prompt must not make an entry look more relevant.
 *
 * Metadata words (`rule`, `global`, `active`, dates) are not scored, so a scope
 * or status string cannot drag an unrelated entry into the prompt.
 */
export function recall(store: MemoryStore, query: string, limit = 12): Candidate[] {
	const queryTerms = [...new Set(tokenize(query))];
	if (queryTerms.length === 0 || store.entries.length === 0 || limit <= 0) return [];

	const { docs, df: documentFrequency, averageLength } = corpusOf(store);
	const docCount = docs.length;

	const candidates: Candidate[] = [];
	for (let index = 0; index < store.entries.length; index++) {
		const doc = docs[index]!;
		let score = 0;
		const matched: string[] = [];
		for (const term of queryTerms) {
			const tf = doc.tf.get(term);
			if (!tf) continue;
			const df = documentFrequency.get(term) ?? 1;
			const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
			score += idf * ((K1 + 1) * tf) / (tf + K1 * (1 - B + B * (doc.length / averageLength)));
			matched.push(term);
		}
		if (score > 0) candidates.push({ entry: store.entries[index]!, score, matched });
	}

	// Deterministic: score, then key, then heading, then path. A scorer tweak can
	// shuffle relevance order, but never produce a different store of the same
	// scores.
	candidates.sort(
		(a, b) =>
			b.score - a.score ||
			a.entry.key.localeCompare(b.entry.key) ||
			a.entry.heading.localeCompare(b.entry.heading) ||
			a.entry.path.localeCompare(b.entry.path),
	);
	return candidates.slice(0, limit);
}

// ─── Token budget ───────────────────────────────────────────────────────────

/** Characters / 4, rounded up. An estimate, stated as one, never a tokenizer. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export interface Budget {
	total: number;
	perKind: Partial<Record<EntryKind, number>>;
}

/**
 * Kind order decides presentation, retrieval order decides consideration. Rules
 * first because they are the entries that change what the agent does; facts last
 * because they are the entries the model is most likely to survive without.
 */
export const PRESENTATION_ORDER: readonly EntryKind[] = ["rule", "procedure", "decision", "preference", "gotcha", "fact"] as const;

export const DEFAULT_BUDGET: Budget = {
	total: 900,
	perKind: { rule: 260, procedure: 160, decision: 160, preference: 160, gotcha: 140, fact: 120 },
};

// ─── Injection ──────────────────────────────────────────────────────────────

/** Why a considered entry did not make it into the prompt. */
export type DropReason = "budget" | DroppedEntry["reason"] | ShadowReason;

export interface InjectionOptions {
	query: string;
	context?: ScopeContext;
	budget?: Partial<Budget>;
	/** How many candidates recall may consider. */
	limit?: number;
}

export interface Injection {
	/** The prompt text. Empty string when there is nothing worth saying. */
	text: string;
	injected: Array<{ entry: MemoryEntry; matched: string[] }>;
	redirected: Array<{ from: MemoryEntry; to: MemoryEntry }>;
	/** Identities with no answer because the store holds two live claims. */
	conflicts: AuthorityResolution[];
	/** Everything considered and not injected, with the real reason. */
	dropped: Array<{ entry: MemoryEntry | null; reason: DropReason }>;
	/** Real authorities that exist but do not apply in this context. */
	outOfScope: ShadowedEntry[];
	considered: number;
	/** Tokens spent on entry content — the part the budget governs. */
	entryTokens: number;
	/** Tokens of the whole rendered text, notes and header included. */
	tokens: number;
}

export function inject(store: MemoryStore, options: InjectionOptions): Injection {
	const budget: Budget = { total: options.budget?.total ?? DEFAULT_BUDGET.total, perKind: { ...DEFAULT_BUDGET.perKind, ...options.budget?.perKind } };
	const candidates = recall(store, options.query, options.limit ?? 12);
	const plan = planInjection(store, candidates.map((candidate) => candidate.entry), options.context ?? {});
	const matched = new Map<string, string[]>();
	for (const candidate of candidates) matched.set(`${candidate.entry.path}#${candidate.entry.heading}`, candidate.matched);

	// Presentation order: kind, then key. Retrieval order decides what is
	// considered; it never decides the order the model reads them in.
	const ordered = [...plan.inject].sort((a, b) => kindRank(a.entry.kind) - kindRank(b.entry.kind) || a.entry.key.localeCompare(b.entry.key));

	const injected: Injection["injected"] = [];
	const lines: string[] = [];
	const dropped: Injection["dropped"] = [];
	const usedPerKind = new Map<EntryKind, number>();
	let used = 0;

	const overBudget: InjectionHit[] = [];
	for (const hit of ordered) {
		// Cost the line exactly as it will be rendered, budget note included.
		const line = renderLine(hit);
		const cost = estimateTokens(line);
		const kindCap = budget.perKind[hit.entry.kind];
		const kindUsed = usedPerKind.get(hit.entry.kind) ?? 0;
		// Skip what does not fit, keep looking: one long rule must not silently
		// delete every shorter entry behind it.
		if (used + cost > budget.total || (kindCap !== undefined && kindUsed + cost > kindCap)) {
			dropped.push({ entry: hit.entry, reason: "budget" });
			overBudget.push(hit);
			continue;
		}
		used += cost;
		usedPerKind.set(hit.entry.kind, kindUsed + cost);
		injected.push({ entry: hit.entry, matched: matched.get(`${hit.entry.path}#${hit.entry.heading}`) ?? [] });
		lines.push(line);
		// A redirected-from claim is already reported by the resolver as a
		// suppression; reporting it twice would make the count of "what was
		// considered" disagree with itself.
	}

	for (const entry of plan.suppressed) dropped.push({ entry: entry.entry, reason: entry.reason });
	for (const entry of plan.shadowed) dropped.push({ entry: entry.entry, reason: entry.reason });

	const text = renderText(lines, plan.conflicts, overBudget, plan.shadowed, options.context);
	return {
		text,
		injected,
		redirected: plan.inject.filter((hit) => hit.redirectedFrom).map((hit) => ({ from: hit.redirectedFrom!, to: hit.entry })),
		conflicts: plan.conflicts,
		dropped,
		outOfScope: plan.shadowed.filter((entry) => entry.reason === "out-of-scope"),
		considered: candidates.length,
		entryTokens: used,
		tokens: estimateTokens(text),
	};
}

function kindRank(kind: EntryKind): number {
	const index = PRESENTATION_ORDER.indexOf(kind);
	return index === -1 ? ENTRY_KINDS.length + ENTRY_KINDS.indexOf(kind) : index;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

/**
 * One line per authority: `kind · scope · asOf` — the fields that actually
 * decided — and never a score. The old `(score: 2176)` labels read as authority
 * and measured nothing of the kind.
 */
export function renderLine(hit: InjectionHit): string {
	const entry = hit.entry;
	const parts = [
		`- [${entry.kind} · ${scopeKey(entry.scope)}`,
		entry.asOf ? ` · ${entry.asOf}]` : "]",
		` ${entry.key}: ${collapse(entry.body)}`,
	];
	if (hit.redirectedFrom) parts.push(` (replaces ${hit.redirectedFrom.path}#${hit.redirectedFrom.heading})`);
	return parts.join("");
}

function renderText(
	injectedLines: readonly string[],
	conflicts: AuthorityResolution[],
	overBudget: readonly InjectionHit[],
	shadowed: ShadowedEntry[],
	context: ScopeContext = {},
): string {
	if (injectedLines.length === 0 && conflicts.length === 0) return "";

	const lines = [`## Memory — authoritative for this context${context.project ? ` (project: ${context.project})` : ""}`];
	lines.push(...injectedLines);

	if (conflicts.length > 0) {
		lines.push("");
		lines.push("Contested — the store holds two live claims, so nothing was injected for these:");
		for (const conflict of conflicts) {
			const where = conflict.dropped.map((drop) => `${drop.entry.path}#${drop.entry.heading}`).join(", ");
			lines.push(`- ${conflict.key} in scope ${scopeKey(conflict.scope)} (${where}). Ask the human which one stands; do not pick one.`);
		}
	}

	if (overBudget.length > 0) {
		lines.push("");
		lines.push(`Not injected this turn (token budget): ${overBudget.map((drop) => drop.entry?.key ?? "(unknown)").join(", ")}.`);
	}
	if (shadowed.length > 0) {
		lines.push(`Shadowed by a more specific scope: ${shadowed.map((drop) => `${drop.entry.key} (${drop.reason})`).join(", ")}.`);
	}

	return `${lines.join("\n")}\n`;
}

function collapse(body: string): string {
	const oneLine = body.replace(/\s+/g, " ").trim();
	return oneLine.length > 300 ? `${oneLine.slice(0, 297)}...` : oneLine;
}
