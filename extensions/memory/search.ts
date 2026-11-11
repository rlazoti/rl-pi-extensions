/**
 * Memory Search — MiniSearch-powered full-text search over the memory bank.
 *
 * Builds an in-memory index of all .md files in the memory bank on session start.
 * Provides fuzzy BM25 search for:
 *   1. Automatic knowledge injection in before_agent_start (replaces trigger words)
 *   2. Explicit memory_search tool for agent-driven recall
 *
 * The index is rebuilt from disk on session start and updated incrementally
 * when memory_update or memory_append write files.
 */

import MiniSearch from "minisearch";
import * as fs from "node:fs";
import * as path from "node:path";
import { isMarkdownPath, resolveBankPath } from "./paths.js";
import { createHash } from "node:crypto";

export interface MemoryDocument {
	id: string;       // relative path from memory root (e.g. "knowledge/git-rules.md")
	title: string;    // extracted from first heading or filename
	content: string;  // full file content
	category: string; // "core" | "knowledge" | "history"
}

export interface SearchResult {
	path: string;
	title: string;
	score: number;
	snippet: string;
	category: string;
}

/** Extract title from markdown content — first heading or fallback to filename */
export function extractTitle(content: string, filename: string): string {
	const match = content.match(/^#{1,3}\s+(.+)/m);
	return match?.[1]?.trim() ?? filename.replace(/\.md$/i, "");
}

/*
 * English function words, dropped from queries only.
 *
 * A knowledge file enters a prompt when it scores above zero, and these words are in
 * every prompt and in nearly every file, so "the" in a body was enough to admit a whole
 * decision: measured on an unrelated-prompt table, 15 files went in, and the causes were
 * `the`, `do`, `a`, `my`, `for`, `what`, plus prefix runs from them (`for` found `form`,
 * `does` found `do`, `one` found `on`).
 *
 * The list is closed-class on purpose. Content words that look generic — `file`, `write`,
 * `time`, `use` — stay, because they are sometimes the word a person means, and a list
 * that grows by adding nouns eventually drops the word the user needed. Alias wording was
 * measured as an alternative cause and is not one: rewriting six alias lists to rarer
 * phrases changed nothing (15 files in, same recall).
 *
 * Dropped at query time, not index time: documents keep their words, so an index built by
 * an older version still behaves, and a query for "the" simply asks for nothing. A prompt
 * made only of function words returns nothing, which is the honest answer.
 */
export const QUERY_STOPWORDS = new Set(
	("a about all also am an and another any are as at be because been before being both but by can could did do does doing " +
	"down each either every few for from got had has have having he her here hers him his how i if in into is it " +
	"its let made many me more most no not now of off on once or other our ours out over per rather since some " +
	"such than that the their them then there these they this through to too us very was we were what when where " +
	"which while who whom why will with would you your theirs whether").split(" "),
);


/**
 * Query terms with function words removed. Empty means the query held nothing but
 * function words, and a caller that must answer something (memory_search) says so
 * instead of reporting an empty list as if the bank were empty.
 */
export function normalizeTerm(term: string): string {
	return term.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export function contentTerms(query: string): string[] {
	return query
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.split(/[^\p{L}\p{N}_]+/u)
		.filter((t) => t.length > 0 && !QUERY_STOPWORDS.has(t));
}

/** Determine category from relative path */
export function categorize(relPath: string): string {
	if (relPath.startsWith("core/")) return "core";
	if (relPath.startsWith("knowledge/")) return "knowledge";
	if (relPath.startsWith("history/")) return "history";
	return "other";
}

/** Extract a snippet around the best matching terms */
export function extractSnippet(content: string, query: string, maxLen = 200): string {
	// Function words are skipped when choosing the line, or the snippet of every query
	// starts at the first line containing "the". A query of nothing else finds no line
	// and returns the top of the file, which is what it deserves.
	const terms = contentTerms(query);
	const lines = content.split("\n");

	// Find the first line containing any query term
	let bestLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const lower = lines[i].toLowerCase();
		if (terms.some((t) => lower.includes(t))) {
			bestLine = i;
			break;
		}
	}

	if (bestLine === -1) {
		// No direct match — return beginning of content
		return content.slice(0, maxLen).trim() + (content.length > maxLen ? "…" : "");
	}

	// Grab a window around the matching line
	const start = Math.max(0, bestLine - 1);
	const snippet = lines.slice(start, start + 4).join("\n");
	return snippet.slice(0, maxLen).trim() + (snippet.length > maxLen ? "…" : "");
}

/** Directory levels the search index reads, counting from the bank root. */
export const INDEX_MAX_DEPTH = 5;
export interface MarkdownFile { id: string; full: string; signature: string }

/** Hidden/internal directories and symlinks are not retrieval sources. Metadata is
 * sampled BEFORE content is read: a concurrent rename cannot bless old content
 * with the replacement's signature and leave it stale indefinitely.
 */
export function scanMarkdownFiles(dir: string, root: string, maxDepth = INDEX_MAX_DEPTH, depth = 0): MarkdownFile[] {
	if (depth >= maxDepth) return [];
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
	const files: MarkdownFile[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory() && !entry.name.startsWith(".")) files.push(...scanMarkdownFiles(full, root, maxDepth, depth + 1));
		else if (entry.isFile() && isMarkdownPath(entry.name)) {
			const safe = resolveBankPath(root, full); if (!safe) continue;
			try {
				const st = fs.statSync(safe.full, { bigint: true });
				files.push({ id: safe.rel, full: safe.full, signature: `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}` });
			} catch { /* removed during the walk */ }
		}
	}
	return files;
}
function readDocument(file: MarkdownFile): MemoryDocument | null {
	try {
		const content = fs.readFileSync(file.full, "utf8");
		return { id: file.id, title: extractTitle(content, path.basename(file.full)), content, category: categorize(file.id) };
	} catch { return null; }
}
export function walkMarkdownFiles(dir: string, root: string, maxDepth = INDEX_MAX_DEPTH, depth = 0): MemoryDocument[] {
	return scanMarkdownFiles(dir, root, maxDepth, depth).flatMap((file) => { const doc = readDocument(file); return doc ? [doc] : []; });
}

