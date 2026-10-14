/**
 * Migration: prose knowledge files → keyed entries (Phase 5b, dry run first).
 *
 * The old bank is prose. Its `##` headings are section titles, not assertions, so
 * migration is a judgement call — which means the job here is to *propose*, with
 * every inference labelled, and let a human decide. Nothing in this file writes
 * anything: `proposeMigration` reads, `renderMigrationReport` explains, and
 * `migrationEdits` hands the accepted subset to the same `applyEdits` that any
 * write goes through.
 *
 * Two honesty rules:
 *   1. Nothing is dropped silently. Skipped sections and skipped files are
 *      reported with the reason, so "why isn't my note in the store?" has an
 *      answer.
 *   2. Inferred provenance says it is inferred. A date read from a file's mtime is
 *      not a claim about when the claim became true; it is the best evidence
 *      available, and the report says so — because an `asOf` that looks
 *      authoritative decides authority.
 */

import { isAssertionKey, parseTopicFile, renderTopicFile, type EntryKind, type EntryScope, type ParseIssue, type TopicFile } from "./schema.js";
import { decide, type FileEdit, type WriteRequest } from "./gate.js";
import { buildStore, type MemoryStore } from "./resolver.js";

export interface SourceFile {
	/** Memory-bank-relative path, e.g. "knowledge/git-standards.md". */
	path: string;
	text: string;
	/** Best available date the file changed (file mtime, or a git date). */
	modified?: string;
	/** Where that date came from, so the inference is visible. */
	modifiedFrom?: "mtime" | "git" | "unknown";
}

export type ProposalFlag =
	| "inferred-date"
	| "mechanical-split"
	| "guessed-kind"
	| "guessed-scope"
	| "needs-split"
	| "key-collision"
	| "similar-claim"
	| "same-heading-elsewhere"
	| "long-body";

export interface MigrationProposal {
	sourceFile: string;
	sourceHeading: string;
	/** The entry store this claim would live in. */
	targetFile: string;
	key: string;
	scope: string;
	kind: EntryKind;
	asOf: string;
	asOfFrom: "mtime" | "git" | "unknown";
	source: string;
	body: string;
	flags: ProposalFlag[];
	/** The text that made the heuristic say what it says. */
	cues: string[];
	/** Set when this entry is one claim carved out of a bullet-heavy section. */
	splitFrom?: { heading: string; index: number; total: number };
}

export interface SkippedSection {
	sourceFile: string;
	heading: string;
	reason: string;
}

export interface SkippedFile {
	sourceFile: string;
	reason: string;
}

export interface MigrationOptions {
	/**
	 * Split a bullet-heavy section into one entry per claim. On by default: an
	 * over-granular entry is visible and mergeable later, while a section that
	 * hides four claims behind one authority makes the conflict gate blind — the
	 * asymmetry decides the default.
	 */
	split?: boolean;
	/** Files a human decided are not knowledge at all. Reported, never performed. */
	moves?: Array<{ from: string; to: string; reason: string }>;
}

export interface MigrationReport {
	proposals: MigrationProposal[];
	/** Decided by a human, reported by the tool: a move is a bank write this code will not make. */
	moves: Array<{ from: string; to: string; reason: string }>;
	skippedSections: SkippedSection[];
	skippedFiles: SkippedFile[];
	/** Sections whose source attribution was folded into `source:` instead of becoming an entry. */
	attribution: Array<{ sourceFile: string; text: string }>;
	keyCollisions: Array<{ key: string; sources: string[] }>;
	/** Claims already in entry form: the migration leaves them exactly as they are. */
	alreadyEntries: Array<{ sourceFile: string; heading: string }>;
	/**
	 * Two claims in one section that read like the same assertion. The gate cannot
	 * catch these: they have different keys, so they are not rivals by identity, and
	 * a bank quietly ends up with two versions of one rule that diverge over time.
	 */
	similarClaims: Array<{ family: string; keys: string[] }>;
	sameHeading: Array<{ heading: string; sources: string[] }>;
	/** Structural prose before the first heading, which has no key to live under. */
	preambles: Array<{ sourceFile: string; lines: number }>;
}

