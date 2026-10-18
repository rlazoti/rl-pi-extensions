/**
 * The entry grammar (R4-R7). Pure functions: parse, render, validate.
 *
 * A claim store file is hand-editable markdown with one entry per second-level
 * heading:
 *
 *     # Claims about git
 *     Optional prose that the writer keeps verbatim as the file's preamble.
 *
 *     ## git-standards.branch-naming
 *     kind: rule
 *     scope: global
 *     asOf: 2026-05-02
 *     source: Rodrigo, AGENTS.md §6
 *     tags: git; always
 *
 *     All Git branches are named rl-<MM>-<DD>-<short_description>, with the
 *     current local month and day, zero-padded.
 *
 * Why this shape: a heading plus `field: value` lines plus prose is the part of
 * markdown both a human and a parser read without a library, and the blank line
 * between the fields and the body is what makes a body line that happens to
 * contain a colon safe.
 *
 * A heading is also a wall. The text under a heading the grammar cannot read is
 * not part of any claim, so the claim above stops at it and the writer will not
 * rewrite the file until the unreadable heading is resolved.
 *
 * Byte stability (R6) comes from normalising on the way in and out: the body is
 * one logical paragraph (wrapped deterministically on write), and fields are
 * written in a fixed order with a fixed separator. `render(parse(render(x)))`
 * equals `render(x)`, which is what the second-pass tests check.
 */

import { isDay } from "./time.js";

export const BODY_MAX_CHARS = 600;
/** Body text is wrapped here on write. Chosen to keep `less` and split panes clean. */
export const BODY_WRAP_COLUMN = 88;

export type ClaimKind = "rule" | "fact";
export type ClaimState = "approved" | "pending";
export type ClaimOrigin = "agent" | "migration";

export interface Claim {
	key: string;
	kind: ClaimKind;
	/** Canonical scope string: `global`, `project:<id>` or `path:<glob>`. */
	scope: string;
	asOf: string;
	source: string;
	body: string;
	aliases: string[];
	tags: string[];
	links: string[];
	/** R17/R28: who produced the claim. Absent in a hand-written entry means agent. */
	origin: ClaimOrigin;
	/** R11: at most one approved and one pending claim per identity. */
	state: ClaimState;
	/** Set by `memory_propose`; drives the 14-day flag (R20, R28). */
	proposedAt?: string;
	deferredAt?: string;
	/** History only (R13). */
	supersededAt?: string;
	/** History only: a reject or a replaced draft, so nothing is deleted. */
	rejectedAt?: string;
	/** R24: reason an override was used, shown in review. */
	statusOverride?: string;
}

export interface EntryError {
	file: string;
	line: number;
	message: string;
}

export interface ParsedEntry {
	claim: Claim;
	file: string;
	startLine: number;
	endLine: number;
}

/** Text a store file holds that the grammar cannot read, and that the writer therefore
 * cannot put back. */
export interface UnreadableText {
	line: number;
	text: string;
	/** What to do about it, when the text alone does not say. */
	extra?: string;
}

export interface ParsedStore {
	file: string;
	preamble: string;
	entries: ParsedEntry[];
	errors: EntryError[];
	/**
	 * Lines no entry and the writer cannot put back: a heading with a key the grammar
	 * rejects, and the prose under it. They are reported, and a store write that
	 * would have to rewrite the file is refused while they are there — this is what
	 * stops the writer deleting what it cannot read.
	 */
	unreadable: { line: number; text: string; extra?: string }[];
}

const LIST_FIELDS = new Set(["aliases", "tags", "links"]);

/** Fields in the order the writer emits them. */
const FIELD_ORDER = [
	"kind",
	"scope",
	"asOf",
	"source",
	"origin",
	"state",
	"proposedAt",
	"deferredAt",
	"supersededAt",
	"rejectedAt",
	"statusOverride",
	"aliases",
	"tags",
	"links",
] as const;

const KNOWN_FIELDS = new Set<string>(FIELD_ORDER);
const REQUIRED_FIELDS = ["kind", "scope", "asOf", "source"] as const;