/**
 * Whether a search candidate is allowed into the prompt, and why not.
 *
 * One rule, two callers: `searchForContext` applies it and the injection debug
 * line explains it. Keeping it a single function is what stops the explanation
 * drifting from the behaviour — a debug line describing yesterday's filter is
 * worse than no debug line.
 */
export function admitsToContext(
	category: string,
	score: number,
	topScore: number,
	options: { includeKnowledge: boolean; includeHistory: boolean },
): { admit: boolean; reason: string } {
	if (category === "knowledge") {
		return options.includeKnowledge
			? { admit: true, reason: "knowledge" }
			: { admit: false, reason: "knowledge injection off" };
	}
	if (category === "history") {
		if (!options.includeHistory) return { admit: false, reason: "history injection off" };
		return score > topScore * 0.5
			? { admit: true, reason: "history over half the top score" }
			: { admit: false, reason: `history under half of ${topScore.toFixed(1)}` };
	}
	// core and other: core files ride along in full every turn regardless.
	return { admit: false, reason: `${category} is injected directly` };
}

/**
 * How much of an injected file may be withheld before "truncated" is the wrong word.
 *
 * A knowledge file is one claim plus the reasoning behind it. Cut a little and the model
 * gets the claim with its tail short — §3.2 accepted that, because the tail is the
 * `## Source` block and losing a source is cheaper than losing a rule. Cut most of it and
 * what arrives is a confident half-claim whose shape has to be guessed. At that point the
 * honest object to send is the file's name and the way to read it, which is one tool call
 * away. Sized against the live bank: its largest file (9,576 characters) loses 37 % and
 * still arrives; a 24,000-character one loses 76 % and does not.
 */
export const MAX_WITHHELD_SHARE = 0.5;

/**
 * Decide what a capped file should do: arrive cut, or be named and left out.
 *
 * `admitsToContext` decides who gets in; this decides what happens to one that got in and
 * does not fit. It is a function rather than an `if` at the call site because three places
 * have to agree on the number — the injector acts on it, the debug line prints it, the log
 * records it — and an explanation with its own arithmetic drifts from the rule it explains.
 */
