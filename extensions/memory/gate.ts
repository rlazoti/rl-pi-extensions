/**
 * Admission gate for the memory extension (write path).
 *
 * This is where the invariant is enforced: a write that would put two live
 * claims on one identity is **refused**, in every Pi mode, and nothing is
 * written — not partially, not "sort it out later". The caller then re-invokes
 * with an explicit resolution.
 *
 * The rule that keeps ordinary authoring usable while still refusing rivalry:
 *
 *   incoming heading names an entry that already exists   → **amend** in place
 *   incoming claim competes with a live claim             → **conflict**, refused
 *
 * Rewording a claim you already own is normal authoring. Adding a rival claim
 * for the same assertion — in this file or any other — is the dangerous act, and
 * that is what gets gated.
 *
 * `decide` is pure: it takes parsed topic files and returns rendered file
 * contents to write. It never touches the filesystem and never reads a clock —
 * the caller must supply `asOf`, because a hidden clock makes every write test
 * non-reproducible and invents provenance.
 */

import {
	identityOf,
	parseScope,
	parseTopicFile,
	renderTopicFile,
	scopeKey,
	type MemoryEntry,
	type ParseIssue,
	type TopicFile,
} from "./schema.js";
import { isWellFormed, type MemoryStore } from "./resolver.js";

// ─── Requests and results ───────────────────────────────────────────────────

export type Resolution = "supersede" | "merge" | "withdraw" | "keep-both-flagged" | "discard";

export const RESOLUTIONS: readonly Resolution[] = ["supersede", "merge", "withdraw", "keep-both-flagged", "discard"];

export interface WriteRequest {
	/** Memory-bank-relative topic file under knowledge/, e.g. "knowledge/ui.md". */
	file: string;
	/** Assertion key, e.g. "ui.background". */
	key: string;
	/** Scope exactly as written: "global" | "project:<name>" | "path:<glob>". */
	scope: string;
	kind: string;
	body: string;
	/** Required: authority is decided by date, so the gate never invents one. */
	asOf?: string;
	source?: string;
	/** Optional revision date → heading becomes `key@YYYY-MM-DD`. */
	revision?: string;
	status?: string;
	/** Extra fields this schema does not model; preserved verbatim. */
	fields?: Record<string, string>;
	/** Second call only, answering a refusal. */
	resolve?: Resolution;
	/** Must match the `conflictId` of the refusal it answers. */
	conflictId?: string;
	/** Required when `resolve: "merge"`. Merging is a decision, not a concatenation. */
	mergedBody?: string;
	/** One-line "why", appended to the `source:` line for the audit trail. */
	note?: string;
}

export type ChangeKind = "created-file" | "added-entry" | "amended-entry" | "superseded-entry" | "withdrew-entry";

export interface EntryChange {
	change: ChangeKind;
	heading: string;
}

export interface FileEdit {
	path: string;
	content: string;
	changes: EntryChange[];
}

export interface EditPlan {
	files: FileEdit[];
	summary: string;
	/** Non-blocking observations, e.g. a date that moved backwards. */
	warnings: string[];
}

export type RejectReason =
	| "invalid-entry"
	| "missing-asOf"
	| "bad-resolution"
	| "stale-conflict"
	| "missing-merged-body"
	| "bad-file-path";

export type GateResult =
	| { kind: "plan"; plan: EditPlan }
	| { kind: "unchanged"; entry: MemoryEntry; explanation: string }
	| { kind: "discarded"; explanation: string }
	| {
			kind: "conflict";
			conflictId: string;
			identity: string;
			incoming: MemoryEntry;
			candidates: MemoryEntry[];
			suggested: Resolution;
			explanation: string;
	  }
	| { kind: "reject"; reason: RejectReason; explanation: string; issues: ParseIssue[] };

/** A refusal because a rival live claim exists — the queue stores these. */
export type ConflictRefusal = Extract<GateResult, { kind: "conflict" }>;

// ─── Decision ───────────────────────────────────────────────────────────────