const KEY = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const HEADING = /^##\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/;
/** A line that separates blocks. `###` is not one: a deeper heading stays body text. */
const BOUNDARY = /^#{1,2}\s/;
/** A level-one heading: the file's preamble, not a claim. */
const H1 = /^#\s/;
const FIELD = /^([A-Za-z][A-Za-z0-9]*):(?:[ \t]*(.*))?$/;

/** What the grammar can name a claim, said in the words a human needs to fix it. */
export const KEY_HINT = "a claim heading is `## <key>`, where <key> is lowercase and holds letters, digits, dots, dashes and underscores";

/** An identity is key + scope (R11). Two approved claims on one identity are contested (R12). */
export function identityOf(claim: Claim): string {
	return `${claim.key}\u0000${claim.scope}`;
}

export function formatIdentity(claim: Claim): string {
	return `${claim.key} @ ${claim.scope}`;
}

export function charCount(text: string): number {
	// Code points, not UTF-16 units: an emoji in a source line must not eat the body budget.
	return Array.from(text).length;
}

/** Collapse a paragraph to one line with single spaces. Idempotent. */
export function normalizeBody(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Deterministic word wrap. Never starts a line with `#` (that would read as a heading). */
export function wrapBody(body: string, column = BODY_WRAP_COLUMN): string[] {
	const words = normalizeBody(body).split(" ").filter((w) => w !== "");
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const candidate = current === "" ? word : `${current} ${word}`;
		// A word longer than the column overflows rather than being split in half.
		if (current !== "" && (charCount(candidate) > column || word.startsWith("#"))) {
			lines.push(current);
			current = word;
		} else {
			current = candidate;
		}
	}
	if (current !== "") lines.push(current);
	return lines;
}

/** Validate a claim the writer is about to persist. Returns reasons; empty means ok. */
export function validateClaim(claim: Claim): string[] {
	const problems: string[] = [];
	if (!KEY.test(claim.key)) {
		problems.push(`key must be a lowercase dotted slug matching ${KEY} (got "${claim.key}")`);
	}
	if (claim.kind !== "rule" && claim.kind !== "fact") {
		problems.push(`kind must be rule | fact (got "${claim.kind}")`);
	}
	if (claim.state !== "approved" && claim.state !== "pending") {
		problems.push(`state must be approved | pending (got "${claim.state}")`);
	}
	if (claim.origin !== "agent" && claim.origin !== "migration") {
		problems.push(`origin must be agent | migration (got "${claim.origin}")`);
	}
	if (!isScopeString(claim.scope)) {
		problems.push(`scope must be global, project:<id> or path:<glob> (got "${claim.scope}")`);
	}
	// R5: asOf and source are never filled in by the extension.
	if (!claim.asOf) problems.push("asOf is required and is never filled in — say when this became true");
	else if (!isDay(claim.asOf)) problems.push(`asOf must be a real YYYY-MM-DD date (got "${claim.asOf}")`);
	if (!claim.source || claim.source.trim() === "") {
		problems.push("source is required and is never filled in — say where this came from");
	}
	const body = normalizeBody(claim.body);
	if (body === "") problems.push("body is required");
	else {
		const chars = charCount(body);
		if (chars > BODY_MAX_CHARS) problems.push(`body is ${chars} characters; the limit is ${BODY_MAX_CHARS}`);
		if (body.includes("##")) problems.push("body may not contain a markdown heading — one claim is one paragraph");
	}
	for (const list of [claim.aliases, claim.tags, claim.links]) {
		for (const value of list) {
			if (value.includes(";")) problems.push(`list values may not contain ";" (got "${value}")`);
		}
	}
	for (const field of ["proposedAt", "deferredAt", "supersededAt", "rejectedAt"] as const) {
		const value = claim[field];
		if (value !== undefined && !isDay(value)) problems.push(`${field} must be YYYY-MM-DD (got "${value}")`);
	}
	return problems;
}

