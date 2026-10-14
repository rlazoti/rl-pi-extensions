/**
 * Entry schema for the memory extension.
 *
 * A knowledge topic file is one authority surface (`knowledge/ui.md`) holding
 * typed *entries* (`## ui.background`). An entry is the unit of indexing,
 * injection, precedence, and diffing — not the file.
 *
 * Design rule: fields that decide *identity* or *authority* (key, scope, status,
 * asOf) are never silently normalized. A bad value produces an error-severity
 * issue, and an entry with an error issue is not injectable until it is fixed.
 * Fields that only annotate (kind, source) may default with a warning.
 *
 * This module is pure: no fs, no Pi, no clock. Dates are data, never `Date.now()`.
 */

// ─── Vocabularies ───────────────────────────────────────────────────────────

export const ENTRY_KINDS = [
	"rule",
	"preference",
	"decision",
	"fact",
	"procedure",
	"gotcha",
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const ENTRY_STATUSES = ["active", "superseded", "withdrawn"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

/** `invalid` exists so a malformed scope can never masquerade as `global`. */
export type ScopeLevel = "global" | "project" | "path" | "invalid";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EntryScope {
	level: ScopeLevel;
	/** Project name or path glob; absent for `global`. */
	value?: string;
	/** Scope exactly as written, kept for diagnostics and rendering. */
	raw: string;
}

export interface LineRange {
	/** 1-based, inclusive. */
	start: number;
	/** 1-based, inclusive. */
	end: number;
}

export type IssueSeverity = "error" | "warning";

export interface ParseIssue {
	severity: IssueSeverity;
	code: string;
	message: string;
	/** Assertion key of the offending entry, when the issue is entry-scoped. */
	key?: string;
	/** 1-based line of the offending heading or field. */
	line?: number;
}

export interface MemoryEntry {
	/** Heading text exactly as written after `## `. */
	heading: string;
	/** Assertion key with any `@YYYY-MM-DD` revision suffix removed. */
	key: string;
	/** Revision suffix when the heading carried one (`ui.background@2026-06-14`). */
	revision?: string;
	kind: EntryKind;
	status: EntryStatus;
	scope: EntryScope;
	asOf?: string;
	source?: string;
	/** Raw `supersedes:` reference (key, optionally @revision). */
	supersedes?: string;
	/** Entry text after the metadata block, trimmed. */
	body: string;
	/** Fields this schema does not know about, preserved verbatim. */
	fields: Record<string, string>;
	range: LineRange;
	issues: ParseIssue[];
}

export interface TopicFile {
	path: string;
	title: string;
	entries: MemoryEntry[];
	/** File-level issues only; entry issues live on the entry. */
	issues: ParseIssue[];
}

// ─── Grammar ────────────────────────────────────────────────────────────────

export const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REVISION_PATTERN = /^(.+)@(\d{4}-\d{2}-\d{2})$/;
const META_PATTERN = /^-\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/;
const HEADING_PATTERN = /^ {0,3}(#{1,6})\s+(.*\S)\s*$/;
const FENCE_PATTERN = /^ {0,3}(```|~~~)/;

const KNOWN_FIELDS = ["kind", "scope", "asOf", "source", "supersedes", "status"] as const;
const KNOWN_FIELD_SET = new Set<string>(KNOWN_FIELDS);

export function isAssertionKey(text: string): boolean {
	return KEY_PATTERN.test(text);
}

/** Split a heading into assertion key and optional `@YYYY-MM-DD` revision. */
export function splitRevision(heading: string): { key: string; revision?: string } {
	const match = REVISION_PATTERN.exec(heading);
	if (!match) return { key: heading };
	return { key: match[1]!, revision: match[2] };
}

export function parseScope(raw: string): EntryScope {
	const value = raw.trim();
	if (value === "global") return { level: "global", raw: value };
	if (value.startsWith("project:")) {
		const name = value.slice("project:".length).trim();
		return name
			? { level: "project", value: name, raw: value }
			: { level: "invalid", raw: value };
	}
	if (value.startsWith("path:")) {
		const glob = value.slice("path:".length).trim();
		return glob
			? { level: "path", value: glob, raw: value }
			: { level: "invalid", raw: value };
	}
	return { level: "invalid", raw: value };
}

/** Identity key for a scope. Distinct from `global` for every malformed scope. */
export function scopeKey(scope: EntryScope): string {
	if (scope.level === "global") return "global";
	if (scope.level === "invalid") return `invalid:${scope.raw}`;
	return `${scope.level}:${scope.value ?? ""}`;
}

/** More specific scopes outrank less specific ones. */
export function specificityRank(scope: EntryScope): number {
	if (scope.level === "project") return 3;
	if (scope.level === "path") return 2;
	if (scope.level === "global") return 1;
	return 0;
}

/**
 * Stable identity of a claim: assertion key + scope, revision ignored. At most
 * one *active* entry per identity may ever be injected. Null when the entry is
 * too malformed to be compared.
 */
export function identityOf(entry: MemoryEntry): string | null {
	if (!isAssertionKey(entry.key)) return null;
	if (entry.scope.level === "invalid") return null;
	return `${entry.key}\u0000${scopeKey(entry.scope)}`;
}

export function hasError(issues: ParseIssue[]): boolean {
	return issues.some((issue) => issue.severity === "error");
}

/** Only `active`, structurally valid entries reach the model. */
export function isInjectable(entry: MemoryEntry): boolean {
	return entry.status === "active" && !hasError(entry.issues);
}

// ─── Authority order ────────────────────────────────────────────────────────

/**
 * Total order deciding which entry wins when several claim the same key.
 * Negative when `a` outranks `b`. Similarity never appears here on purpose:
 * retrieval picks candidates, this picks the authority.
 *
 *   1. scope specificity (project > path > global > invalid)
 *   2. asOf descending — an explicit date always beats a missing one
 *   3. assertion key ascending, then heading ascending (determinism)
 *
 * Entries with the same (key, scope) compare by date: this is what makes the
 * supersede chain deterministic, and it is *not* a substitute for the write-time
 * gate, which refuses two active claims on one identity outright.
 */
export function compareAuthority(a: MemoryEntry, b: MemoryEntry): number {
	const bySpecificity = specificityRank(b.scope) - specificityRank(a.scope);
	if (bySpecificity !== 0) return bySpecificity;

	const aDate = a.asOf ?? "";
	const bDate = b.asOf ?? "";
	if (aDate !== bDate) return aDate < bDate ? 1 : -1;

	if (a.key !== b.key) return a.key < b.key ? -1 : 1;
	if (a.heading !== b.heading) return a.heading < b.heading ? -1 : 1;
	return 0;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

interface RawEntry {
	heading: string;
	startLine: number;
	lines: string[];
}

/**
 * Parse one knowledge topic file. Tolerant by construction: a broken file must
 * still produce a report the doctor and the migration path can act on, so every
 * problem becomes an issue rather than an exception.
 */
export function parseTopicFile(text: string, filePath: string): TopicFile {
	const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const issues: ParseIssue[] = [];

	let title = "";
	const rawEntries: RawEntry[] = [];
	let current: RawEntry | null = null;
	let fence: string | null = null;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const trimmed = line.trim();

		if (fence) {
			if (trimmed.startsWith(fence)) fence = null;
			current?.lines.push(line);
			continue;
		}
		const fenceOpen = FENCE_PATTERN.exec(line);
		if (fenceOpen) {
			fence = fenceOpen[1]!;
			current?.lines.push(line);
			continue;
		}

		const heading = HEADING_PATTERN.exec(line);
		if (heading) {
			const level = heading[1]!.length;
			const headingText = heading[2]!;
			if (level === 1 && !current && !title) {
				title = headingText;
				continue;
			}
			if (level === 2) {
				current = { heading: headingText, startLine: index + 1, lines: [] };
				rawEntries.push(current);
				continue;
			}
		}

		current?.lines.push(line);
	}

	if (fence) {
		issues.push({
			severity: "error",
			code: "unclosed-fence",
			message: "A code fence is still open at end of file; headings after it were treated as body text.",
		});
	}
	if (!title) {
		title = filePath.split("/").pop()?.replace(/\.md$/, "") ?? filePath;
		issues.push({
			severity: "warning",
			code: "missing-title",
			message: `No top-level heading; topic title falls back to "${title}".`,
		});
	}
	if (rawEntries.length === 0) {
		issues.push({
			severity: "warning",
			code: "no-entries",
			message: "No `## <assertion-key>` entries; this file is pre-schema prose and needs migration.",
		});
	}

	const entries = rawEntries.map((raw) => parseEntry(raw));
	markDuplicateIdentities(entries);

	return { path: filePath, title, entries, issues };
}