export function decide(store: MemoryStore, request: WriteRequest): GateResult {
	const pathProblem = validateEntryPath(request.file);
	if (pathProblem) {
		return { kind: "reject", reason: "bad-file-path", explanation: pathProblem, issues: [] };
	}

	const incoming = buildEntry(request);
	const errors = incoming.issues.filter((issue) => issue.severity === "error");
	if (errors.length > 0) {
		return {
			kind: "reject",
			reason: "invalid-entry",
			explanation:
				"The incoming entry cannot be written: key, scope, status and asOf decide identity and precedence, " +
				"so a malformed value is refused rather than defaulted. A claim this store cannot compare with the " +
				"others is a claim it can never arbitrate.",
			issues: errors,
		};
	}
	if (request.asOf === undefined) {
		return {
			kind: "reject",
			reason: "missing-asOf",
			explanation:
				"asOf is required on every write: authority between claims is decided by date, so the gate will not invent a date on your behalf.",
			issues: incoming.issues,
		};
	}

	const identity = identityOf(incoming);
	if (identity === null) {
		return { kind: "reject", reason: "invalid-entry", explanation: "The incoming entry has no computable identity.", issues: incoming.issues };
	}

	const target = store.byPath.get(request.file) ?? null;
	const named = target?.entries.find((entry) => entry.heading === incoming.heading) ?? null;

	if (named) return amend(store, request, target!, named, incoming);

	// A rival claim: same assertion, same scope, different entry — any file. An
	// incoming entry that is not itself a live claim (a tombstone, a migration
	// record) asserts nothing, so it cannot contest anything.
	const live = incoming.status === "active" ? liveClaimsFor(store, identity) : [];
	if (live.length === 0) return addEntry(store, request, incoming, target);

	if (request.resolve === undefined) return conflictResult(incoming, live, identity, request);

	if (!RESOLUTIONS.includes(request.resolve)) {
		return { kind: "reject", reason: "bad-resolution", explanation: `resolve must be one of: ${RESOLUTIONS.join(", ")}.`, issues: [] };
	}
	if (request.conflictId !== conflictIdFor(identity, live, incoming)) {
		return {
			kind: "reject",
			reason: "stale-conflict",
			explanation:
				"conflictId does not match the current state of this identity — the store changed since the refusal. " +
				"Re-run the write without resolve to see the live candidates.",
			issues: [],
		};
	}
	if (request.resolve === "discard") {
		return {
			kind: "discarded",
			explanation: `Incoming claim not written; ${live.map((entry) => `${entry.heading} (${entry.path})`).join(", ")} remains the authority.`,
		};
	}
	if (request.resolve === "merge" && !request.mergedBody?.trim()) {
		return {
			kind: "reject",
			reason: "missing-merged-body",
			explanation: "resolve: merge needs mergedBody — merging two claims is a decision, not a concatenation.",
			issues: [],
		};
	}

	return resolveConflict(store, request, incoming, live, target);
}

// ─── The three write paths ──────────────────────────────────────────────────

/** Ordinary authoring: replacing the text of an entry that already exists. */
function amend(
	store: MemoryStore,
	request: WriteRequest,
	target: TopicFile,
	existing: MemoryEntry,
	incoming: MemoryEntry,
): GateResult {
	void store;
	if (normalizeBody(existing.body) === normalizeBody(incoming.body)) {
		return {
			kind: "unchanged",
			entry: existing,
			explanation: `No text change for ${existing.heading} in ${request.file}.`,
		};
	}

	const warnings: string[] = [];
	const merged = withPath(incoming, request.file);
	if (existing.asOf && existing.asOf !== merged.asOf) {
		merged.fields.amendedFrom = existing.asOf;
		if (merged.asOf && merged.asOf < existing.asOf) {
			warnings.push(
				`${existing.heading}: asOf moved backwards (${existing.asOf} → ${merged.asOf}). Allowed, but this entry now sorts below any claim dated between the two.`,
			);
		}
	}

	const file = cloneFile(target);
	file.entries[file.entries.findIndex((entry) => entry.heading === existing.heading)] = merged;

	return {
		kind: "plan",
		plan: {
			files: [{ path: request.file, content: renderTopicFile(file), changes: [{ change: "amended-entry", heading: existing.heading }] }],
			summary: `Amended ${existing.heading} in ${request.file}.`,
			warnings,
		},
	};
}

function addEntry(store: MemoryStore, request: WriteRequest, incoming: MemoryEntry, target: TopicFile | null): GateResult {
	void store;
	const file = target ? cloneFile(target) : { path: request.file, title: titleFromPath(request.file), entries: [], issues: [] };
	file.entries.push(withPath(incoming, request.file));

	const changes: EntryChange[] = target ? [{ change: "added-entry", heading: incoming.heading }] : [{ change: "created-file", heading: incoming.heading }];
	return {
		kind: "plan",
		plan: {
			files: [{ path: request.file, content: renderTopicFile(file), changes }],
			summary: target ? `Added ${incoming.heading} to ${request.file}.` : `Created ${request.file} with ${incoming.heading}.`,
			warnings: [],
		},
	};
}

