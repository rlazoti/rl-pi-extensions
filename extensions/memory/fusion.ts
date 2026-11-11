/**
 * Reciprocal rank fusion for `memory_search`: one ranked list from keywords (BM25),
 * one from meaning (`qmd vsearch`), one list out.
 *
 * Why rank fusion and not a score blend: the two scores are not on one scale. BM25
 * magnitudes move with corpus size and query length (one prompt scored 39 in a one-file
 * bank and 176 in a sixty-file bank), and a cosine score has no meaning next to them.
 * Ranks do. Why not a vector score floor: measured on a live bank, an unrelated greeting
 * scored 0.41 against an unrelated file while a true match scored 0.43, so no cut-off
 * separates them. Fusion gives the property that matters instead: a file BOTH lists found
 * outranks a file only one list found, so a loosely related vector hit cannot displace a
 * keyword match. Each result says which list(s) found it, so the reader can judge.
 *
 * Equal weights, on evidence (15 agent-labelled prompts, 2026-11-10, correct file in the top 5, which is what the default
 * limit shows): keywords 9, meaning alone 12, both fused equally 14, meaning weighted 2x 12. Weighting meaning more puts
 * the right file first more often (9 against 7) but let ten semantic results outrank a keyword hit that ranked 2nd, which
 * fell to 12th. Fusion trades first-place precision for coverage; `npm run eval:semantic` re-measures it on a real bank.
 */

/** The constant from the original RRF paper; larger values flatten the gap between ranks. */
export const RRF_K = 60;

export type Via = "bm25" | "semantic" | "both";

export interface Fused {
	path: string;
	via: Via;
	fused: number;
	/** 1-based rank in the keyword list, when it was in it. */
	bm25Rank?: number;
	/** 1-based rank in the semantic list, when it was in it. */
	semanticRank?: number;
}

/**
 * `bm25` and `semantic` are paths in rank order, best first. A path repeated inside one list
 * counts once, at its best rank.
 */
export function fuse(bm25: string[], semantic: string[], limit: number): Fused[] {
	if (limit <= 0) return [];
	const rows = new Map<string, Fused>();
	const add = (list: string[], key: "bm25Rank" | "semanticRank") => {
		let rank = 0;
		const seen = new Set<string>();
		for (const path of list) {
			if (seen.has(path)) continue;
			seen.add(path);
			rank++;
			const row = rows.get(path) ?? { path, via: key === "bm25Rank" ? "bm25" : "semantic", fused: 0 };
			row[key] = rank;
			row.fused += 1 / (RRF_K + rank);
			rows.set(path, row);
		}
	};
	add(bm25, "bm25Rank");
	add(semantic, "semanticRank");
	for (const row of rows.values()) row.via = row.bm25Rank && row.semanticRank ? "both" : row.bm25Rank ? "bm25" : "semantic";
	return [...rows.values()]
		.sort((a, b) =>
			// Equal scores: the keyword hit first (it can be explained by shared words), then path, for a stable output.
			b.fused - a.fused ||
			(a.bm25Rank ?? Infinity) - (b.bm25Rank ?? Infinity) ||
			a.path.localeCompare(b.path),
		)
		.slice(0, limit);
}
