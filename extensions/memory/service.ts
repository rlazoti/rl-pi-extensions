/**
 * The behaviour behind the tools and the `/memory` command.
 *
 * No pi types in this file on purpose: the semantics of a memory bank — write,
 * show, search, doctor, resolve — are testable without a session, a terminal or a
 * harness. `implementation.ts` is the thin adapter that binds them to Pi's tools,
 * commands and dialogs.
 *
 * One rule runs through it: **the gate's answer is the program's answer.** No
 * retrying with defaults, no guessing a resolution, no quietly re-dating a claim
 * so the write goes through.
 */

import { applyEdits, foreignMemoryExtension, listKnowledgeFiles, loadKnowledgeStore, type LoadedStore, type MemoryPaths } from "./fs-store.js";
import { decide, RESOLUTIONS, type ConflictRefusal, type GateResult, type Resolution, type WriteRequest } from "./gate.js";
import { inject, recall, type Candidate, type Injection } from "./inject.js";
import { deleteConflict, listConflicts, loadConflict, renderConflict, saveConflict, type PendingConflict, type PendingList } from "./pending.js";
import { resolveAll, resolveKey, type AuthorityPlan, type MemoryStore, type ScopeContext, type Violation } from "./resolver.js";
import { formatIdentity, type EntryStatus, type MemoryEntry, type ParseIssue } from "./schema.js";

export interface ResolutionChoice {
	resolution: Resolution;
	note?: string;
	mergedBody?: string;
}

/** How a human answers a refusal, when one is around to be asked. */
export type AskFn = (refusal: ConflictRefusal, request: WriteRequest) => Promise<ResolutionChoice | null>;

export interface WriteOutcome {
	kind: "written" | "unchanged" | "discarded" | "refused" | "rejected";
	summary: string;
	files?: string[];
	warnings?: string[];
	/** Set when a rival claim stopped the write. */
	conflictId?: string;
	instructions?: string;
	/** Set when the refusal was parked in the pending queue. */
	pendingId?: string;
	/** Human-readable form of the queued refusal, for dialogs and `/memory pending`. */
	conflictText?: string;
	issues?: ParseIssue[];
}

export interface KeyReport {
	key: string;
	/** Every claim for the key, in any file and any status. */
	claims: MemoryEntry[];
	authority: MemoryEntry | null;
	plan: AuthorityPlan | null;
	contested: boolean;
}

export interface DoctorReport {
	bankRoot: string;
	files: string[];
	entries: number;
	byStatus: Record<EntryStatus, number>;
	violations: Violation[];
	contested: Array<{ identity: string; candidates: string[] }>;
	unkeyed: string[];
	unreadable: Array<{ path: string; error: string }>;
	pending: PendingConflict[];
	corruptQueue: Array<{ file: string; error: string }>;
	emptyFiles: string[];
}

export interface MemoryService {
	write(request: WriteRequest): Promise<WriteOutcome>;
	resolveQueued(id: string, choice: ResolutionChoice): Promise<WriteOutcome>;
	show(key: string, context: ScopeContext): KeyReport;
	search(query: string, limit?: number): Candidate[];
	injection(prompt: string, context: ScopeContext): Injection;
	doctor(): DoctorReport;
	pending(): PendingList;
}

export interface ServiceOptions {
	/** Absent in print/json/rpc: nothing can be asked, so refusals are parked. */
	ask?: AskFn;
	/** Injectable clock so queue timestamps are testable. */
	now?: () => string;
}