export function isScopeString(value: string): boolean {
	if (value === "global") return true;
	if (value.startsWith("project:")) return value.slice("project:".length).trim() !== "";
	if (value.startsWith("path:")) return value.slice("path:".length).trim() !== "";
	return false;
}

/** Render one entry: heading, fields in fixed order, blank line, wrapped body. */
export function renderEntry(claim: Claim): string[] {
	const lines = [`## ${claim.key}`];
	for (const field of FIELD_ORDER) {
		if (LIST_FIELDS.has(field)) {
			const values = (claim[field as "aliases" | "tags" | "links"] ?? []).map((v) => v.trim()).filter((v) => v !== "");
			if (values.length > 0) lines.push(`${field}: ${values.join("; ")}`);
			continue;
		}
		const value = claim[field as keyof Claim];
		if (typeof value !== "string" || value.trim() === "") continue;
		// Default values are not written: a hand-written entry that omits them
		// parses to the same claim, and byte-stability requires the writer to
		// write exactly what the parser can see.
		if (field === "origin" && value === "agent") continue;
		if (field === "state" && value === "approved") continue;
		lines.push(`${field}: ${value.trim()}`);
	}
	lines.push("");
	lines.push(...wrapBody(claim.body));
	return lines;
}

/** Render a whole store file: preamble verbatim, then entries in order. */
export function renderStore(preamble: string, entries: Claim[]): string {
	const parts: string[] = [];
	const head = preamble.replace(/\s+$/, "");
	if (head !== "") parts.push(head);
	for (const entry of entries) parts.push(renderEntry(entry).join("\n"));
	return `${parts.join("\n\n")}\n`;
}

/**
 * Parse a store file. One broken entry never takes the rest of the file with it
 * (R7): an entry is reported with its file and heading line and dropped, and the
 * next heading still starts a fresh entry.
 *
 * Text the grammar cannot read at all — a heading with a key it rejects, and the
 * prose under it — is reported as `unreadable`. It is never folded into the entry
 * above, and `store.ts` refuses a write that would have to rewrite the file while
 * it is there, because the writer cannot put those bytes back.
 */
