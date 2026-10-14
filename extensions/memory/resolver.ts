/**
 * Authority resolution for the memory extension.
 *
 * Retrieval picks *candidates*. This module picks *the authority*, in two gates:
 *
 *   Gate 1 — within one identity (assertion key + scope): at most one `active`
 *     entry may exist. Stale claims (`superseded`/`withdrawn`) and malformed
 *     ones never surface. If the store is broken and holds two well-formed
 *     active claims on one identity, the identity **fails closed**: nothing is
 *     injected for it, and it is reported as a conflict a human must resolve.
 *     Guessing the newest one would reproduce exactly the ambiguity this
 *     extension exists to remove.
 *
 *   Gate 2 — across scopes for one assertion key: a `project:` or `path:` rule
 *     shadows a `global` default for the same key, so a question gets one answer
 *     for the current context instead of a global rule plus a project override
 *     that the model has to referee.
 *
 * Consequence: `compareAuthority`'s specificity tier is exercised at Gate 2 — an
 * entry's own identity always has a fixed scope. Both gates are deterministic:
 * input order cannot change the result, and nothing here reads a clock.
 */

import { minimatch } from "minimatch";
import {
	compareAuthority,
	identityOf,
	parseRefs,
	isSupersedeRef,
	scopeKey,
	type EntryScope,
	type MemoryEntry,
	type TopicFile,
} from "./schema.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Why a retrieved candidate yielded nothing injectable. */
export type DropReason =
	| "superseded"
	| "withdrawn"
	| "invalid"
	| "conflict"
	| "outranked"
	| "unkeyed"
	| "unknown-identity";
/** Why a real authority was not used in this context. */
export type ShadowReason = "shadowed-by-scope" | "out-of-scope";

export interface DroppedEntry {
	entry: MemoryEntry;
	reason: DropReason;
}

export interface ShadowedEntry {
	entry: MemoryEntry;
	reason: ShadowReason;
	/** The entry that outranks it (absent for `out-of-scope`). */
	by?: MemoryEntry;
}

export interface AuthorityResolution {
	identity: string;
	key: string;
	scope: EntryScope;
	path: string;
	/** The one entry that may be injected, or null when none may be. */
	winner: MemoryEntry | null;
	/**
	 * The top-ranked claim when the identity failed closed. Never injected: it is
	 * the suggestion to prefill the human's resolution, nothing more.
	 */
	bestCandidate: MemoryEntry | null;
	dropped: DroppedEntry[];
	/** The store is broken: two well-formed `active` claims on this identity. */
	ambiguous: boolean;
}

export type ViolationCode =
	| "duplicate-identity"
	| "invalid-entry"
	| "unkeyed-entry"
	| "dangling-supersedes"
	| "ambiguous-supersedes"
	| "supersede-cycle";

export interface Violation {
	code: ViolationCode;
	message: string;
	path: string;
	key?: string;
	scope?: string;
	line?: number;
}

export interface MemoryStore {
	entries: MemoryEntry[];
	/** Parsed topic files, keyed by their memory-bank-relative path. */
	byPath: Map<string, TopicFile>;
	byIdentity: Map<string, MemoryEntry[]>;
	/** assertion key → the identities that claim it. */
	byKey: Map<string, string[]>;
	/** Entries whose identity cannot be computed (bad key or bad scope). */
	unkeyed: MemoryEntry[];
	violations: Violation[];
}

export interface ScopeContext {
	/** Project the session is in, matched against `scope: project:<name>`. */
	project?: string;
	/** Project-relative paths in play, matched against `scope: path:<glob>`. */
	paths?: string[];
}

export interface RankedAuthorities {
	applicable: MemoryEntry[];
	winner: MemoryEntry | null;
	shadowed: ShadowedEntry[];
	outOfScope: ShadowedEntry[];
}

export interface AuthorityPlan {
	applicable: MemoryEntry[];
	winner: MemoryEntry | null;
	shadowed: ShadowedEntry[];
	outOfScope: ShadowedEntry[];
}

export interface InjectionHit {
	entry: MemoryEntry;
	/**
	 * Set when the retrieved candidate is not the authority and the authority was
	 * injected in its place: a hit on a stale claim answers with the claim that
	 * replaced it, instead of either going silent or quoting the dead rule.
	 */
	redirectedFrom?: MemoryEntry;
}

export interface InjectionPlan {
	/** What to inject, in candidate order: at most one entry per assertion key. */
	inject: InjectionHit[];
	suppressed: DroppedEntry[];
	shadowed: ShadowedEntry[];
	/** Identities that need a human: two active claims on one identity. */
	conflicts: AuthorityResolution[];
}