const KIND_CUES: Array<{ kind: EntryKind; cue: RegExp; label: string }> = [
	{ kind: "gotcha", cue: /\b(gotcha|gotchas|watch out|beware|pitfall|silently|silent failure)\b/i, label: "warning language" },
	{ kind: "rule", cue: /\b(never|must|always|required|do not|don't|refuses?|no implicit|enforce)\b/i, label: "modal obligation" },
	{ kind: "procedure", cue: /(\bnpm (test|run)\b|\bstep \d|before any commit|checklist|\brun\b[^.]{0,40}\b(before|after|first)\b|run .* and .*)/i, label: "steps or commands" },
	{ kind: "decision", cue: /\b(decided|decision|chose|we went with|rejected|instead of)\b/i, label: "decision language" },
	{ kind: "preference", cue: /\b(prefer|prefers|convention|use .* for|keep .* under|aim for)\b/i, label: "taste or convention" },
];

/**
 * Headings that organize a document rather than assert something. Matched against
 * the whole heading, not a prefix: `## Notes` is scaffolding, `## Notes on loading`
 * and `## Background colour` are claims about something, and a prefix match would
 * silently drop them.
 */
const STRUCTURAL_HEADINGS = /^(purpose|overview|background|notes?|applies to|scope|context|structure|layout|what is this):?$/i;
const ATTRIBUTION_HEADINGS = /^(sources?|attribution|provenance|credit):?$/i;
/** A file that is really a status snapshot does not belong in an entry store. */
/** The first field line of a well-formed entry. */
const ENTRY_SHAPED = /^\s{0,3}[-*]\s*(kind|scope|asOf|status|source):/m;

const VOLATILE_FILE = /(## phase \d|\(complete\)|\(in progress\)|^# implementation plan|## branch:)/i;

const TOPIC = /^knowledge\/([a-z0-9._-]+)\.md$/i;

function slug(value: string, max = 48): string {
	const base = value
		.toLowerCase()
		// Apostrophes are punctuation inside a word, not a word boundary:
		// "Don't push" must slug to dont-push, not don-t-push.
		.replace(/['’ʼ]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (base.length <= max) return base;
	return base.slice(0, max).replace(/-+$/, "");
}

function topicOf(sourceFile: string): string {
	const match = TOPIC.exec(sourceFile);
	return match ? slug(match[1]!) : slug(sourceFile.replace(/[^a-z0-9]+/g, "-"));
}

/** Parse `## heading` sections; fenced blocks are body text, not structure. */
interface Section {
	heading: string;
	level: number;
	body: string;
	lines: string[];
}

function sections(text: string): { preamble: string[]; sections: Section[] } {
	const lines = text.split(/\r?\n/);
	const preamble: string[] = [];
	const found: Section[] = [];
	let current: Section | null = null;
	let fence: string | null = null;

	for (const line of lines) {
		const fenceMatch = /^\s{0,3}(```|~~~)/.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1]!;
			if (fence === null) fence = marker;
			else if (fence === marker) fence = null;
			if (current) current.lines.push(line);
			else preamble.push(line);
			continue;
		}
		const heading = fence === null ? /^\s{0,3}(#{1,6})\s+(.*\S)\s*$/.exec(line) : null;
		if (heading) {
			const level = heading[1]!.length;
			const title = heading[2]!.trim();
			if (level === 1) continue;
			current = { heading: title, level, body: "", lines: [] };
			found.push(current);
			continue;
		}
		if (current) current.lines.push(line);
		else preamble.push(line);
	}

	for (const section of found) section.body = section.lines.join("\n").trim();
	return { preamble, sections: found };
}

/**
 * De-indent continuation lines (1-3 spaces, outside fences) so a claim copied out
 * of a list does not carry the list's indentation. Four or more spaces is an
 * indented code block and stays as written.
 */
function normalizeBody(text: string): string {
	const out: string[] = [];
	let fence: string | null = null;
	for (const line of text.split(/\r?\n/)) {
		const fenceMatch = FENCE.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1]!;
			if (fence === null) fence = marker;
			else if (fence === marker) fence = null;
			out.push(line);
			continue;
		}
		out.push(fence === null && !BULLET.test(line) ? line.replace(/^\s{1,3}(?=\S)/, "") : line);
	}
	return out.join("\n").trim();
}

interface Block {
	kind: "bullet" | "prose";
	text: string;
}

const FENCE = /^\s{0,3}(```|~~~)/;
const BULLET = /^\s{0,3}([-*]|\d+\.)\s+/;

/**
 * Split a section body into top-level blocks: bullets with their continuation
 * lines, and prose. Fenced code stays attached to the block it documents, because
 * an example on its own line is not an assertion.
 */
function blocksOf(body: string): Block[] {
	const blocks: Block[] = [];
	let current: Block | null = null;
	let fence: string | null = null;


	for (const line of body.split(/\r?\n/)) {
		const fenceMatch = FENCE.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1]!;
			if (fence === null) fence = marker;
			else if (fence === marker) fence = null;
			if (current) current.text += `\n${line}`;
			else {
				current = { kind: "prose", text: line };
				blocks.push(current);
			}
			continue;
		}
		const bullet = fence === null ? BULLET.exec(line) : null;
		if (bullet) {
			current = { kind: "bullet", text: line.replace(BULLET, "") };
			blocks.push(current);
			continue;
		}
		if (current && (fence !== null || line.trim() === "" || /^\s+\S/.test(line) || current.kind === "bullet")) {
			current.text += `\n${fence === null ? line.replace(/^\s{1,3}(?=\S)/, "") : line}`;
			continue;
		}
		current = { kind: "prose", text: line };
		blocks.push(current);
	}

	return blocks
		.map((block) => ({ kind: block.kind, text: block.text.replace(/\s+$/g, "").trim() }))
		.filter((block) => block.text !== "");
}

/** A bullet that qualifies the claim before it rather than making a new one. */
const QUALIFIER = /^(for example|example|e\.g\.|i\.e\.|note:|caveat:|warning:|also\b)\b/i;

function isQualifier(text: string): boolean {
	if (QUALIFIER.test(text)) return true;
	// A short bullet built around a code token is a definition of the term above
	// it, not a separate claim ("`MM` and `DD` are the current local month/day").
	const backticks = (text.match(/`/g) ?? []).length;
	return text.length < 80 && backticks >= 2;
}

const STOPWORDS = new Set(["the", "a", "an", "of", "and", "to", "in", "is", "are", "so", "that", "this", "it", "its", "as", "or", "for", "with", "by", "on", "at", "be", "if", "then", "any", "all", "not", "no", "there", "here", "which", "when", "while", "from", "into", "we", "you", "your", "our", "their", "can", "must", "has", "have", "had", "was", "were", "run", "runs", "use", "uses", "via", "per", "put", "puts"]);

/**
 * Name a claim. A key is an identity — it is what `memory_show` takes and what
 * provenance points at — so a generated name has to be a *name*, not the first
 * forty characters of a sentence. Technical claims are usually about a thing, and
 * the thing is usually a code token: prefer that. Fall back to the significant
 * words with the connective tissue dropped, and fall back to the position in the
 * section when even that would be a guess, because "claim-3" is visibly a
 * placeholder while "a-missing-named-export-nope-from" is a fake.
 */
const GENERIC_TOKENS = new Set(["index", "tests", "test", "src", "api", "code", "file", "files", "name", "ts", "tsx", "js", "mjs", "md", "json", "npm", "run", "use", "dir", "path", "key", "value", "true", "false"]);

function claimLead(text: string): string {
	const codeToken = /`([A-Za-z][\w./-]{2,24})`/.exec(text);
	if (codeToken) {
		const token = slug(codeToken[1]!.replace(/\.(ts|js|mjs|cjs|tsx|jsx|md|json|mjs)$/i, ""), 28);
		if (token.length >= 4 && !STOPWORDS.has(token) && !GENERIC_TOKENS.has(token) && /[a-z]/i.test(token)) return token;
	}

	const plain = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, " $1 ")
		.replace(/[*_|\[\]()]/g, " ")
		// Dots and slashes inside a token are boundaries: a key made by deleting
		// them ("test-harnesstestts") is unreadable and unsearchable.
		.replace(/[./\\]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const words = plain
		.split(" ")
		.map((word) => word.replace(/[^A-Za-z0-9-]/g, ""))
		.filter((word) => word !== "" && !STOPWORDS.has(word.toLowerCase()) && /[a-z]/i.test(word))
		.slice(0, 4);
	return slug(words.join("-"), 32);
}

function kindOf(body: string): { kind: EntryKind; cue?: string; label?: string } {
	for (const { kind, cue, label } of KIND_CUES) {
		const match = cue.exec(body);
		if (match) return { kind, cue: match[0], label };
	}
	return { kind: "fact" };
}

function scopeOf(body: string): { scope: string; cue?: string; unnamed?: boolean } {
	const repo = /\b([a-z0-9]+(?:-[a-z0-9]+)+)\s+(?:repo|repository)\b/i.exec(body) ?? /\b(?:this|the)\s+(?:repo|repository)\b/i.exec(body);
	if (!repo) return { scope: "global" };
	const named = /\b([a-z0-9]+(?:-[a-z0-9]+){1,})\b/i.exec(repo[0]!);
	// A scope that cannot be named is not a guess, it is a hole: "this repo" is
	// true of whatever directory the note was written in, and inventing
	// project:this-repo would produce a scope that never matches a real cwd.
	if (!named) return { scope: "global", cue: repo[0], unnamed: true };
	return { scope: `project:${slug(named[1]!)}`, cue: repo[0] };
}

/**
 * Propose entries for every source file. Deterministic given the same inputs, so
 * a dry run can be reviewed and re-run and produce the same line-by-line plan.
 */
export function proposeMigration(sources: readonly SourceFile[], options: MigrationOptions = {}): MigrationReport {
	const proposals: MigrationProposal[] = [];
	const skippedSections: SkippedSection[] = [];
	const skippedFiles: SkippedFile[] = [];
	const attribution: MigrationReport["attribution"] = [];
	const preambles: MigrationReport["preambles"] = [];
	// A move is a bank write, so it is decided by a human and reported here —
	// never performed by the code that is only allowed to propose.
	const moves = [...(options.moves ?? [])];
	const alreadyEntries: MigrationReport["alreadyEntries"] = [];

	for (const file of sources) {
		if (!file.path.endsWith(".md")) {
			skippedFiles.push({ sourceFile: file.path, reason: "not a markdown file — the entry store keeps markdown; other formats are left where they are" });
			continue;
		}
		if (!TOPIC.test(file.path)) {
			skippedFiles.push({ sourceFile: file.path, reason: "not under knowledge/ — core/ and history/ stay prose: they are working state and history, not durable claims" });
			continue;
		}
		if (VOLATILE_FILE.test(file.text)) {
			skippedFiles.push({ sourceFile: file.path, reason: "reads as a status snapshot (phases, COMPLETE/IN PROGRESS, branch names) — that belongs in core/activeProjects.md, where staleness is expected; entries claim things that stay true" });
			continue;
		}

		const parsed = sections(file.text);
		if (parsed.preamble.join("\n").trim() !== "") preambles.push({ sourceFile: file.path, lines: parsed.preamble.filter((line) => line.trim() !== "").length });

		// A `## Source` section is provenance, not an assertion: fold it into the
		// entries' source: field instead of creating a claim about it.
		const attributionSection = parsed.sections.find((section) => ATTRIBUTION_HEADINGS.test(section.heading));
		if (attributionSection) {
			attribution.push({ sourceFile: file.path, text: attributionSection.body.replace(/\s+/g, " ").trim() });
			skippedSections.push({ sourceFile: file.path, heading: attributionSection.heading, reason: "provenance — folded into the entries' source: field rather than becoming a claim about attribution" });
		}
		const attributionNote = attributionSection ? attributionSection.body.replace(/\s+/g, " ").trim() : "";

		const topic = topicOf(file.path);
		const targetFile = `knowledge/${topic}.md`;
		const asOf = file.modified ?? "unknown";

		for (const section of parsed.sections) {
			if (ATTRIBUTION_HEADINGS.test(section.heading)) continue;

			// A heading that is already an assertion key is a migrated claim, not
			// prose to convert. Left alone: re-reading its `- kind:` and `- asOf:`
			// lines as bullet text would invent claims out of the entry's own
			// metadata — which is exactly what a second dry run on a half-migrated
			// bank does if this check is missing.
			if (isAssertionKey(section.heading.trim())) {
				if (ENTRY_SHAPED.test(section.body)) {
					alreadyEntries.push({ sourceFile: file.path, heading: section.heading.trim() });
					skippedSections.push({ sourceFile: file.path, heading: section.heading, reason: "already an entry — left exactly as it is" });
				} else {
					skippedSections.push({ sourceFile: file.path, heading: section.heading, reason: "heading is an assertion key but the body is not entry-shaped: this file holds a broken entry, fix it before migrating anything else into it" });
				}
				continue;
			}
			if (section.body === "") {
				skippedSections.push({ sourceFile: file.path, heading: section.heading, reason: "no body text — nothing was asserted under it" });
				continue;
			}
			if (STRUCTURAL_HEADINGS.test(section.heading)) {
				skippedSections.push({ sourceFile: file.path, heading: section.heading, reason: "structural heading (organises the document, does not assert anything); review it — move anything that reads like a claim under its own heading" });
				continue;
			}

			const bullets = blocksOf(section.body).filter((block) => block.kind === "bullet");
			const paragraphs = section.body.split(/\r?\n\s*\r?\n/).filter((part) => part.trim() !== "");
			const splitWanted = options.split !== false && (bullets.length >= 3 || (bullets.length >= 2 && section.body.length > 400));

			const flags: ProposalFlag[] = [];
			const cues: string[] = [];
			if (file.modifiedFrom === "mtime" || file.modifiedFrom === undefined) {
				flags.push("inferred-date");
				cues.push(`asOf ${asOf} is the file's modification time, not a claim date`);
			}

			const emit = (body: string, keySuffix: string, splitIndex?: { index: number; total: number }) => {
				// Each claim gets its own flags: sharing one accumulator across a
				// family makes the same flag appear once per sibling.
				const claimFlags = [...flags];
				const claimCues = [...cues];
				const kind = kindOf(body);
				const scope = scopeOf(body);
				if (kind.cue) claimCues.push(`kind=${kind.kind} from ${kind.label ?? "cue"}: "${kind.cue}"`);
				else claimFlags.push("guessed-kind");
				if (scope.unnamed) {
					claimFlags.push("guessed-scope");
					claimCues.push(`the text says "${scope.cue}" but the repo is not named — set project:<name> by hand`);
				} else if (scope.scope !== "global") {
					// Still an inference: a named repo in prose is evidence, not proof.
					claimFlags.push("guessed-scope");
					claimCues.push(`scope from: "${scope.cue}"`);
				}
				if (body.length > 700) claimFlags.push("long-body");
				if (splitIndex === undefined && (bullets.length >= 3 || paragraphs.length >= 3)) claimFlags.push("needs-split");

				const sourceParts = [`migrated from ${file.path} § ${section.heading}`];
				if (splitIndex) sourceParts.push(`claim ${splitIndex.index} of ${splitIndex.total}`);
				if (file.modified) sourceParts.push(`${file.modifiedFrom ?? "mtime"} ${file.modified}`);
				if (attributionNote) sourceParts.push(attributionNote);

				proposals.push({
					sourceFile: file.path,
					sourceHeading: section.heading,
					targetFile,
					key: `${topic}.${slug(section.heading)}${keySuffix}`,
					scope: scope.scope,
					kind: kind.kind,
					asOf,
					asOfFrom: file.modifiedFrom ?? "unknown",
					source: sourceParts.join(" — "),
					body,
					flags: claimFlags,
					cues: claimCues,
					splitFrom: splitIndex ? { heading: section.heading, index: splitIndex.index, total: splitIndex.total } : undefined,
				});
			};

			if (!splitWanted) {
				emit(normalizeBody(section.body), "");
				continue;
			}

			// One entry per claim. Prose before the first bullet leads the family;
			// anything after a bullet belongs to the bullet it follows.
			const blocks = blocksOf(section.body);
			const merged: Array<{ text: string; isBullet: boolean }> = [];
			for (const block of blocks) {
				if (block.kind === "bullet" && merged.length > 0 && isQualifier(block.text)) {
					merged[merged.length - 1]!.text += `\n\n${block.text}`;
					continue;
				}
				merged.push({ text: block.text, isBullet: block.kind === "bullet" });
			}
			if (merged.length < 2) {
				emit(normalizeBody(section.body), "");
				continue;
			}

			// Document order, whatever the block kinds: the first block takes the
			// section's own key and the rest are named after the claim they hold, so
			// someone re-reading the store sees the order the notes were written in.
			flags.push("mechanical-split");
			cues.push(`split § ${section.heading} into ${merged.length} claims: ${merged.map((part) => `\`${part.text.split(/\r?\n/)[0]!.slice(0, 48)}\``).join(", ")}`);

			const used = new Set<string>();
			merged.forEach((part, index) => {
				if (index === 0) {
					emit(part.text, "", { index: index + 1, total: merged.length });
					return;
				}
				const lead = claimLead(part.text);
				const suffix = lead === "" || used.has(lead) ? `.claim-${index + 1}` : `.${lead}`;
				used.add(lead);
				emit(part.text, suffix, { index: index + 1, total: merged.length });
			});
			continue;
		}
	}

	const byKey = new Map<string, string[]>();
	const byHeading = new Map<string, Set<string>>();
	for (const proposal of proposals) {
		byKey.set(proposal.key, [...(byKey.get(proposal.key) ?? []), proposal.sourceFile]);
		const heading = proposal.sourceHeading.toLowerCase();
		byHeading.set(heading, new Set([...(byHeading.get(heading) ?? []), proposal.sourceFile]));
	}

	const keyCollisions = [...byKey.entries()].filter(([, sources]) => sources.length > 1).map(([key, sources]) => ({ key, sources }));
	for (const collision of keyCollisions) for (const proposal of proposals) if (collision.key === proposal.key && !proposal.flags.includes("key-collision")) proposal.flags.push("key-collision");

	// Claims that read alike inside one section: same leading words, different keys.
	const families = new Map<string, MigrationProposal[]>();
	for (const proposal of proposals) {
		const id = `${proposal.sourceFile}#${proposal.sourceHeading}`;
		families.set(id, [...(families.get(id) ?? []), proposal]);
	}
	const similarClaims: MigrationReport["similarClaims"] = [];
	for (const [family, members] of families) {
		if (members.length < 2) continue;
		const byLead = new Map<string, MigrationProposal[]>();
		for (const member of members) {
			const lead = claimLead(member.body);
			if (lead === "") continue;
			byLead.set(lead, [...(byLead.get(lead) ?? []), member]);
		}
		for (const twins of byLead.values()) {
			if (twins.length < 2) continue;
			similarClaims.push({ family, keys: twins.map((twin) => twin.key) });
			for (const twin of twins) {
				if (!twin.flags.includes("similar-claim")) twin.flags.push("similar-claim");
				twin.cues.push(`reads like the sibling claim ${twins.filter((other) => other !== twin).map((other) => other.key).join(", ")} — one assertion written twice, or two claims that need distinguishing`);
			}
		}
	}

	// The same heading text in *different files*: sibling claims carved out of one
	// section share a heading by construction and are not evidence of a repeat.
	const sameHeading = [...byHeading.entries()]
		.filter(([, files]) => files.size > 1)
		.map(([heading, files]) => ({ heading, sources: [...files] }));
	for (const shared of sameHeading) for (const proposal of proposals) if (proposal.sourceHeading.toLowerCase() === shared.heading && !proposal.flags.includes("same-heading-elsewhere")) proposal.flags.push("same-heading-elsewhere");

	return { proposals, skippedSections, skippedFiles, attribution, keyCollisions, similarClaims, sameHeading, preambles, moves, alreadyEntries };
}

/**
 * The proposals expressed as gate requests, so the migration is admitted by the
 * same rule that admits ordinary writes. A proposal the gate refuses is a problem
 * with the migration, not a problem to be routed around.
 */
export function migrationRequests(report: MigrationReport, accept: (proposal: MigrationProposal) => boolean = () => true): WriteRequest[] {
	return report.proposals.filter(accept).map((proposal) => ({
		file: proposal.targetFile,
		key: proposal.key,
		scope: proposal.scope,
		kind: proposal.kind,
		body: proposal.body,
		asOf: proposal.asOf === "unknown" ? undefined : proposal.asOf,
		source: proposal.source,
		status: "active",
		fields: { migratedFrom: `${proposal.sourceFile}#${proposal.sourceHeading}` },
	}));
}

/** A scope compared as text, in the form a write request spells it with. An
// `EntryScope` is a parsed object: stringifying it gives "[object Object]" and a
// guard built on top of it silently never fires. */
function scopeIdentity(scope: string | EntryScope): string {
	if (typeof scope === "string") return scope.trim().toLowerCase();
	return (scope.value ? `${scope.level}:${scope.value}` : scope.level).trim().toLowerCase();
}

/**
 * Prepare a store for in-place migration. The prose these proposals came from is
 * also sitting in the store as unkeyed headings, and `renderTopicFile` would
 * re-serialize it into entry shape — turning `## Applies to` into a claim with a
 * `kind:` field. For the files being migrated, the prose is the *input*, so it is
 * consumed: unkeyed headings are dropped (they became entries, or were skipped
 * with a reason) and the file keeps its title.
 *
 * Headed entries with real assertion keys are kept. Someone may have written a
 * claim by hand in the same file, and a migration that quietly deleted it would be
 * the worst kind of bug this component could have. If a proposal duplicates such a
 * claim, the gate refuses it — that is the point of running the migration through
 * the gate.
 */
export interface PreparedStore {
	store: MemoryStore;
	/** Unkeyed prose headings removed from files being rewritten. */
	consumed: Array<{ path: string; heading: string }>;
	/** Keyed entries preserved in those files. */
	preserved: string[];
}

export function prepareMigrationStore(start: MemoryStore, sourcePaths: readonly string[]): PreparedStore {
	const targets = new Set(sourcePaths);
	const consumed: PreparedStore["consumed"] = [];
	const preserved: string[] = [];
	const files: TopicFile[] = [];

	for (const file of start.byPath.values()) {
		if (!targets.has(file.path)) {
			files.push(file);
			continue;
		}
		const kept = file.entries.filter((entry) => isAssertionKey(entry.key));
		for (const entry of file.entries) {
			if (isAssertionKey(entry.key)) preserved.push(`${file.path}#${entry.heading}`);
			else consumed.push({ path: file.path, heading: entry.heading });
		}
		files.push({ ...file, entries: kept });
	}

	return { store: buildStore(files), consumed, preserved };
}

/**
 * Fold the proposals through the gate against a store that grows as each write is
 * accepted. This is the same `decide` a live write goes through, which means the
 * dry run answers the only question that matters: *would these writes be
 * admitted?* Anything refused here is a defect in the migration, not something to
 * route around — and the rendered bytes come from the store's own renderer rather
 * than a second one invented for migration day.
 */
export interface MigrationSimulation {
	accepted: string[];
	unchanged: string[];
	refused: Array<{ key: string; kind: "conflict"; conflictId: string; explanation: string }>;
	/**
	 * Two proposals claiming one identity within the same batch. The gate allows a
	 * write to *amend* an entry it already owns — rewording your own claim is
	 * authoring, not a rival claim — and that allowance is wrong here: two prose
	 * sections that slugify to one key have no continuous authorship between them,
	 * so the second would silently rewrite the first. They are stopped before the
	 * gate sees them and a human names one of them.
	 */
	collided: Array<{ key: string; file: string; first: string; second: string }>
	rejected: Array<{ key: string; reason: string; explanation: string; issues: ParseIssue[] }>;
	/** The files that would change, rendered exactly as they would be written. */
	edits: FileEdit[];
	violationsAfter: string[];
}

export function simulateMigration(start: MemoryStore, requests: readonly WriteRequest[]): MigrationSimulation {
	const files = new Map<string, TopicFile>(start.byPath);
	const before = new Map<string, string>();
	for (const [path, file] of files) before.set(path, JSON.stringify(file.entries.map((entry) => entry.heading)));

	const simulation: MigrationSimulation = { accepted: [], unchanged: [], refused: [], rejected: [], collided: [], edits: [], violationsAfter: [] };
	const claimed = new Map<string, string>();
	// Claims already in the store, by identity. The gate allows a write to amend an
	// entry it owns; a migration does not own a claim someone wrote by hand, so
	// landing on one is stopped for a human to decide rather than applied.
	const existing = new Map<string, string>();
	for (const file of start.byPath.values()) for (const entry of file.entries) existing.set(`${file.path}\u0000${entry.key}\u0000${scopeIdentity(entry.scope)}`, `${file.path}#${entry.heading}`);

	for (const request of requests) {
		const identity = `${request.file}\u0000${request.key}\u0000${scopeIdentity(request.scope)}`;
		const previous = claimed.get(identity) ?? existing.get(identity);
		if (previous !== undefined) {
			simulation.collided.push({ key: request.key, file: request.file, first: previous, second: request.fields?.migratedFrom ?? "(unspecified source)" });
			continue;
		}
		claimed.set(identity, request.fields?.migratedFrom ?? "(unspecified source)");
		const result = decide(buildStore([...files.values()]), request);
		switch (result.kind) {
			case "plan": {
				for (const edit of result.plan.files) {
					files.set(edit.path, parseTopicFile(edit.content, edit.path));
				}
				simulation.accepted.push(request.key);
				break;
			}
			case "unchanged":
				simulation.unchanged.push(request.key);
				break;
			case "conflict":
				simulation.refused.push({ key: request.key, kind: "conflict", conflictId: result.conflictId, explanation: result.explanation });
				break;
			case "reject":
				simulation.rejected.push({ key: request.key, reason: result.reason, explanation: result.explanation, issues: result.issues });
				break;
			case "discarded":
				break;
		}
	}

	const after = buildStore([...files.values()]);
	simulation.edits = [...files.values()]
		.filter((file) => before.get(file.path) !== JSON.stringify(file.entries.map((entry) => entry.heading)))
		.sort((a, b) => a.path.localeCompare(b.path))
		.map((file) => ({ path: file.path, content: renderTopicFile(file), changes: file.entries.map((entry) => ({ change: "created-file" as const, heading: entry.heading })) }));
	simulation.violationsAfter = after.violations.map((violation) => `${violation.code} ${violation.path}#${violation.key ?? ""}: ${violation.message}`);
	return simulation;
}

export function renderMigrationReport(report: MigrationReport): string {
	const lines = [
		"Migration plan (dry run — nothing was written)",
		`Proposals: ${report.proposals.length}; skipped files: ${report.skippedFiles.length}; skipped sections: ${report.skippedSections.length}`,
		"",
		"Review flags:",
		`- needs-split: a section that reads like several claims (${report.proposals.filter((p) => p.flags.includes("needs-split")).length})`,
		`- guessed-kind: no cue matched, kind defaults to fact (${report.proposals.filter((p) => p.flags.includes("guessed-kind")).length})`,
		`- inferred-date: asOf came from a file mtime, not a claim date (${report.proposals.filter((p) => p.flags.includes("inferred-date")).length})`,
		`- key-collision: two sections would take the same key (${report.keyCollisions.length})`,
		`- similar-claim: same leading words, different keys — the gate cannot see these as rivals (${report.similarClaims.length})`,
		`- same-heading-elsewhere: the same heading text in more than one file — check whether it is one assertion (${report.sameHeading.length})`,
	];

	if (report.skippedFiles.length > 0) {
		lines.push("", "Files not migrated:");
		for (const skip of report.skippedFiles) lines.push(`- ${skip.sourceFile}: ${skip.reason}`);
	}
	if (report.skippedSections.length > 0) {
		lines.push("", "Sections not turned into entries:");
		for (const skip of report.skippedSections) lines.push(`- ${skip.sourceFile} § ${skip.heading}: ${skip.reason}`);
	}
	if (report.attribution.length > 0) {
		lines.push("", "Provenance folded into source: instead of becoming entries:");
		for (const entry of report.attribution) lines.push(`- ${entry.sourceFile}: ${entry.text}`);
	}
	if (report.alreadyEntries.length > 0) {
		lines.push("", "Already entries, left untouched:");
		for (const entry of report.alreadyEntries) lines.push(`- ${entry.sourceFile} § ${entry.heading}`);
	}

	if (report.similarClaims.length > 0) {
		lines.push("", "Claims that read like the same assertion (different keys, so authority is split between them):");
		for (const group of report.similarClaims) lines.push(`- ${group.family}: ${group.keys.join(" | ")}`);
	}

	if (report.moves.length > 0) {
		lines.push("", "Decided moves (reported, never performed here — a move is a bank write):");
		for (const move of report.moves) lines.push(`- ${move.from} -> ${move.to}: ${move.reason}`);
	}

	const families = new Map<string, MigrationProposal[]>();
	for (const proposal of report.proposals) {
		if (!proposal.splitFrom) continue;
		const id = `${proposal.sourceFile}#${proposal.sourceHeading}`;
		families.set(id, [...(families.get(id) ?? []), proposal]);
	}
	if (families.size > 0) {
		lines.push("", "Sections split into one entry per claim (review each family together):");
		for (const [id, members] of families) lines.push(`- ${id} -> ${members.length} claims: ${members.map((member) => member.key).join(", ")}`);
	}

	if (report.preambles.length > 0) {
		lines.push("", "Preamble prose (before the first heading — it has no key to live under):");
		for (const preamble of report.preambles) lines.push(`- ${preamble.sourceFile}: ${preamble.lines} lines`);
	}

	lines.push("", "Proposed entries:");
	for (const proposal of report.proposals) {
		lines.push("", `${proposal.key}  →  ${proposal.targetFile}`);
		lines.push(`  from: ${proposal.sourceFile} § ${proposal.sourceHeading}`);
		lines.push(`  ${proposal.kind} · ${proposal.scope} · asOf ${proposal.asOf}${proposal.asOfFrom === "mtime" ? " (file mtime — inferred)" : ""}`);
		if (proposal.flags.length > 0) lines.push(`  flags: ${proposal.flags.join(", ")}`);
		if (proposal.cues.length > 0) lines.push(`  why: ${proposal.cues.join("; ")}`);
		const preview = proposal.body.replace(/\s+/g, " ");
		lines.push(`  body: ${preview.length > 220 ? `${preview.slice(0, 217)}...` : preview}`);
	}
	return `${lines.join("\n")}\n`;
}
