/** Evaluation bookkeeping shared by tests and CLI probes; never a second scorer. */
export interface EvalCase {
	id: string; session?: string; prompt: string; must: string[]; config?: Record<string, unknown>;
	relevant?: string[]; none?: boolean; named?: string[];
}
export interface Observation { id: string; files: string[]; named: string[]; chars: number }
export interface EvalCorpus {
	schemaVersion: number; provenance: { author: string; reviewedBy: string | null; status: string };
	files: Record<string, string>; cases: EvalCase[]; config?: Record<string, unknown>;
}
export function validateCorpus(corpus: EvalCorpus): void {
	if (corpus.schemaVersion !== 1 || !corpus.provenance?.status) throw new Error("Unknown evaluation schema/provenance");
	const ids = new Set<string>();
	for (const row of corpus.cases) {
		if (!row.id || ids.has(row.id)) throw new Error(`Duplicate/empty case: ${row.id}`);
		ids.add(row.id);
		for (const file of [...row.must, ...(row.relevant ?? []), ...(row.named ?? [])]) {
			if (!(file in corpus.files)) throw new Error(`Missing snapshot: ${file}`);
		}
		if (row.none && row.must.length) throw new Error(`No-memory case requires a file: ${row.id}`);
		if (row.relevant && row.must.some((file) => !row.relevant!.includes(file))) throw new Error(`Required file not labelled relevant: ${row.id}`);
	}
}
export function scoreEvaluation(corpus: EvalCorpus, observations: Observation[]) {
	validateCorpus(corpus);
	const byId = new Map(observations.map((row) => [row.id, row]));
	if (byId.size !== observations.length || byId.size !== corpus.cases.length) throw new Error("Evaluation did not observe every case exactly once");
	let required = 0, found = 0, slots = 0, relevant = 0, noMemory = 0, correctNone = 0, chars = 0;
	const failures: Array<{ id: string; missing: string[]; irrelevant: string[]; missingNames: string[] }> = [];
	for (const row of corpus.cases) {
		const seen = byId.get(row.id); if (!seen) throw new Error(`No observation: ${row.id}`);
		const allowed = row.relevant ?? row.must;
		const missing = row.must.filter((file) => !seen.files.includes(file));
		const irrelevant = seen.files.filter((file) => !allowed.includes(file));
		const missingNames = (row.named ?? []).filter((file) => !seen.named.includes(file));
		required += row.must.length; found += row.must.length - missing.length;
		slots += seen.files.length; relevant += seen.files.filter((file) => allowed.includes(file)).length;
		chars += seen.chars;
		if (row.none) { noMemory++; if (seen.files.length === 0) correctNone++; }
		if (missing.length || irrelevant.length || missingNames.length) failures.push({ id: row.id, missing, irrelevant, missingNames });
	}
	return { cases: corpus.cases.length, required, found, recall: required ? found / required : 1,
		slots, relevant, precision: slots ? relevant / slots : 1, noMemory, correctNone,
		chars, failures, ownerReviewed: corpus.provenance.reviewedBy !== null };
}

/** Actual sessions are separated by sid, reset boundaries and per-session gaps.
 * Legacy lines without sid are isolated, not silently merged with another agent.
 */
export function splitLoggedSessions(events: Array<Record<string, any>>, gapMs = 30 * 60 * 1000) {
	const sessions: Array<{ sid: string; prompts: string[] }> = [];
	const active = new Map<string, { at: number; prompts: string[] }>();
	let unattributed = 0, invalid = 0;
	for (const ev of [...events].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
		const sid = typeof ev.sid === "string" && ev.sid ? ev.sid : null;
		if (ev.t === "reset" || ev.t === "session") { if (sid) active.delete(sid); continue; }
		if (ev.t !== "inject" || typeof ev.p !== "string" || !ev.p.trim() || ev.p === "[redacted]") continue;
		const at = Date.parse(ev.ts); if (!Number.isFinite(at)) { invalid++; continue; }
		if (!sid) { unattributed++; sessions.push({ sid: `unattributed-${unattributed}`, prompts: [ev.p] }); continue; }
		let previous = active.get(sid);
		if (!previous || at - previous.at > gapMs) {
			previous = { at, prompts: [] }; active.set(sid, previous); sessions.push({ sid, prompts: previous.prompts });
		}
		previous.at = at; previous.prompts.push(ev.p);
	}
	return { sessions, unattributed, invalid };
}

/** A prompt and the file(s) that answer it, for judging `memory_search`. Labels belong to whoever wrote the file. */
export interface RankedCase { id: string; prompt: string; expect: string[] }
/** 1-based rank of the first expected file in a result list, or null when none appears. */
export function firstRank(paths: string[], expect: string[]): number | null {
	const at = paths.findIndex((p) => expect.includes(p));
	return at < 0 ? null : at + 1;
}
/** How many cases found their file in the first `k` results, for keywords alone and for keywords plus meaning. */
export function summarizeRanks(rows: Array<{ id: string; keyword: number | null; fused: number | null }>, k = 3) {
	const within = (rank: number | null) => rank !== null && rank <= k;
	return {
		cases: rows.length,
		k,
		keywordTopK: rows.filter((r) => within(r.keyword)).length,
		fusedTopK: rows.filter((r) => within(r.fused)).length,
		/** Cases keywords alone missed in the top k that meaning found: what the semantic half is for. */
		gained: rows.filter((r) => !within(r.keyword) && within(r.fused)).map((r) => r.id),
		/** Cases keywords alone had in the top k that the fusion lost. Should stay empty. */
		lost: rows.filter((r) => within(r.keyword) && !within(r.fused)).map((r) => r.id),
	};
}