/**
 * Structural validity, judged without the parser's own `duplicate-identity`
 * flag: whether an identity holds two active claims is a store-level question
 * that this module answers itself (by grouping), so the flag must not also make
 * each entry individually malformed — that would let a duplicate masquerade as
 * three separate broken entries.
 */
export function isWellFormed(entry: MemoryEntry): boolean {
	return entry.issues.every((issue) => issue.code === "duplicate-identity" || issue.severity !== "error");
}

// ─── Store construction ─────────────────────────────────────────────────────

/** Build a queryable store from parsed topic files. Never throws. */
export function buildStore(files: TopicFile[]): MemoryStore {
	const entries: MemoryEntry[] = [];
	const byPath = new Map<string, TopicFile>();
	const byIdentity = new Map<string, MemoryEntry[]>();
	const byKey = new Map<string, string[]>();
	const unkeyed: MemoryEntry[] = [];
	const violations: Violation[] = [];

	for (const file of files) {
		byPath.set(file.path, file);
		for (const entry of file.entries) {
			entries.push(entry);
			const identity = identityOf(entry);
			if (identity === null) {
				unkeyed.push(entry);
				violations.push({
					code: "unkeyed-entry",
					message: `"${entry.heading}" has no usable assertion key/scope, so it cannot be compared, resolved, or injected.`,
					path: entry.path,
					line: entry.range.start,
				});
				continue;
			}
			const bucket = byIdentity.get(identity);
			if (bucket) bucket.push(entry);
			else byIdentity.set(identity, [entry]);

			const identities = byKey.get(entry.key);
			if (identities && !identities.includes(identity)) identities.push(identity);
			else if (!identities) byKey.set(entry.key, [identity]);
		}
	}

	for (const group of byIdentity.values()) {
		violations.push(...auditIdentityGroup(group));
		violations.push(...auditSupersedeChain(group));
	}

	return { entries, byPath, byIdentity, byKey, unkeyed, violations };
}

/** Duplicate active claims and error-flagged entries, reported per entry. */
function auditIdentityGroup(group: MemoryEntry[]): Violation[] {
	const violations: Violation[] = [];
	const active = group.filter((entry) => entry.status === "active" && isWellFormed(entry));

	if (active.length >= 2) {
		const claimants = group.map((entry) => `${entry.heading}@${scopeKey(entry.scope)}`).join(", ");
		for (const entry of active) {
			violations.push({
				code: "duplicate-identity",
				message: `${active.length} active entries claim the same assertion (${claimants}). Exactly one may be active.`,
				path: entry.path,
				key: entry.key,
				scope: scopeKey(entry.scope),
				line: entry.range.start,
			});
		}
	}

	for (const entry of group) {
		const errors = entry.issues
			.filter((issue) => issue.severity === "error" && issue.code !== "duplicate-identity")
			.map((issue) => issue.code);
		if (errors.length > 0) {
			violations.push({
				code: "invalid-entry",
				message: `${entry.heading} is not injectable: ${errors.join(", ")}.`,
				path: entry.path,
				key: entry.key,
				scope: scopeKey(entry.scope),
				line: entry.range.start,
			});
		}
	}
	return violations;
}

/**
 * A `supersedes:` reference must name a sibling claim of the same identity, and
 * the chain must not loop. References may be qualified `path#heading`, which is
 * what the gate writes — two topic files can hold the same heading (the exact
 * shape of the bug this component removes), so an unqualified reference is only
 * usable when it is unique.
 */
function auditSupersedeChain(group: MemoryEntry[]): Violation[] {
	const violations: Violation[] = [];
	const byHeading = new Map<string, MemoryEntry[]>();
	for (const entry of group) {
		const bucket = byHeading.get(entry.heading);
		if (bucket) bucket.push(entry);
		else byHeading.set(entry.heading, [entry]);
	}

	const resolveRef = (ref: string): { entries: MemoryEntry[]; ambiguous: boolean } => {
		if (!isSupersedeRef(ref)) return { entries: [], ambiguous: false };
		const hash = ref.lastIndexOf("#");
		if (hash >= 0) {
			const path = ref.slice(0, hash);
			const heading = ref.slice(hash + 1);
			return { entries: (byHeading.get(heading) ?? []).filter((entry) => entry.path === path), ambiguous: false };
		}
		const found = byHeading.get(ref) ?? [];
		return { entries: found, ambiguous: found.length > 1 };
	};

	for (const entry of group) {
		for (const ref of parseRefs(entry.supersedes ?? "")) {
			const target = resolveRef(ref);
			if (target.entries.length === 0) {
				violations.push({
					code: "dangling-supersedes",
					message: `${entry.heading} claims to supersede \`${ref}\`, which is not a claim sharing its identity.`,
					path: entry.path,
					key: entry.key,
					scope: scopeKey(entry.scope),
					line: entry.range.start,
				});
			} else if (target.ambiguous) {
				violations.push({
					code: "ambiguous-supersedes",
					message: `${entry.heading} supersedes \`${ref}\`, but ${target.entries.length} claims share that heading across files; write the reference as \`path#heading\`.`,
					path: entry.path,
					key: entry.key,
					scope: scopeKey(entry.scope),
					line: entry.range.start,
				});
			}
		}

		const cycle = findSupersedeCycle(entry, resolveRef, new Set<string>(), new Set<string>());
		if (cycle) {
			violations.push({
				code: "supersede-cycle",
				message: `The supersede chain from ${entry.heading} loops back through ${cycle.heading} and cannot be followed.`,
				path: entry.path,
				key: entry.key,
				scope: scopeKey(entry.scope),
				line: entry.range.start,
			});
		}
	}
	return violations;
}