function parseEntry(raw: RawEntry): MemoryEntry {
	const issues: ParseIssue[] = [];
	const fields: Record<string, string> = {};

	// Metadata is the leading run of `- field: value` lines; the first other
	// non-blank line starts the body and everything after it stays body.
	let cursor = 0;
	while (cursor < raw.lines.length && raw.lines[cursor]!.trim() === "") cursor++;

	while (cursor < raw.lines.length) {
		const meta = META_PATTERN.exec(raw.lines[cursor]!.trim());
		if (!meta) break;
		const name = meta[1]!;
		const value = meta[2]!.trim();
		if (Object.hasOwn(fields, name)) {
			issues.push({
				severity: "warning",
				code: "duplicate-field",
				message: `Repeated \`${name}:\` field; keeping the first value.`,
				line: raw.startLine,
			});
		} else {
			fields[name] = value;
		}
		cursor++;
		while (cursor < raw.lines.length && raw.lines[cursor]!.trim() === "") cursor++;
	}

	const body = raw.lines.slice(cursor).join("\n").trim();
	const { key, revision } = splitRevision(raw.heading.trim());

	const entry: MemoryEntry = {
		heading: raw.heading.trim(),
		key,
		kind: "fact",
		status: "active",
		scope: { level: "global", raw: "global" },
		body,
		fields,
		range: { start: raw.startLine, end: raw.startLine + raw.lines.length },
		issues,
	};
	if (revision) entry.revision = revision;

	if (!isAssertionKey(entry.key)) {
		issues.push({
			severity: "error",
			code: "bad-key",
			message: `"${entry.key}" is not an assertion key (expected a lowercase dotted slug such as ui.background).`,
			key: entry.key,
			line: raw.startLine,
		});
	}

	const kind = fields.kind;
	if (kind === undefined) {
		issues.push({ severity: "warning", code: "missing-kind", message: "No `kind:` field; defaulting to `fact`.", key: entry.key, line: raw.startLine });
	} else if (!isEntryKind(kind)) {
		const folded = ENTRY_KINDS.find((candidate) => candidate === kind.toLowerCase());
		if (folded) {
			entry.kind = folded;
			issues.push({ severity: "warning", code: "bad-kind", message: `\`kind: ${kind}\` normalized to \`${folded}\`.`, key: entry.key, line: raw.startLine });
		} else {
			issues.push({ severity: "error", code: "bad-kind", message: `\`kind: ${kind}\` is not one of ${ENTRY_KINDS.join(", ")}.`, key: entry.key, line: raw.startLine });
		}
	} else {
		entry.kind = kind;
	}

	const scope = fields.scope;
	if (scope === undefined) {
		issues.push({ severity: "warning", code: "missing-scope", message: "No `scope:` field; defaulting to `global`.", key: entry.key, line: raw.startLine });
	} else {
		entry.scope = parseScope(scope);
		if (entry.scope.level === "invalid") {
			issues.push({
				severity: "error",
				code: "bad-scope",
				message: `\`scope: ${scope}\` must be \`global\`, \`project:<name>\`, or \`path:<glob>\`. It is not treated as global.`,
				key: entry.key,
				line: raw.startLine,
			});
		}
	}

	const asOf = fields.asOf;
	if (asOf === undefined) {
		issues.push({ severity: "warning", code: "missing-asOf", message: "No `asOf:` date; this entry sorts last in an authority tie and needs one.", key: entry.key, line: raw.startLine });
	} else if (!DATE_PATTERN.test(asOf)) {
		entry.asOf = asOf;
		issues.push({ severity: "error", code: "bad-asOf", message: `\`asOf: ${asOf}\` must be YYYY-MM-DD.`, key: entry.key, line: raw.startLine });
	} else {
		entry.asOf = asOf;
	}

	const status = fields.status;
	if (status !== undefined) {
		if (isEntryStatus(status)) {
			entry.status = status;
		} else {
			issues.push({ severity: "error", code: "bad-status", message: `\`status: ${status}\` is not one of ${ENTRY_STATUSES.join(", ")}.`, key: entry.key, line: raw.startLine });
		}
	}

	if (fields.source !== undefined) entry.source = fields.source;

	if (fields.supersedes !== undefined) {
		entry.supersedes = fields.supersedes;
		const ref = splitRevision(fields.supersedes);
		if (!isAssertionKey(ref.key)) {
			issues.push({ severity: "warning", code: "bad-supersedes", message: `\`supersedes: ${fields.supersedes}\` is not an assertion key.`, key: entry.key, line: raw.startLine });
		}
	}

	for (const name of Object.keys(fields)) {
		if (!KNOWN_FIELD_SET.has(name)) {
			issues.push({ severity: "warning", code: "unknown-field", message: `Unknown field \`${name}:\` kept verbatim; this schema does not read it.`, key: entry.key, line: raw.startLine });
		}
	}

	if (!body) {
		issues.push({ severity: "warning", code: "empty-body", message: "Entry has no body text.", key: entry.key, line: raw.startLine });
	}

	return entry;
}