export function createService(paths: MemoryPaths, options: ServiceOptions = {}): MemoryService {
	const now = options.now ?? (() => new Date().toISOString());

	const writePlan = (result: Extract<GateResult, { kind: "plan" }>): WriteOutcome => {
		const files = applyEdits(paths, result.plan.files);
		return { kind: "written", summary: `${result.plan.summary} Written: ${files.join(", ")}.`, files, warnings: result.plan.warnings };
	};

	const park = (refusal: ConflictRefusal, request: WriteRequest): WriteOutcome => {
		const queued = saveConflict(paths, refusal, request, now());
		return {
			kind: "refused",
			summary: `CONFLICT ${formatIdentity(refusal.identity)} — nothing was written.`,
			conflictId: refusal.conflictId,
			instructions:
				`Nothing was written. Decide, then re-invoke the same write with one of resolve: ${RESOLUTIONS.join(" | ")} and conflictId: ${refusal.conflictId}. ` +
				"If you are not entitled to decide, ask the human. The refusal is parked and will be surfaced until it is answered.",
			pendingId: queued.id,
			conflictText: renderConflict(queued),
		};
	};

	const fromGate = (result: GateResult, request: WriteRequest, store: MemoryStore): WriteOutcome => {
		switch (result.kind) {
			case "plan":
				return writePlan(result);
			case "unchanged":
			case "discarded":
				return { kind: result.kind, summary: result.explanation };
			case "reject":
				return { kind: "rejected", summary: result.explanation, issues: result.issues };
			case "conflict":
				return park(result, request);
		}
	};

	/**
	 * Answering a contest clears its queue entry, whoever answered it. Without
	 * this, `/memory doctor` keeps reporting a conflict that has already been
	 * settled — a stale worklist is the same class of bug this component exists
	 * to remove, only pointed at the queue instead of the store.
	 */
	const settle = (outcome: WriteOutcome, conflictId: string | undefined): WriteOutcome => {
		if (conflictId && (outcome.kind === "written" || outcome.kind === "discarded")) deleteConflict(paths, conflictId);
		return outcome;
	};

	const writeOnce = (store: MemoryStore, request: WriteRequest): WriteOutcome => settle(fromGate(decide(store, request), request, store), request.conflictId);

	const writeWithAsk = async (loaded: LoadedStore, request: WriteRequest): Promise<WriteOutcome> => {
		const first = decide(loaded.store, request);
		if (first.kind !== "conflict" || !options.ask) return fromGate(first, request, loaded.store);

		const choice = await options.ask(first, request);
		if (choice === null || choice === undefined) return park(first, request);

		const answered = decide(loaded.store, {
			...request,
			resolve: choice.resolution,
			conflictId: first.conflictId,
			...(choice.note ? { note: choice.note } : {}),
			...(choice.mergedBody ? { mergedBody: choice.mergedBody } : {}),
		});
		// A second refusal (state moved on) is parked, not silently retried.
		if (answered.kind === "conflict") return park(answered, request);
		const outcome = settle(fromGate(answered, request, loaded.store), first.conflictId);
		if (outcome.kind === "written") {
			outcome.summary = `${outcome.summary} Resolved by the human: ${choice.resolution}${choice.note ? ` (${choice.note})` : ""}.`;
		}
		return outcome;
	};

	return {
		async write(request) {
			const loaded = loadKnowledgeStore(paths);
			return options.ask ? writeWithAsk(loaded, request) : writeOnce(loaded.store, request);
		},

		async resolveQueued(id, choice) {
			const stored = loadConflict(paths, id);
			if (stored === null) return { kind: "rejected", summary: `No pending conflict ${id}. Run /memory doctor to see the queue.`, issues: [] };

			const loaded = loadKnowledgeStore(paths);
			const answered = decide(loaded.store, {
				...stored.request,
				resolve: choice.resolution,
				conflictId: stored.id,
				...(choice.note ? { note: choice.note } : {}),
				...(choice.mergedBody ? { mergedBody: choice.mergedBody } : {}),
			});

			if (answered.kind === "reject" && answered.reason === "stale-conflict") {
				// The store moved on underneath the queue. Re-park the contest as it
				// exists now, so nobody resolves a state that no longer holds.
				deleteConflict(paths, stored.id);
				const fresh = decide(loaded.store, stored.request);
				if (fresh.kind === "conflict") {
					const outcome = park(fresh, stored.request);
					outcome.summary = `The store changed since ${stored.id} was recorded; that entry was replaced. ${outcome.summary}`;
					return outcome;
				}
				return { kind: "rejected", summary: `The contest behind ${stored.id} no longer exists — the store already answers it. The queue entry was removed.`, issues: [] };
			}

			const outcome = fromGate(answered, stored.request, loaded.store);
			if (outcome.kind === "written" || outcome.kind === "discarded") deleteConflict(paths, stored.id);
			return outcome;
		},

		show(key, context) {
			const loaded = loadKnowledgeStore(paths);
			const claims = loaded.store.entries.filter((entry) => entry.key === key);
			const contested = resolveAll(loaded.store).some((resolution) => resolution.ambiguous && resolution.key === key);
			const plan = claims.length > 0 ? resolveKey(loaded.store, key, context) : null;
			return { key, claims, authority: plan?.winner ?? null, plan, contested };
		},

		search(query, limit) {
			return recall(loadKnowledgeStore(paths).store, query, limit);
		},

		injection(prompt, context) {
			return inject(loadKnowledgeStore(paths).store, { query: prompt, context });
		},

		doctor() {
			const loaded = loadKnowledgeStore(paths);
			const queue = listConflicts(paths);
			const byStatus: Record<EntryStatus, number> = { active: 0, superseded: 0, withdrawn: 0 };
			for (const entry of loaded.store.entries) byStatus[entry.status] += 1;

			const files = listKnowledgeFiles(paths);
			return {
				bankRoot: paths.root,
				files,
				entries: loaded.store.entries.length,
				byStatus,
				violations: loaded.store.violations,
				contested: resolveAll(loaded.store)
					.filter((resolution) => resolution.ambiguous)
					.map((resolution) => ({ identity: formatIdentity(resolution.identity), candidates: resolution.dropped.map((drop) => `${drop.entry.path}#${drop.entry.heading}`) })),
				unkeyed: loaded.store.unkeyed.map((entry) => `${entry.path}#${entry.heading}`),
				unreadable: loaded.unreadable,
				pending: queue.conflicts,
				corruptQueue: queue.corrupt,
				emptyFiles: files.filter((file) => (loaded.store.byPath.get(file)?.entries.length ?? 0) === 0),
			};
		},

		pending() {
			return listConflicts(paths);
		},
	};
}

/** Where another memory extension would collide with this one. */
export function collisionReport(paths: MemoryPaths): string | null {
	return foreignMemoryExtension(paths);
}

/** Re-exported so the tool schema and the gate cannot drift apart. */
export { RESOLUTIONS };
export type { Candidate, ConflictRefusal, Injection, MemoryEntry, PendingConflict, WriteRequest };
