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

import { applyEdits, foreignMemoryExtension, isTempFile, listBankFiles, listKnowledgeFiles, loadKnowledgeStore, readBankFile, readBankFileChecked, writeBankFile, type BankListingResult, type BankRead, type LoadedStore, type MemoryPaths } from "./fs-store.js";
import { dailyDate, dailyFreshness, describeAge, isOpenHeading, planDailyRollover, renderRolloverNotice, type Freshness } from "./rollover.js";
import { ACTIVE_PROJECTS_FILE, DAILY_FILE, renderWorkingState, type StateBudget, type WorkingStateReport } from "./workingState.js";
import { stampDailyFile } from "./dailyItems.js";
import { decide, RESOLUTIONS, type ConflictRefusal, type GateResult, type Resolution, type WriteRequest } from "./gate.js";
import { inject, recall, type Candidate, type Injection } from "./inject.js";
import { deleteConflict, formatContest, listConflicts, loadConflict, renderConflict, saveConflict, type PendingConflict, type PendingList } from "./pending.js";
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
	/** The same contest, compact: both claims and the rule that refused it, capped to
	 *  fit one screen. The agent reads this, so it can repeat the real contest instead
	 *  of "there is a conflict — pick one". */
	contest?: string;
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
	/** `.tmp-<pid>` siblings: proof a write was interrupted mid-rename. */
	tempFiles: string[];
	/** The hand-written files the injector reads, and how much of each fit. */
	workingState: WorkingStateReport;
}

export interface MemoryService {
	write(request: WriteRequest): Promise<WriteOutcome>;
	resolveQueued(id: string, choice: ResolutionChoice): Promise<WriteOutcome>;
	show(key: string, context: ScopeContext): KeyReport;
	search(query: string, limit?: number): Candidate[];
	injection(prompt: string, context: ScopeContext): Injection;
	/** The working-state block: `core/activeProjects.md` + open work in the daily file. */
	workingState(budget?: Partial<StateBudget>): WorkingStateReport;
	/** Read any file inside the bank — the only way to reach `core/` and `history/`. */
	readFile(file: string, options?: { offset?: number; maxChars?: number }): BankRead;
	listFiles(dir?: string, limit?: number): BankListingResult;
	doctor(): DoctorReport;
	pending(): PendingList;
	/** The daily working file: what day it claims to be, and whether that is today. */
	daily(): DailyStatus;
	/** Archive a stale daily file, start today's, and carry open work forward. */
	/** Give undated open items the day the file is about, so they can age later. */
	stampDaily(): { stamped: number; date: string };
	rollDaily(options?: { force?: boolean; retireAfterDays?: number; maxItems?: number }): DailyRolloverOutcome;
}

export interface DailyStatus {
	path: string;
	exists: boolean;
	freshness: Freshness;
}

export type DailyRolloverOutcome =
	| { performed: false; reason: string; status: DailyStatus }
	| { performed: true; notice: string; archivePath: string; carried: number; notCarried: number; notCarriedDetail: Array<{ heading: string; reason: string }>; status: DailyStatus };

export interface ServiceOptions {
	/** Absent in print/json/rpc: nothing can be asked, so refusals are parked. */
	ask?: AskFn;
	/** Injectable clock so queue timestamps are testable. */
	now?: () => string;
}

