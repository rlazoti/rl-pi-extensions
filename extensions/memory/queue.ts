/**
 * The queue: pending claims, one per identity, waiting for Rodrigo (R11, R17-R19, R21).
 *
 * The agent can only ever write a pending claim; an approved claim exists only
 * because a human approved it (R17). A second proposal for an identity replaces
 * the first draft, and the replaced draft goes to history rather than the bit
 * bucket — a proposal is a thing someone wrote, not a scratch value.
 *
 * Nothing here ever expires a claim. An old pending claim is *flagged*: it stops
 * being injected and starts being counted in the session notice, but it stays in
 * the bank until it is reviewed (R21, D13).
 */

import { charCount, type Claim } from "./grammar.js";
import { daysBetween, describeAge } from "./time.js";
import { findContested, moveToHistory, readClaims, removeClaim, upsertClaim, type BankSnapshot, type BankPaths } from "./store.js";

export interface PendingEntry {
	claim: Claim;
	/** The approved claim this proposal would replace, if any. */
	approved?: Claim;
	/** Where the age came from: `proposedAt`, or the claim's own date if a hand edit left it out. */
	dateSource: "proposedAt" | "asOf";
	ageDays: number;
	/** Older than `pendingFlagDays`: counted in the notice, no longer injected (R20, R28). */
	flagged: boolean;
	file: string;
}

function startOf(claim: Claim): { day: string; source: "proposedAt" | "asOf" } {
	if (claim.proposedAt) return { day: claim.proposedAt, source: "proposedAt" };
	return { day: claim.asOf, source: "asOf" };
}

/** Every pending claim in the bank, oldest first, with the claim it would replace. */
export function listPending(snapshot: BankSnapshot, opts: { today: string; pendingFlagDays: number }): PendingEntry[] {
	const approvedByKey = new Map<string, Claim>();
	for (const claim of snapshot.claims) {
		if (claim.state === "approved") approvedByKey.set(identity(claim), claim);
	}
	const entries: PendingEntry[] = [];
	for (const parsed of snapshot.entries) {
		if (parsed.claim.state !== "pending") continue;
		const start = startOf(parsed.claim);
		const ageDays = daysBetween(start.day, opts.today);
		entries.push({
			claim: parsed.claim,
			approved: approvedByKey.get(identity(parsed.claim)),
			dateSource: start.source,
			ageDays,
			flagged: ageDays > opts.pendingFlagDays,
			file: parsed.file,
		});
	}
	// Oldest first: the longest wait is the one Rodrigo should see at the top.
	return entries.sort((a, b) => b.ageDays - a.ageDays || identity(a.claim).localeCompare(identity(b.claim)));
}

function identity(claim: Claim): string {
	return `${claim.key}\u0000${claim.scope}`;
}

export interface ProposeResult {
	file: string;
	/** A previous draft for the same identity, moved to history rather than lost. */
	replacedDraft?: { file: string };
	/** The approved claim the proposal waits against, when there is one. */
	against?: Claim;
}

/**
 * Store a proposal. The gate has already run: this function decides only what
 * happens to the previous occupant of the identity (R11, R13).
 */
export function propose(paths: BankPaths, claim: Claim, today: string): ProposeResult {
	const pending: Claim = { ...claim, state: "pending", proposedAt: claim.proposedAt ?? today };
	const snapshot = readClaims(paths);
	const previous = snapshot.entries.find((entry) => entry.claim.state === "pending" && identity(entry.claim) === identity(pending));
	const against = snapshot.claims.find((entry) => entry.state === "approved" && identity(entry) === identity(pending));
	let replacedDraft: { file: string } | undefined;
	if (previous) {
		removeClaim(paths, previous.claim);
		replacedDraft = { file: moveToHistory(paths, previous.claim, { field: "rejectedAt", day: today }) };
	}
	const written = upsertClaim(paths, pending);
	return { file: written.file, replacedDraft, against };
}

export type ReviewOutcome = { ok: true; action: string; claim: Claim; historyFile?: string } | { ok: false; problem: string };

function findPending(paths: BankPaths, key: string, scope: string): { claim: Claim; file: string } | undefined {
	const snapshot = readClaims(paths);
	const found = snapshot.entries.find((entry) => entry.claim.state === "pending" && entry.claim.key === key && (scope === "" || entry.claim.scope === scope));
	if (!found) return undefined;
	return { claim: found.claim, file: found.file };
}

function missing(key: string): ReviewOutcome {
	return { ok: false, problem: `no pending claim for "${key}" — /memory review lists what is waiting` };
}

/**
 * Approve: the old approved claim moves to history word for word, the proposal
 * becomes the approved claim (R13). A proposal for a new identity simply becomes
 * the approved claim.
 */