/** The caller has resolved the conflict; apply it across every affected file. */
function resolveConflict(
	store: MemoryStore,
	request: WriteRequest,
	incoming: MemoryEntry,
	live: MemoryEntry[],
	target: TopicFile | null,
): GateResult {
	const files = new Map<string, TopicFile>();
	for (const entry of live) {
		const source = store.byPath.get(entry.path);
		if (source && !files.has(entry.path)) files.set(entry.path, cloneFile(source));
	}
	const destination = target ?? (files.get(request.file) ?? { path: request.file, title: titleFromPath(request.file), entries: [], issues: [] });
	if (!files.has(request.file)) files.set(request.file, cloneFile(destination));
	const home = files.get(request.file)!;

	const keepBoth = request.resolve === "keep-both-flagged";
	const withdraw = request.resolve === "withdraw";
	const created = withPath(incoming, request.file);
	if (request.resolve === "merge") created.body = request.mergedBody!.trim();
	const rivalRefs = live.map((entry) => `${entry.path}#${entry.heading}`).join(", ");
	if (!withdraw) home.entries.push(created);
	// Provenance for the decision itself: an accepted rival should say who
	// settled it and how, or the record looks like the claim appeared by itself.
	if (!withdraw) created.fields.resolution = request.note ? `${request.resolve} — ${request.note}` : request.resolve!;
	if (keepBoth) {
		// Deliberately leaving the identity contested: recorded so the doctor and
		// the human can see *what* it is contested with, not just that it is.
		created.fields.contestedWith = rivalRefs;
	} else if (!withdraw) {
		created.supersedes = rivalRefs;
		created.fields.supersedes = rivalRefs;
	}

	const changes = new Map<string, EntryChange[]>();
	const note = (path: string, change: EntryChange): void => {
		const list = changes.get(path);
		if (list) list.push(change);
		else changes.set(path, [change]);
	};

	if (withdraw) {
		// Withdraw settles the contest by removing the claims; nothing new is
		// asserted, so `created` is deliberately never pushed above.
		for (const entry of live) {
			const file = files.get(entry.path)!;
			const stored = file.entries.find((candidate) => candidate.heading === entry.heading);
			if (!stored) continue;
			stored.status = "withdrawn";
			stored.fields.withdrawnOn = request.asOf ?? "";
			note(entry.path, { change: "withdrew-entry", heading: entry.heading });
		}
	} else if (!keepBoth) {
		for (const entry of live) {
			const file = files.get(entry.path)!;
			const stored = file.entries.find((candidate) => candidate.heading === entry.heading);
			if (!stored) continue;
			stored.status = "superseded";
			stored.supersededBy = `${request.file}#${created.heading}`;
			note(entry.path, { change: "superseded-entry", heading: entry.heading });
		}
		note(request.file, { change: "added-entry", heading: created.heading });
	} else {
		note(request.file, { change: "added-entry", heading: created.heading });
	}

	const edits: FileEdit[] = [];
	for (const [path, file] of files) {
		const list = changes.get(path);
		if (!list) continue; // untouched after cloning
		edits.push({ path, content: renderTopicFile(file), changes: list });
	}

	const claimants = live.map((entry) => `${entry.heading} (${entry.path})`).join(", ");
	const summary = keepBoth
		? `Wrote ${created.heading} alongside ${claimants}: this identity is contested, so nothing will be injected for it until it is resolved.`
		: request.resolve === "withdraw"
			? `Withdrew ${claimants}. Nothing new was claimed.`
			: request.resolve === "merge"
				? `Merged ${claimants} into ${created.heading}.`
				: `Superseded ${claimants} with ${created.heading}.`;

	return {
		kind: "plan",
		plan: { files: edits, summary, warnings: keepBoth ? [`${incoming.key}@${scopeKey(incoming.scope)} is now deliberately contested — /memory doctor will report it until it is resolved.`] : [] },
	};
}

// ─── Conflict reporting and identity ────────────────────────────────────────

/** Live, comparable claims for one identity — in any file. */
function liveClaimsFor(store: MemoryStore, identity: string): MemoryEntry[] {
	const out: MemoryEntry[] = [];
	for (const entry of store.entries) {
		if (entry.status !== "active" || !isWellFormed(entry)) continue;
		if (identityOf(entry) === identity) out.push(entry);
	}
	return out.sort((a, b) => (a.path === b.path ? a.heading.localeCompare(b.heading) : a.path.localeCompare(b.path)));
}

