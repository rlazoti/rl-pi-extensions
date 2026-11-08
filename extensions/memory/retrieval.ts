/** Opt-in selection policy. Lexical recall remains available through memory_search. */
import { contentTerms, type MemoryIndex } from "./search.js";

export interface RetrievalConfig {
	mode: "legacy" | "balanced";
	minScorePerTerm: number;
	minRelativeScore: number;
	topicStickiness: boolean;
}
export const DEFAULT_RETRIEVAL: RetrievalConfig = { mode: "legacy", minScorePerTerm: 5, minRelativeScore: 0.25, topicStickiness: true };
export interface ContextHit { path: string; title: string; content: string; score: number }

export function relevanceReason(score: number, top: number, terms: number, config: RetrievalConfig): string | null {
	if (config.mode === "legacy") return null;
	if (score <= 0 || score < config.minScorePerTerm * Math.max(1, terms)) return "under per-content-term relevance floor";
	if (score < config.minRelativeScore * top) return "under relative relevance floor";
	return null;
}

/** Apply the same category admission/top-three cut as production, then a floor to
 * every slot, including rank one. No backfilling rejected slots with weaker hits.
 */
export function selectContext(index: MemoryIndex, query: string, limit: number,
	eligibility: { includeKnowledge: boolean; includeHistory: boolean }, config: RetrievalConfig, pathReason: (rel: string) => string | null = () => null) {
	const candidates = index.searchForContext(query, limit, undefined, { ...eligibility, filter: (rel) => !pathReason(rel) });
	const terms = new Set(contentTerms(query)).size;
	const top = candidates[0]?.score ?? 0;
	const rejected = new Map<string, string>();
	const hits = candidates.filter((hit) => {
		const reason = relevanceReason(hit.score, top, terms, config);
		if (reason) rejected.set(hit.path, reason);
		return !reason;
	});
	return { hits, rejected };
}

const SWITCH = /^\s*(?:switch(?:ing)?\s+topics?|new\s+(?:topic|question)|unrelated(?:\s+question)?|forget\s+(?:that|it))\s*[:.!,-]?\s*/i;
const REFERENCE = /\b(?:it|its|that|this|those|these|them|same)\b/i;
const ACKNOWLEDGEMENT = /^\s*(?:yes|yeah|ok(?:ay)?|continue|go ahead|do it|try again|proceed|and then)[.!?\s]*$/i;

export class TopicContext {
	private query = "";
	clear(): void { this.query = ""; }
	remember(query: string, hasHits: boolean): void { this.query = hasHits ? query : ""; }
	resolve(prompt: string, index: MemoryIndex, config: RetrievalConfig): { query: string; continuation: boolean } {
		if (config.mode === "legacy" || !config.topicStickiness || !prompt.trim()) return { query: prompt, continuation: false };
		if (SWITCH.test(prompt)) return { query: prompt.replace(SWITCH, ""), continuation: false };
		if (!REFERENCE.test(prompt) && !ACKNOWLEDGEMENT.test(prompt)) return { query: prompt, continuation: false };
		// A new named subject beats a pronoun: "does it work with Postgres?" must
		// not inherit yesterday's UI query. Rare exact title terms are a conservative
		// lexical signal, not a synonym model or proof of the author's intent.
		const asked = new Set(contentTerms(prompt)), previous = new Set(contentTerms(this.query));
		const leading = index.search(prompt, 1)[0];
		const newTitleTerms = leading ? [...new Set(contentTerms(leading.title))].filter((t) => asked.has(t) && !previous.has(t)) : [];
		const namedSubject = newTitleTerms.length >= 2 || newTitleTerms.some((term) =>
			index.search(term, index.documentCount).length <= Math.max(1, Math.floor(index.documentCount * 0.1)));
		return namedSubject ? { query: prompt, continuation: false } : { query: this.query, continuation: true };
	}
}