/** Two `active` entries on one identity is the in-file form of a conflict. */
function markDuplicateIdentities(entries: MemoryEntry[]): void {
	const byIdentity = new Map<string, MemoryEntry[]>();
	for (const entry of entries) {
		const identity = identityOf(entry);
		if (identity === null) continue;
		const bucket = byIdentity.get(identity);
		if (bucket) bucket.push(entry);
		else byIdentity.set(identity, [entry]);
	}

	for (const bucket of byIdentity.values()) {
		const active = bucket.filter((entry) => entry.status === "active");
		if (active.length < 2) continue;
		for (const entry of active) {
			entry.issues.push({
				severity: "error",
				code: "duplicate-identity",
				message: `${active.length} active entries claim \`${entry.key}\` in scope \`${scopeKey(entry.scope)}\` (${bucket
					.map((other) => other.heading)
					.join(", ")}); exactly one may be active.`,
				key: entry.key,
				line: entry.range.start,
			});
		}
	}
}

function isEntryKind(value: string): value is EntryKind {
	return (ENTRY_KINDS as readonly string[]).includes(value);
}

function isEntryStatus(value: string): value is EntryStatus {
	return (ENTRY_STATUSES as readonly string[]).includes(value);
}

// ─── Rendering ──────────────────────────────────────────────────────────────