export function parseStore(text: string, file: string): ParsedStore {
	const lines = text.split("\n");
	// Every block boundary in order, with the kind of block it starts. A heading the
	// grammar cannot read still separates blocks, so its prose is never swallowed by
	// the claim above it — and never deleted by the writer either.
	const blocks: { at: number; kind: "entry" | "unreadable" | "preamble" }[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!BOUNDARY.test(lines[i]!)) continue;
		if (HEADING.test(lines[i]!)) blocks.push({ at: i, kind: "entry" });
		else if (H1.test(lines[i]!) && !blocks.some((block) => block.kind !== "preamble")) blocks.push({ at: i, kind: "preamble" });
		// A second level-one heading, or a heading with a key the grammar rejects:
		// text the file holds that no claim owns.
		else blocks.push({ at: i, kind: "unreadable" });
	}
	// Everything before the first claim block is the file's preamble, kept verbatim.
	const firstBlock = blocks.find((block) => block.kind !== "preamble");
	const preamble = firstBlock === undefined ? text : lines.slice(0, firstBlock.at).join("\n");
	const head = preamble.replace(/\s+$/, "");
	const entries: ParsedEntry[] = [];
	const errors: EntryError[] = [];
	const unreadable: UnreadableText[] = [];

	for (let b = 0; b < blocks.length; b++) {
		const block = blocks[b]!;
		const end = b + 1 < blocks.length ? blocks[b + 1]!.at : lines.length; // exclusive, 0-indexed
		if (block.kind === "preamble") continue; // the file's own title, kept by the preamble
		if (block.kind === "unreadable") {
			unreadable.push({ line: block.at + 1, text: lines[block.at]!.trim(), extra: H1.test(lines[block.at]!) ? "only the file's first heading is its preamble: this text belongs to no claim" : KEY_HINT });
			continue;
		}

		const start = block.at;
		const blockLines = lines.slice(start + 1, end);
		const key = HEADING.exec(lines[start]!)![1]!;

		let k = 0;
		const fields = new Map<string, string[]>();
		let malformed: string | undefined;
		for (; k < blockLines.length; k++) {
			const line = blockLines[k]!;
			if (line.trim() === "") break;
			const field = FIELD.exec(line);
			if (!field) {
				malformed = `"${line.trim().slice(0, 40)}" is not a field line — fields are "name: value", and the body starts after a blank line. If this line is prose, it belongs in the body, below the blank line.`;
				break;
			}
			if (!KNOWN_FIELDS.has(field[1]!)) {
				malformed = `unknown field "${field[1]}" (known: ${FIELD_ORDER.join(", ")})`;
				break;
			}
			const list = fields.get(field[1]!) ?? [];
			list.push(field[2] ?? "");
			fields.set(field[1]!, list);
		}

		if (malformed) {
			errors.push({ file, line: start + 1, message: malformed });
			continue;
		}
		if (k >= blockLines.length) {
			errors.push({ file, line: start + 1, message: "entry has no body: the fields must be followed by a blank line and prose" });
			continue;
		}

		const claim = buildClaim(key, fields, blockLines.slice(k + 1));
		if (typeof claim === "string") {
			errors.push({ file, line: start + 1, message: claim });
			continue;
		}
		const problems = validateClaim(claim);
		if (problems.length > 0) {
			errors.push({ file, line: start + 1, message: problems.join("; ") });
			continue;
		}
		// A body is one paragraph. Prose after a blank line inside the block reads as
		// part of the body — that is what the grammar can do — but it is usually a note
		// someone typed into the file. Name it, so the writer stops rather than folding
		// the note into the claim permanently.
		const bodyLines = blockLines.slice(k + 1);
		let blank = -1;
		for (let i = 0; i < bodyLines.length; i++) {
			if (bodyLines[i]!.trim() === "") blank = i;
			else if (blank !== -1) {
				unreadable.push({
					line: start + k + i + 3,
					text: bodyLines[i]!.trim(),
					extra: "a claim body is one paragraph: this prose sits below a blank line inside the claim above",
				});
				break;
			}
		}
		entries.push({ claim, file, startLine: start + 1, endLine: end });
	}

	return { file, preamble: head, entries, errors, unreadable };
}

function buildClaim(key: string, fields: Map<string, string[]>, bodyLines: string[]): Claim | string {
	for (const field of REQUIRED_FIELDS) {
		if (!fields.has(field)) return `missing required field "${field}"`;
	}
	const list = (name: string): string[] => {
		const raw = fields.get(name) ?? [];
		return raw
			.flatMap((value) => value.split(";"))
			.map((value) => value.trim())
			.filter((value) => value !== "");
	};
	const one = (name: string): string | undefined => {
		const raw = fields.get(name);
		if (!raw) return undefined;
		return raw.join(" ").trim();
	};
	if (!HEADING.test(`## ${key}`) || !KEY.test(key)) return `key "${key}" is not a lowercase dotted slug`;

	const claim: Claim = {
		key,
		kind: (one("kind") ?? "") as ClaimKind,
		scope: one("scope") ?? "",
		asOf: one("asOf") ?? "",
		source: one("source") ?? "",
		body: normalizeBody(bodyLines.join(" ")),
		aliases: list("aliases"),
		tags: list("tags"),
		links: list("links"),
		origin: (one("origin") ?? "agent") as ClaimOrigin,
		state: (one("state") ?? "approved") as ClaimState,
	};
	for (const field of ["proposedAt", "deferredAt", "supersededAt", "rejectedAt", "statusOverride"] as const) {
		const value = one(field);
		if (value !== undefined && value !== "") claim[field] = value;
	}
	return claim;
}

/** True when the rule is injected every turn (R35). */
export function isAlwaysRule(claim: Claim): boolean {
	return claim.kind === "rule" && claim.tags.some((tag) => tag.toLowerCase() === "always");
}
