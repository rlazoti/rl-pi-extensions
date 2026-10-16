/**
 * The pending queue: refusals that nobody has answered yet.
 *
 * A conflict refusal is a decision point. If the human is not around to make it
 * (no UI, print/json/rpc mode, dialog dismissed, session ended), the refusal must
 * not evaporate with the turn — it is stored, surfaced every turn until answered,
 * and walked by `/memory resolve`.
 *
 * Stored as JSON, not markdown, on purpose: the record has to be re-submitted to
 * the gate **verbatim**, and parsing prose back into a write request is exactly
 * the re-interpretation risk this component exists to remove. `renderConflict` is
 * where the human-readable view lives.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { MemoryPaths } from "./fs-store.js";
import type { ConflictRefusal, Resolution, WriteRequest } from "./gate.js";
import { formatIdentity, type MemoryEntry } from "./schema.js";

export const PENDING_VERSION = 1;

const ID_PATTERN = /^[0-9a-f]{8}$/;

export interface PendingConflict {
	version: number;
	/** The gate's conflictId: the second write must carry it or be refused. */
	id: string;
	identity: string;
	/** Topic file the incoming claim was aimed at. */
	file: string;
	/** RFC 3339 instant the refusal happened. */
	createdAt: string;
	/** The exact request to re-send. */
	request: WriteRequest;
	/** The live claims the human was shown, in the order they were shown. */
	candidates: Array<{ path: string; heading: string; key: string; asOf?: string; source?: string; body: string }>;
	incoming: { heading: string; asOf?: string; source?: string; body: string };
	suggested: Resolution;
	explanation: string;
}

export type { ConflictRefusal };

function conflictPath(paths: MemoryPaths, id: string): string | null {
	if (!ID_PATTERN.test(id)) return null;
	return path.join(paths.pending, `${id}.json`);
}

/**
 * Store a refusal. Idempotent per conflictId: re-refusing the same contest (the
 * agent retried the write, or a second session hit it) updates one record rather
 * than piling up duplicates that all need resolving.
 */
export function saveConflict(paths: MemoryPaths, refusal: ConflictRefusal, request: WriteRequest, now = new Date().toISOString()): PendingConflict {
	const conflict: PendingConflict = {
		version: PENDING_VERSION,
		id: refusal.conflictId,
		identity: refusal.identity,
		file: request.file,
		createdAt: now,
		request,
		candidates: refusal.candidates.map((entry) => summarize(entry)),
		incoming: summarize(refusal.incoming),
		suggested: refusal.suggested,
		explanation: refusal.explanation,
	};
	const target = conflictPath(paths, conflict.id);
	if (target === null) throw new Error(`unusable conflictId: ${conflict.id}`);
	fs.mkdirSync(paths.pending, { recursive: true });
	const temp = `${target}.tmp-${process.pid}`;
	fs.writeFileSync(temp, `${JSON.stringify(conflict, null, 2)}\n`, "utf8");
	fs.renameSync(temp, target);
	return conflict;
}

export interface PendingList {
	conflicts: PendingConflict[];
	/** Files that failed to read or parse, reported rather than skipped. */
	corrupt: Array<{ file: string; error: string }>;
}

export function listConflicts(paths: MemoryPaths): PendingList {
	const conflicts: PendingConflict[] = [];
	const corrupt: PendingList["corrupt"] = [];

	let names: string[];
	try {
		names = fs.readdirSync(paths.pending);
	} catch {
		return { conflicts, corrupt };
	}

	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(paths.pending, name);
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PendingConflict;
			const problem = validate(parsed, name);
			if (problem) {
				corrupt.push({ file: name, error: problem });
				continue;
			}
			conflicts.push(parsed);
		} catch (error) {
			corrupt.push({ file: name, error: error instanceof Error ? error.message : String(error) });
		}
	}

	// Oldest first: the queue is a worklist, and the store should not reorder the
	// human's attention. Equal timestamps order by id so the list is stable.
	conflicts.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	return { conflicts, corrupt };
}

