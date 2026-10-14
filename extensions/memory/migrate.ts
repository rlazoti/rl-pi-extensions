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

import { parseTopicFile, renderTopicFile, type EntryKind, type ParseIssue, type TopicFile } from "./schema.js";
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
	| "guessed-kind"
	| "guessed-scope"
	| "needs-split"
	| "key-collision"
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

export interface MigrationReport {
	proposals: MigrationProposal[];
	skippedSections: SkippedSection[];
	skippedFiles: SkippedFile[];
	/** Sections whose source attribution was folded into `source:` instead of becoming an entry. */
	attribution: Array<{ sourceFile: string; text: string }>;
	keyCollisions: Array<{ key: string; sources: string[] }>;
	sameHeading: Array<{ heading: string; sources: string[] }>;
	/** Structural prose before the first heading, which has no key to live under. */
	preambles: Array<{ sourceFile: string; lines: number }>;
}

const KIND_CUES: Array<{ kind: EntryKind; cue: RegExp; label: string }> = [
	{ kind: "gotcha", cue: /\b(gotcha|gotchas|watch out|beware|pitfall|silently|silent failure)\b/i, label: "warning language" },
	{ kind: "rule", cue: /\b(never|must|always|required|do not|don't|refuses?|no implicit|enforce)\b/i, label: "modal obligation" },
	{ kind: "procedure", cue: /(\bnpm (test|run)\b|\bstep \d|before any commit|checklist|run .* and .*)/i, label: "steps or commands" },
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
export function proposeMigration(sources: readonly SourceFile[]): MigrationReport {
	const proposals: MigrationProposal[] = [];
	const skippedSections: SkippedSection[] = [];
	const skippedFiles: SkippedFile[] = [];
	const attribution: MigrationReport["attribution"] = [];
	const preambles: MigrationReport["preambles"] = [];

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
		if (attributionSection) attribution.push({ sourceFile: file.path, text: attributionSection.body.replace(/\s+/g, " ").trim() });
		const attributionNote = attributionSection ? attributionSection.body.replace(/\s+/g, " ").trim() : "";

		const topic = topicOf(file.path);
		const asOf = file.modified ?? "unknown";

		for (const section of parsed.sections) {
			if (ATTRIBUTION_HEADINGS.test(section.heading)) continue;
			if (section.body === "") {
				skippedSections.push({ sourceFile: file.path, heading: section.heading, reason: "no body text — nothing was asserted under it" });
				continue;
			}
			if (STRUCTURAL_HEADINGS.test(section.heading)) {
				skippedSections.push({ sourceFile: file.path, heading: section.heading, reason: "structural heading (organises the document, does not assert anything); review it — move anything that reads like a claim under its own heading" });
				continue;
			}

			const kind = kindOf(section.body);
			const scope = scopeOf(section.body);
			const bullets = section.body.split(/\r?\n/).filter((line) => /^\s*([-*]|\d+\.)\s+/.test(line));
			const paragraphs = section.body.split(/\r?\n\s*\r?\n/).filter((part) => part.trim() !== "");
			const flags: ProposalFlag[] = [];
			const cues: string[] = [];

			if (kind.cue) cues.push(`kind=${kind.kind} from ${kind.label ?? "cue"}: "${kind.cue}"`);
			else flags.push("guessed-kind");
			if (scope.unnamed) {
				flags.push("guessed-scope");
				cues.push(`the text says "${scope.cue}" but the repo is not named — set project:<name> by hand`);
			} else if (scope.scope !== "global") {
				// Still an inference: a named repo in prose is evidence, not proof.
				flags.push("guessed-scope");
				cues.push(`scope from: "${scope.cue}"`);
			}
			if (bullets.length >= 3 || paragraphs.length >= 3) flags.push("needs-split");
			if (section.body.length > 700) flags.push("long-body");
			if (file.modifiedFrom === "mtime" || file.modifiedFrom === undefined) {
				flags.push("inferred-date");
				cues.push(`asOf ${asOf} is the file's modification time, not a claim date`);
			}

			const targetFile = `knowledge/${topic}.md`;
			const key = `${topic}.${slug(section.heading)}`;
			const sourceParts = [`migrated from ${file.path} § ${section.heading}`];
			if (file.modified) sourceParts.push(`${file.modifiedFrom ?? "mtime"} ${file.modified}`);
			if (attributionNote) sourceParts.push(attributionNote);

			proposals.push({
				sourceFile: file.path,
				sourceHeading: section.heading,
				targetFile,
				key,
				scope: scope.scope,
				kind: kind.kind,
				asOf,
				asOfFrom: file.modifiedFrom ?? "unknown",
				source: sourceParts.join(" — "),
				body: section.body,
				flags,
				cues,
			});
		}
	}

	const byKey = new Map<string, string[]>();
	const byHeading = new Map<string, string[]>();
	for (const proposal of proposals) {
		byKey.set(proposal.key, [...(byKey.get(proposal.key) ?? []), proposal.sourceFile]);
		const heading = proposal.sourceHeading.toLowerCase();
		byHeading.set(heading, [...(byHeading.get(heading) ?? []), proposal.sourceFile]);
	}

	const keyCollisions = [...byKey.entries()].filter(([, sources]) => sources.length > 1).map(([key, sources]) => ({ key, sources }));
	for (const collision of keyCollisions) for (const proposal of proposals) if (collision.key === proposal.key && !proposal.flags.includes("key-collision")) proposal.flags.push("key-collision");

	const sameHeading = [...byHeading.entries()].filter(([, sources]) => sources.length > 1).map(([heading, sources]) => ({ heading, sources }));
	for (const shared of sameHeading) for (const proposal of proposals) if (proposal.sourceHeading.toLowerCase() === shared.heading && !proposal.flags.includes("same-heading-elsewhere")) proposal.flags.push("same-heading-elsewhere");

	return { proposals, skippedSections, skippedFiles, attribution, keyCollisions, sameHeading, preambles };
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

	for (const request of requests) {
		const identity = `${request.file}\u0000${request.key}\u0000${request.scope}`;
		const previous = claimed.get(identity);
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