/** Depth-first search for a back-edge: a claim that (transitively) supersedes itself. */
function findSupersedeCycle(
	entry: MemoryEntry,
	resolveRef: (ref: string) => { entries: MemoryEntry[] },
	inStack: Set<string>,
	done: Set<string>,
): MemoryEntry | null {
	const id = `${entry.path}#${entry.heading}`;
	if (inStack.has(id)) return entry;
	if (done.has(id)) return null;

	inStack.add(id);
	for (const ref of parseRefs(entry.supersedes ?? "")) {
		for (const next of resolveRef(ref).entries) {
			const found = findSupersedeCycle(next, resolveRef, inStack, done);
			if (found) return found;
		}
	}
	inStack.delete(id);
	done.add(id);
	return null;
}

// ─── Gate 1: one authority per identity ─────────────────────────────────────

export function resolveIdentity(store: MemoryStore, identity: string): AuthorityResolution | null {
	const group = store.byIdentity.get(identity);
	if (!group || group.length === 0) return null;

	const first = group[0]!;
	// A malformed active entry is not a competing authority — it is a broken entry.
	// It must not poison its well-formed sibling, but it is reported.
	const contenders = group.filter((entry) => entry.status === "active" && isWellFormed(entry));
	const ambiguous = contenders.length >= 2;
	const ranked = [...contenders].sort(compareAuthority);
	const winner = ambiguous ? null : ranked[0] ?? null;
	const bestCandidate = ranked[0] ?? null;

	const dropped: DroppedEntry[] = [];
	for (const entry of group) {
		if (entry === winner) continue;
		if (entry.status === "superseded") dropped.push({ entry, reason: "superseded" });
		else if (entry.status === "withdrawn") dropped.push({ entry, reason: "withdrawn" });
		else if (!isWellFormed(entry)) dropped.push({ entry, reason: "invalid" });
		else if (ambiguous) dropped.push({ entry, reason: "conflict" });
		else dropped.push({ entry, reason: "outranked" });
	}

	return {
		identity,
		key: first.key,
		scope: first.scope,
		path: first.path,
		winner,
		bestCandidate,
		dropped,
		ambiguous,
	};
}

/** Every identity in the store, resolved, in a scan-order-independent order. */
export function resolveAll(store: MemoryStore): AuthorityResolution[] {
	const out: AuthorityResolution[] = [];
	for (const identity of [...store.byIdentity.keys()].sort()) {
		const resolution = resolveIdentity(store, identity);
		if (resolution) out.push(resolution);
	}
	return out;
}

// ─── Gate 2: one authority per assertion key in a context ───────────────────

/**
 * Match a project-relative path against a `scope: path:<glob>` pattern.
 *
 * Standard minimatch semantics, on purpose: glob edge cases are exactly the kind
 * of bug that misclassifies a scope silently for weeks. Options are pinned so a
 * scope pattern behaves as a *matcher* and not as an ignore file — `dot: true`
 * (paths under `.github/` or `.vscode/` must match `**` rather than quietly
 * fail), `nonegate` and `nocomment` (a leading `!` or `#` is literal), and
 * case-sensitive.
 */
export function globMatches(pattern: string, path: string): boolean {
	return minimatch(path, pattern, { dot: true, nonegate: true, nocomment: true, nocase: false });
}

/** Is a scope applicable in this context? Malformed scopes never are. */
export function scopeApplies(scope: EntryScope, context: ScopeContext): boolean {
	if (scope.level === "global") return true;
	if (scope.level === "invalid") return false;
	if (scope.level === "project") return context.project !== undefined && context.project === scope.value;
	const paths = context.paths ?? [];
	return scope.value !== undefined && paths.some((path) => globMatches(scope.value!, path));
}