function conflictResult(incoming: MemoryEntry, live: MemoryEntry[], identity: string, request: WriteRequest): GateResult {
	const newest = [...live].sort((a, b) => ((a.asOf ?? "") < (b.asOf ?? "") ? 1 : -1))[0] ?? null;
	const incomingNewer = Boolean(newest && incoming.asOf && incoming.asOf > (newest.asOf ?? ""));
	const suggested: Resolution = incomingNewer ? "supersede" : "merge";
	const claimants = live.map((entry) => `${entry.heading} (${entry.asOf ?? "undated"}, ${entry.path})`);

	return {
		kind: "conflict",
		conflictId: conflictIdFor(identity, live, incoming),
		identity,
		incoming,
		candidates: live,
		suggested,
		explanation:
			`${incoming.heading} (${request.asOf}) competes with ${claimants.join("; ")} for the assertion ` +
			`"${incoming.key}" in scope ${scopeKey(incoming.scope)}. Nothing was written. ` +
			`Re-invoke with resolve: ${RESOLUTIONS.join(" | ")} and conflictId: ${conflictIdFor(identity, live, incoming)}` +
			(incomingNewer ? " — suggested: supersede, the incoming claim is the newest dated." : ""),
	};
}

/**
 * Stable id for one conflict. The second call must carry it: it is what makes a
 * resolution apply to the state the caller was *shown*, and nothing else. If the
 * store changed underneath, the id no longer matches and the write is refused
 * again rather than applied to a state nobody reviewed.
 */
export function conflictIdFor(identity: string, live: MemoryEntry[], incoming: MemoryEntry): string {
	const parts = [
		identity,
		...live.map((entry) => `${entry.heading}|${entry.asOf ?? ""}|${normalizeBody(entry.body)}`).sort(),
		`${incoming.heading}|${incoming.asOf ?? ""}|${normalizeBody(incoming.body)}`,
	];
	const text = parts.join("\u0001");
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

// ─── Incoming entry construction and validation ─────────────────────────────

/**
 * Build the entry the caller described by rendering it and reading it back
 * through the same parser the store uses — one source of truth for what a valid
 * entry is, so the gate can never accept something the resolver would reject.
 */
function buildEntry(request: WriteRequest): MemoryEntry {
	const heading = request.revision ? `${request.key}@${request.revision}` : request.key;
	const fields: Record<string, string> = {
		kind: request.kind,
		scope: request.scope,
		...(request.asOf ? { asOf: request.asOf } : {}),
		...(request.source ? { source: request.source } : {}),
		...(request.status ? { status: request.status } : {}),
		...(request.fields ?? {}),
	};

	const lines = [`# ${titleFromPath(request.file)}`, "", `## ${heading}`];
	for (const [name, value] of Object.entries(fields)) lines.push(`- ${name}: ${value}`);
	lines.push("", request.body ?? "");

	const parsed = parseTopicFile(lines.join("\n"), request.file);
	const entry = parsed.entries[0];
	if (!entry) {
		return {
			path: request.file,
			heading,
			key: request.key,
			kind: "fact",
			status: "active",
			scope: parseScope(request.scope),
			body: request.body ?? "",
			fields,
			range: { start: 1, end: 1 },
			issues: [{ severity: "error", code: "unparsable-entry", message: "The incoming entry could not be parsed at all." }],
		};
	}
	return entry;
}

/**
 * The gate writes entry stores; prose files (core/, history/) are not its
 * business. Exported so the filesystem layer applies the *same* rule as the
 * gate instead of a second copy that can drift.
 */
export function validateEntryPath(file: string): string | null {
	if (!file || file.startsWith("/") || file.includes("..") || file.includes("\\")) {
		return `file must be a memory-bank-relative path with no ".." (got "${file}")`;
	}
	if (!file.endsWith(".md")) return `file must be a markdown topic file ending in .md (got "${file}")`;
	const segments = file.split("/");
	if (segments.length !== 2 || segments[0] !== "knowledge") {
		return `entries live in knowledge/<topic>.md — core/ and history/ files are prose, not entry stores (got "${file}")`;
	}
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(segments[1]!.slice(0, -3))) {
		return `topic file name must be a lowercase slug (got "${file}")`;
	}
	return null;
}

function cloneFile(file: TopicFile): TopicFile {
	return {
		path: file.path,
		title: file.title,
		issues: [],
		entries: file.entries.map((entry) => ({ ...entry, fields: { ...entry.fields }, issues: [] })),
	};
}

function withPath(entry: MemoryEntry, path: string): MemoryEntry {
	return { ...entry, path, fields: { ...entry.fields }, issues: [] };
}

function normalizeBody(body: string): string {
	return body.replace(/\s+/g, " ").trim();
}

function titleFromPath(file: string): string {
	return file.split("/").pop()!.replace(/\.md$/, "");
}