export function createService(paths: MemoryPaths, options: ServiceOptions = {}): MemoryService {
	const now = options.now ?? (() => new Date().toISOString());

	const workingStateReport = (budget?: Partial<StateBudget>): WorkingStateReport =>
		renderWorkingState({
			activeProjects: readBankFile(paths, ACTIVE_PROJECTS_FILE)?.text ?? null,
			daily: readBankFile(paths, DAILY_FILE),
			today: now().slice(0, 10),
			...(budget ? { budget } : {}),
		});

	const dailyStatus = (): DailyStatus => {
		const file = readBankFile(paths, DAILY_FILE);
		if (file === null || file.text.trim() === "") return { path: DAILY_FILE, exists: false, freshness: { date: null, ageDays: null, stale: false, needsDate: false } };
		return { path: DAILY_FILE, exists: true, freshness: dailyFreshness(file, now().slice(0, 10)) };
	};

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
				`No decision was collected (no UI, the question was cancelled or interrupted, or another conflict is already on screen), so the contest is parked and surfaced every turn until it is answered. ` +
				`Do not retry this write and do not pick a winner yourself: ask the human, then re-invoke the same write with one of resolve: ${RESOLUTIONS.join(" | ")} and conflictId: ${refusal.conflictId}, or have them run /memory resolve ${refusal.conflictId}.`,
			pendingId: queued.id,
			conflictText: renderConflict(queued),
			contest: formatContest(refusal, { truncate: 260 }),
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
		// The request already carries a resolution (the agent is answering a
		// refusal it was given): no dialog, but the queue entry must still clear.
		if (first.kind !== "conflict" || !options.ask) return settle(fromGate(first, request, loaded.store), request.conflictId);

		// Parked *before* anyone is asked. The question can be lost: the human steps
		// away, another extension's dialog displaces this one in the single dialog
		// slot, the tool call is cancelled, the session ends. A lost question must not
		// take the refusal with it. Answering clears the queue entry; anything else
		// leaves it there, where the next turn will find it.
		const queued = park(first, request);
		let choice: ResolutionChoice | null | undefined;
		try {
			choice = await options.ask(first, request);
		} catch (error) {
			return { ...queued, summary: `${queued.summary} The question could not be asked (${error instanceof Error ? error.message : String(error)}), so it stays in the queue.` };
		}
		if (choice === null || choice === undefined) return queued;

		const answered = decide(loaded.store, {
			...request,
			resolve: choice.resolution,
			conflictId: first.conflictId,
			...(choice.note ? { note: choice.note } : {}),
			...(choice.mergedBody ? { mergedBody: choice.mergedBody } : {}),
		});
		// A second refusal (state moved on) is parked, not silently retried.
		if (answered.kind === "conflict") return park(answered, request);
		if (answered.kind === "reject") {
			// The question *was* answered — badly. That is not an unanswered contest:
			// leaving it queued would tell the next turn that nobody was asked, when in
			// fact the answer was unusable. The caller has to fix it and re-invoke, and
			// the refusal is re-parked then if the contest still stands.
			deleteConflict(paths, first.conflictId);
			return {
				...settle(fromGate(answered, request, loaded.store), first.conflictId),
				instructions: `The answer for ${first.conflictId} was unusable, so nothing was written and the contest is not queued. Re-invoke with a valid resolve (${RESOLUTIONS.join(" | ")}) and conflictId: ${first.conflictId}.`,
			};
		}
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

		workingState(budget) {
			return workingStateReport(budget);
		},

		readFile(file, options) {
			// `resolveAnyInBank` (containment without the entry-shape rule) is the whole
			// point: `core/` and `history/` are reachable, everything outside is not.
			return readBankFileChecked(paths, file, options ?? {});
		},

		listFiles(dir, limit) {
			return listBankFiles(paths, dir ?? ".", limit === undefined ? {} : { limit });
		},

		daily() {
		return dailyStatus();
	},

	stampDaily() {
		const file = readBankFile(paths, DAILY_FILE);
		const today = now().slice(0, 10);
		if (file === null || file.text.trim() === "") return { stamped: 0, date: today };
		const date = dailyDate(file)?.date ?? file.modified ?? today;
		const stampedFile = stampDailyFile(file.text, date, isOpenHeading);
		if (stampedFile.stamped === 0) return { stamped: 0, date };
		writeBankFile(paths, DAILY_FILE, stampedFile.text);
		return { stamped: stampedFile.stamped, date };
	},

	rollDaily(options: { force?: boolean; retireAfterDays?: number; maxItems?: number } = {}) {
		const status = dailyStatus();
		const file = readBankFile(paths, DAILY_FILE);
		if (file === null || file.text.trim() === "") return { performed: false, reason: "no daily context file yet", status };
		const plan = planDailyRollover(file, now().slice(0, 10), options);
		if (plan === null) return { performed: false, reason: "the daily file is already current", status };
		// An archive is a record, never a draft, so it is never overwritten. But a name
		// collision is not always a duplicate: two files can legitimately be about the
		// same day — an undated one whose day was inferred from its mtime, plus the
		// fresh file started for that day — and blocking on that left a real bank's
		// daily file stale and unarchivable forever. So: identical bytes means the day
		// is already recorded (nothing is archived twice); anything else takes the next
		// free slot beside it and says so.
		const slot = archiveSlot(paths, plan.archivePath, plan.archiveText);
		if (slot.kind === "identical") return { performed: false, reason: `${plan.archivePath} already records this exact day — there is nothing to archive twice`, status };
		if (slot.kind === "full") return { performed: false, reason: `archive ${plan.archivePath} and the slots beside it are all taken — refusing to overwrite a record`, status };
		if (writeBankFile(paths, slot.path, plan.archiveText, { noOverwrite: true }) === null) {
			return { performed: false, reason: `archive ${slot.path} already exists — refusing to overwrite a record`, status };
		}
		writeBankFile(paths, DAILY_FILE, plan.freshText);
		const displaced = slot.path === plan.archivePath ? "" : `\nArchived as ${slot.path}: ${plan.archivePath} already held a record of that day.`;
		return { performed: true, notice: `${renderRolloverNotice(plan)}${displaced}`, archivePath: slot.path, carried: plan.carried.length, notCarried: plan.notCarried.length, notCarriedDetail: plan.notCarried, status: dailyStatus() };
	},

	doctor() {
			const loaded = loadKnowledgeStore(paths);
			const queue = listConflicts(paths);
			const byStatus: Record<EntryStatus, number> = { active: 0, superseded: 0, withdrawn: 0 };
			for (const entry of loaded.store.entries) byStatus[entry.status] += 1;

			const files = listKnowledgeFiles(paths);
			const listed = listBankFiles(paths);
			const tempFiles = listed.kind === "listed" ? listed.listing.entries.filter((entry) => isTempFile(entry.path)).map((entry) => entry.path) : [];
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
				tempFiles,
				workingState: workingStateReport(),
			};
		},

		pending() {
			return listConflicts(paths);
		},
	};
}

/**
 * Where an archive actually lands: the plain name if it is free, then `-2`, `-3` …
 * beside it. A file with the same bytes is the one true duplicate — the day is
 * already recorded — while a different file claiming the same day is history, not a
 * collision to discard or a rollover to block.
 */
function archiveSlot(paths: MemoryPaths, wanted: string, text: string): { kind: "path"; path: string } | { kind: "identical" } | { kind: "full" } {
	const slot = (nth: number): string => (nth <= 1 ? wanted : wanted.replace(/\.md$/, `-${nth}.md`));
	for (let nth = 1; nth <= 51; nth += 1) {
		const candidate = slot(nth);
		const existing = readBankFile(paths, candidate);
		if (existing === null) return { kind: "path", path: candidate };
		if (existing.text === text) return { kind: "identical" };
	}
	return { kind: "full" };
}

/** Where another memory extension would collide with this one. */
export function collisionReport(paths: MemoryPaths): string | null {
	return foreignMemoryExtension(paths);
}

/** Re-exported so the tool schema and the gate cannot drift apart. */
export { RESOLUTIONS };
export type { Candidate, ConflictRefusal, Injection, MemoryEntry, PendingConflict, WriteRequest };