/** Canonical rendering of one entry. Field order is fixed so diffs stay clean. */
export function renderEntry(entry: MemoryEntry): string {
	const heading = entry.revision ? `${entry.key}@${entry.revision}` : entry.key;
	const lines = [`## ${heading}`];
	lines.push(`- kind: ${entry.kind}`);
	// An invalid scope is re-rendered verbatim so a report can be written back
	// without mutating the very field that is under investigation.
	lines.push(`- scope: ${entry.scope.level === "invalid" ? entry.scope.raw : scopeKey(entry.scope)}`);
	if (entry.asOf) lines.push(`- asOf: ${entry.asOf}`);
	if (entry.source) lines.push(`- source: ${entry.source}`);
	if (entry.supersedes) lines.push(`- supersedes: ${entry.supersedes}`);
	lines.push(`- status: ${entry.status}`);
	for (const [name, value] of Object.entries(entry.fields)) {
		if (KNOWN_FIELD_SET.has(name)) continue;
		lines.push(`- ${name}: ${value}`);
	}
	if (entry.body) {
		lines.push("");
		lines.push(entry.body);
	}
	return lines.join("\n");
}

/** Canonical rendering of the whole topic file. */
export function renderTopicFile(file: TopicFile): string {
	const parts = [`# ${file.title}`, ""];
	for (const entry of file.entries) parts.push(renderEntry(entry), "");
	return parts.join("\n").trimEnd() + "\n";
}