export function withheldShare(
	fullChars: number,
	hiddenChars: number,
): { skipWhole: boolean; share: number } {
	const share = fullChars > 0 ? hiddenChars / fullChars : 0;
	return { skipWhole: share > MAX_WITHHELD_SHARE, share };
}

/**
 * Top score among candidates whose category is eligible.
 *
 * Excluded categories must not raise the history bar, and the first match is the
 * highest scored.
 */
export function topEligibleScore(
	candidates: Array<{ category: string; score: number }>,
	options: { includeKnowledge: boolean; includeHistory: boolean },
): number {
	for (const r of candidates) {
		if ((r.category === "knowledge" && options.includeKnowledge) ||
			(r.category === "history" && options.includeHistory)) {
			return r.score;
		}
	}
	return 0;
}

export class MemoryIndex {
	private index: MiniSearch<MemoryDocument>;
	private root: string;
	private versions = new Map<string, { signature: string; hash: string }>();

	constructor(root: string) {
		this.root = root;
		this.index = this.makeIndex();
	}

	private makeIndex(): MiniSearch<MemoryDocument> {
		return new MiniSearch<MemoryDocument>({
			fields: ["title", "content"],
			storeFields: ["title", "category"],
			processTerm: normalizeTerm,
			searchOptions: {
				boost: { title: 3 },
				/*
				 * Fuzzy was reviewed and left alone. MiniSearch's budget is
				 * round(term.length * fuzzy), so 0.2 means one edit for terms of 3-7
				 * characters and two for 8-12 — not "one edit per term".
				 *
				 * Measured on realistic prompts against a bank seeded with the collision
				 * pairs a memory bank actually contains (note/node, case/cache, stuck/
				 * stock, plan/plans, workflow/workloads): no tightening — length-gated, or
				 * fuzzy off entirely — removed a wrong file from the top 3, while turning
				 * it off did lose the right file for typo'd prompts ("webooks", "deplou").
				 * And half the noise it gets blamed for is prefix, not fuzzy: note finds
				 * node here, but note finding notes and work finding workloads survive
				 * fuzzy off. Numbers are pinned by the "fuzzy and prefix limits" tests.
				 *
				 * If injection ever looks noisy, the lever is not this number: it is that
				 * three files go in per prompt and the second and third are often filler.
				 * MAX_INJECTED_FILES and searchForContext's unused minScore are where that
				 * lives, and /memory debug on is how to see it happening.
				 */
				fuzzy: 0.2,
				// Prefix matching only for terms of 3+ characters. Applied to every term,
				// it means the "i" in "i am stuck" prefix-matches "inventory" and drags an
				// unrelated knowledge file into the prompt — the same for "is", "of", "to",
				// "a". Stems still work where they matter: "webh" finds "webhook".
				prefix: (term: string) => term.length >= 3,
				// Function words never reach the index lookup, so they cannot score, prefix,
				// or fuzzy their way into a prompt. See QUERY_STOPWORDS.
				processTerm: (term: string) => {
					const normalized = normalizeTerm(term);
					return QUERY_STOPWORDS.has(normalized) ? null : normalized;
				},
			},
			// Disable auto-vacuum. discard() followed by add() (our updateDocument
			// pattern) schedules async batched vacuuming that walks the radix tree
			// while subsequent writes mutate it, crashing TreeIterator:
			//   TypeError: Cannot read properties of undefined (reading 'keys')
			//     at TreeIterator.dive (minisearch/dist/es/index.js:34:63)
			//     at MiniSearch.performVacuuming
			// Discarded IDs are cleaned up on search instead. For a ~15-file memory
			// bank the un-vacuumed memory overhead is negligible; whole-index
			// rebuilds happen on build().
			autoVacuum: false,
		});
	}