export function approve(paths: BankPaths, key: string, scope: string, today: string): ReviewOutcome {
	const pending = findPending(paths, key, scope);
	if (!pending) return missing(key);
	const approved: Claim = { ...pending.claim, state: "approved", deferredAt: undefined };
	const previous = readClaims(paths).claims.find((claim) => claim.state === "approved" && identity(claim) === identity(approved));
	let historyFile: string | undefined;
	if (previous) historyFile = moveToHistory(paths, previous, { field: "supersededAt", day: today });
	removeClaim(paths, pending.claim);
	upsertClaim(paths, approved);
	return { ok: true, action: "approved", claim: approved, historyFile };
}

/** Reject: the proposal leaves the queue and lands in history, still readable (R21). */
export function reject(paths: BankPaths, key: string, scope: string, today: string): ReviewOutcome {
	const pending = findPending(paths, key, scope);
	if (!pending) return missing(key);
	removeClaim(paths, pending.claim);
	const historyFile = moveToHistory(paths, pending.claim, { field: "rejectedAt", day: today });
	return { ok: true, action: "rejected", claim: pending.claim, historyFile };
}

/** Defer: it keeps waiting, and the deferral is on the record. */
export function defer(paths: BankPaths, key: string, scope: string, today: string): ReviewOutcome {
	const pending = findPending(paths, key, scope);
	if (!pending) return missing(key);
	const kept: Claim = { ...pending.claim, deferredAt: today };
	removeClaim(paths, pending.claim);
	upsertClaim(paths, kept);
	return { ok: true, action: "deferred", claim: kept };
}

/** Edit: the human rewords the proposal; it stays pending until approved. */
export function editPending(paths: BankPaths, key: string, scope: string, changes: { body?: string; kind?: Claim["kind"]; tags?: string[]; aliases?: string[]; links?: string[] }): ReviewOutcome {
	const pending = findPending(paths, key, scope);
	if (!pending) return missing(key);
	const body = changes.body === undefined ? pending.claim.body : changes.body.replace(/\s+/g, " ").trim();
	if (body === "") return { ok: false, problem: "an edited body may not be empty" };
	const edited: Claim = {
		...pending.claim,
		body,
		kind: changes.kind ?? pending.claim.kind,
		tags: changes.tags ?? pending.claim.tags,
		aliases: changes.aliases ?? pending.claim.aliases,
		links: changes.links ?? pending.claim.links,
	};
	removeClaim(paths, pending.claim);
	upsertClaim(paths, edited);
	return { ok: true, action: "edited", claim: edited };
}

/**
 * Everything waiting on Rodrigo, counted for the session notice (R20). Migration
 * backlog is counted separately because a hundred migrated claims and three new
 * proposals need different decisions (D9).
 */
export interface QueueCounts {
	agentProposals: number;
	migrationBacklog: number;
	contested: { key: string; scope: string; files: string[] }[];
	flagged: PendingEntry[];
	coarseDates: number;
	total: number;
}

export function queueCounts(snapshot: BankSnapshot, opts: { today: string; pendingFlagDays: number }): QueueCounts {
	const pending = listPending(snapshot, opts);
	return {
		agentProposals: pending.filter((entry) => entry.claim.origin === "agent").length,
		migrationBacklog: pending.filter((entry) => entry.claim.origin === "migration").length,
		contested: findContested(snapshot.entries),
		flagged: pending.filter((entry) => entry.flagged),
		coarseDates: pending.filter((entry) => entry.dateSource === "asOf").length,
		total: pending.length,
	};
}

/** One pending claim, as a human reads it in `/memory review`. */
export function describePending(entry: PendingEntry, today: string): string[] {
	const lines = [`${entry.claim.key} @ ${entry.claim.scope} — ${entry.claim.kind}, ${entry.claim.origin}, waiting ${describeAge(startOf(entry.claim).day, today)}${entry.flagged ? " (flagged: older than the flag window, not injected)" : ""}`];
	if (entry.dateSource === "asOf") lines.push("  its proposal date came from the claim's own asOf: the age is coarse by up to a day");
	if (entry.approved) {
		lines.push(`  replaces: ${entry.approved.body}`);
		lines.push(`  as of ${entry.approved.asOf}, from ${entry.approved.source}`);
	} else {
		lines.push("  new claim: nothing to replace");
	}
	lines.push(`  body: ${entry.claim.body}`);
	if (entry.claim.statusOverride) lines.push(`  status-check overridden: ${entry.claim.statusOverride}`);
	lines.push(`  ${charCount(entry.claim.body)} characters, ${entry.claim.tags.length > 0 ? `tags: ${entry.claim.tags.join(", ")}` : "no tags"}`);
	return lines;
}