/**
 * Rank already-resolved authorities for one assertion key: keep those
 * applicable to the context, most specific then most recent first. Everything
 * that lost is reported with a reason rather than silently discarded.
 */
export function rankAuthorities(entries: MemoryEntry[], context: ScopeContext): AuthorityPlan {
	const applicable = entries.filter((entry) => scopeApplies(entry.scope, context));
	const outOfScope: ShadowedEntry[] = entries
		.filter((entry) => !scopeApplies(entry.scope, context))
		.map((entry) => ({ entry, reason: "out-of-scope" }));

	const ranked = [...applicable].sort(compareAuthority);
	const winner = ranked[0] ?? null;
	// Entries reaching here are Gate-1 winners of *distinct* identities sharing one
	// assertion key, so they necessarily differ in scope — that is what shadows them.
	const shadowed: ShadowedEntry[] = ranked.slice(1).map((entry) => ({
		entry,
		reason: "shadowed-by-scope",
		by: winner ?? undefined,
	}));

	return { applicable: ranked, winner, shadowed, outOfScope };
}

/** Everything the store claims for one assertion key, resolved for a context. */
export function resolveKey(store: MemoryStore, key: string, context: ScopeContext): AuthorityPlan | null {
	const identities = store.byKey.get(key);
	if (!identities || identities.length === 0) return null;

	const authorities: MemoryEntry[] = [];
	for (const identity of identities) {
		const winner = resolveIdentity(store, identity)?.winner;
		if (winner) authorities.push(winner);
	}
	if (authorities.length === 0) return null;
	return rankAuthorities(authorities, context);
}

// ─── The plan the injector consumes ─────────────────────────────────────────

/**
 * Turn retrieval candidates into what may be injected. A candidate that is not
 * the authority is answered with the authority that replaced it, never with the
 * stale claim itself; and two entries for one assertion key never appear in the
 * same injection.
 */
export function planInjection(store: MemoryStore, candidates: MemoryEntry[], context: ScopeContext = {}): InjectionPlan {
	const suppressed: DroppedEntry[] = [];
	const conflicts: AuthorityResolution[] = [];
	const resolutions = new Map<string, AuthorityResolution | null>();

	const resolveFor = (entry: MemoryEntry): AuthorityResolution | null => {
		const identity = identityOf(entry);
		if (identity === null) return null;
		if (!resolutions.has(identity)) resolutions.set(identity, resolveIdentity(store, identity));
		return resolutions.get(identity) ?? null;
	};

	// Gate 1: every candidate is answered by the authority of its identity.
	const hits: InjectionHit[] = [];
	const seenIdentity = new Set<string>();
	for (const candidate of candidates) {
		const identity = identityOf(candidate);
		if (identity === null) {
			suppressed.push({ entry: candidate, reason: "unkeyed" });
			continue;
		}
		const resolution = resolveFor(candidate);
		if (resolution === null) {
			suppressed.push({ entry: candidate, reason: "unknown-identity" });
			continue;
		}
		if (resolution.ambiguous && !conflicts.some((existing) => existing.identity === resolution.identity)) {
			conflicts.push(resolution);
		}

		const winner = resolution.winner;
		if (winner === null) {
			const reason: DropReason =
				resolution.ambiguous && isWellFormed(candidate) ? "conflict" : candidate.status === "active" ? "invalid" : candidate.status;
			suppressed.push({ entry: candidate, reason });
			continue;
		}
		if (seenIdentity.has(identity)) continue;
		seenIdentity.add(identity);
		hits.push(winner === candidate ? { entry: winner } : { entry: winner, redirectedFrom: candidate });
	}

	// Gate 2: one authority per assertion key, for this context.
	const hitsByKey = new Map<string, InjectionHit[]>();
	for (const hit of hits) {
		const bucket = hitsByKey.get(hit.entry.key);
		if (bucket) bucket.push(hit);
		else hitsByKey.set(hit.entry.key, [hit]);
	}

	const kept = new Set<InjectionHit>();
	const shadowed: ShadowedEntry[] = [];
	for (const bucket of hitsByKey.values()) {
		const plan = rankAuthorities(
			bucket.map((hit) => hit.entry),
			context,
		);
		for (const hit of bucket) {
			if (plan.winner && hit.entry === plan.winner) kept.add(hit);
		}
		shadowed.push(...plan.shadowed, ...plan.outOfScope);
	}

	// Preserve retrieval order among the survivors.
	const position = new Map<InjectionHit, number>();
	hits.forEach((hit, index) => position.set(hit, index));
	const inject = hits.filter((hit) => kept.has(hit));
	inject.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));

	return { inject, suppressed, shadowed, conflicts };
}