	/** Reconcile disk before retrieval, incrementally changing only altered content.
	 * Nanosecond ctime/mtime + inode/device/size catch same-mtime replacements; hashes
	 * avoid changing BM25 statistics when an editor merely touches a file.
	 */
	reconcile() {
		const report = { added: 0, updated: 0, removed: 0, unchanged: 0, documents: 0 };
		const seen = new Set<string>();
		for (const file of scanMarkdownFiles(this.root, this.root)) {
			const previous = this.versions.get(file.id);
			if (previous?.signature === file.signature) { seen.add(file.id); report.unchanged++; continue; }
			const doc = readDocument(file); if (!doc) continue;
			seen.add(file.id);
			const hash = createHash("sha256").update(doc.content).digest("hex");
			if (previous?.hash === hash) report.unchanged++;
			else {
				if (previous) { this.index.discard(file.id); report.updated++; } else report.added++;
				this.index.add(doc);
			}
			this.versions.set(file.id, { signature: file.signature, hash });
		}
		for (const id of this.versions.keys()) {
			if (!seen.has(id)) { this.index.discard(id); this.versions.delete(id); report.removed++; }
		}
		report.documents = this.index.documentCount;
		return report;
	}

	build(): number {
		this.index = this.makeIndex(); this.versions.clear();
		return this.reconcile().documents;
	}

	updateDocument(relPath: string): void {
		const safe = resolveBankPath(this.root, relPath);
		if (safe && isMarkdownPath(safe.rel)) this.reconcile();
	}

	/** The relative paths the index holds right now, after reconciling disk. */
	knownPaths(): string[] {
		this.reconcile();
		return [...this.versions.keys()];
	}

	/**
	 * Describe one indexed file for a query, for a result the keyword search did not produce
	 * (a file found by meaning). Score 0: it has no keyword score, and callers say so.
	 */
	describe(relPath: string, query: string): SearchResult | null {
		const safe = resolveBankPath(this.root, relPath);
		if (!safe || !isMarkdownPath(safe.rel)) return null;
		let content: string;
		try { content = fs.readFileSync(safe.full, "utf-8"); } catch { return null; }
		return {
			path: safe.rel,
			title: extractTitle(content, path.basename(safe.rel)),
			score: 0,
			snippet: extractSnippet(content, query),
			category: categorize(safe.rel),
		};
	}

	/** Search the memory bank. Returns ranked results with snippets. */
	search(query: string, limit = 5): SearchResult[] {
		this.reconcile();
		if (!query.trim()) return [];

		const results = this.index.search(query).slice(0, limit);
		return results.map((r) => {
			const stored = r as typeof r & { title: string; category: string };
			const safe = resolveBankPath(this.root, r.id);
			let content: string;
			try {
				content = safe ? fs.readFileSync(safe.full, "utf-8") : "";
			} catch {
				content = "";
			}

			return {
				path: r.id,
				title: stored.title,
				score: r.score,
				snippet: extractSnippet(content, query),
				category: stored.category,
			};
		});
	}

	/** Search and return full file contents for knowledge injection */
	searchForContext(
		query: string,
		limit = 3,
		minScore?: number,
		options?: { includeKnowledge?: boolean; includeHistory?: boolean; filter?: (rel: string) => boolean },
	): Array<{ path: string; title: string; content: string; score: number }> {
		this.reconcile();
		if (!query.trim()) return [];

		const includeKnowledge = options?.includeKnowledge ?? true;
		const includeHistory = options?.includeHistory ?? true;

		// limit*2 candidates, so category filtering can still fill `limit`.
		const results = this.index.search(query).filter((r) => !options?.filter || options.filter(String(r.id))).slice(0, limit * 2);
		const eligibility = { includeKnowledge, includeHistory };
		const topScore = topEligibleScore(
			results.map((r) => ({ category: (r as typeof r & { category: string }).category, score: r.score })),
			eligibility,
		);

		const relevant = results.filter((r) =>
			admitsToContext((r as typeof r & { category: string }).category, r.score, topScore, eligibility).admit,
		);

		// Apply minimum score threshold if provided
		const threshold = minScore ?? 0;
		const filtered = relevant.filter((r) => r.score >= threshold);

		return filtered.slice(0, limit).map((r) => {
			const stored = r as typeof r & { title: string };
			const safe = resolveBankPath(this.root, r.id);
			let content: string;
			try {
				content = safe ? fs.readFileSync(safe.full, "utf-8") : "";
			} catch {
				content = "";
			}
			return {
				path: r.id,
				title: stored.title,
				content,
				score: r.score,
			};
		});
	}

	/** Get the number of indexed documents */
	get documentCount(): number {
		return this.index.documentCount;
	}
}