export function loadConflict(paths: MemoryPaths, id: string): PendingConflict | null {
	const target = conflictPath(paths, id);
	if (target === null) return null;
	try {
		const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as PendingConflict;
		return validate(parsed, id) ? null : parsed;
	} catch {
		return null;
	}
}

export function deleteConflict(paths: MemoryPaths, id: string): boolean {
	const target = conflictPath(paths, id);
	if (target === null) return false;
	try {
		fs.rmSync(target);
		return true;
	} catch {
		return false;
	}
}

function validate(value: PendingConflict, name: string): string | null {
	if (typeof value !== "object" || value === null) return `${name}: not an object`;
	if (value.version !== PENDING_VERSION) return `${name}: unsupported pending version ${String(value.version)}`;
	if (!ID_PATTERN.test(value.id)) return `${name}: id ${String(value.id)} is not a conflictId`;
	if (!value.request || typeof value.request.key !== "string" || typeof value.request.file !== "string") return `${name}: request is missing key or file`;
	if (!Array.isArray(value.candidates)) return `${name}: candidates must be a list`;
	return null;
}

function summarize(entry: MemoryEntry): PendingConflict["candidates"][number] {
	return {
		path: entry.path,
		heading: entry.heading,
		key: entry.key,
		...(entry.asOf ? { asOf: entry.asOf } : {}),
		...(entry.source ? { source: entry.source } : {}),
		body: entry.body,
	};
}

/** The human-facing view: enough to decide, without re-deriving anything. */
/** The two sides of a contest, in either shape: the gate's live entries or a
 *  stored queue record. Both render the same way, everywhere. */
export interface ContestSide {
	heading: string;
	path?: string;
	asOf?: string;
	source?: string;
	body: string;
}

export interface Contest {
	incoming: ContestSide;
	candidates: ContestSide[];
	explanation: string;
}

/**
 * A decision nobody can see is not a decision. This is the one rendering of "what
 * the bank says now, what is being written, and the rule that refused it" — the
 * queue view, the interactive dialog and the tool result all use it, so a human
 * never has to choose between options whose meaning they cannot see.
 *
 * `truncate` collapses whitespace and caps each side: the dialog has to fit on one
 * screen, and the queue file keeps the full text for `/memory pending`.
 */
export function formatContest(contest: Contest, options: { truncate?: number } = {}): string {
	const claim = (side: ContestSide, limit: number | undefined) => {
		const body = limit ? truncate(side.body, limit) : side.body.trim();
		return [
			`${side.heading}${side.asOf ? ` · asOf ${side.asOf}` : ""}${side.source ? ` · source: ${side.source}` : ""}${side.path ? ` · in ${side.path}` : ""}:`,
			indent(body),
		].join("\n");
	};
	const lines = ["In the bank now:", ...(contest.candidates.length > 0 ? contest.candidates.map((side) => claim(side, options.truncate)) : ["  (nothing — this key has no live claim)"]), "", "Being written:", claim(contest.incoming, options.truncate), "", "Why this is refused:", indent(contest.explanation)];
	return lines.join("\n");
}

export function renderConflict(conflict: PendingConflict): string {
	const lines = [
		`Conflict ${conflict.id} — ${formatIdentity(conflict.identity)}`,
		`Opened ${conflict.createdAt}, aimed at ${conflict.file}`,
		"",
		formatContest(conflict),
		"",
		`Suggested: ${conflict.suggested}.`,
	];
	return `${lines.join("\n")}\n`;
}

/** One line, capped: for prompt injections and dialog previews, where a whole entry
 *  is either noise or unreadable. */
export function clip(text: string, limit: number): string {
	return truncate(text, limit);
}

function truncate(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= limit) return flat;
	// Cut at a word, not mid-word: a line ending in "in s…" reads like a bug and the
	// reader cannot tell what was truncated.
	const cut = flat.slice(0, limit);
	return `${(cut.lastIndexOf(" ") > limit * 0.6 ? cut.slice(0, cut.lastIndexOf(" ")) : cut).trimEnd()}…`;
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}
