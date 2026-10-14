import assert from "node:assert/strict";
import test from "node:test";

import { parseTopicFile } from "./schema.ts";
import { buildStore } from "./resolver.ts";
import { migrationRequests, proposeMigration, renderMigrationReport, simulateMigration, type SourceFile } from "./migrate.ts";

function source(path: string, text: string, modified = "2026-10-10"): SourceFile {
	return { path, text, modified, modifiedFrom: "mtime" };
}

const GIT_FILE = `# Git standards

Preamble sentence that introduces the file.

## Branch naming
Branches are named rl-MM-DD-<topic>. Never use personal initials.

## GitHub push preferences
Never push changes to GitHub without explicit confirmation.

## Purpose
Explains how this repo handles git.

## Source
Rodrigo Lazoti, Slack thread 2026-05-01.
`;

const COMPONENT_FILE = `# Adding a component

## Required pieces
Run npm test and npm run typecheck before any commit in this repo.

## Guards a new component trips
Watch out: the catalog guard fails silently when a directory is missing an index.ts.

## Notes
Just organisation, nothing claimed.

## Empty section
`;

// ─── What becomes an entry, and what does not ───────────────────────────────

test("prose sections become keyed proposals named after their file and heading", () => {
	const report = proposeMigration([source("knowledge/git-standards.md", GIT_FILE)]);
	assert.deepEqual(
		report.proposals.map((proposal) => proposal.key),
		["git-standards.branch-naming", "git-standards.github-push-preferences"],
	);
	const first = report.proposals[0]!;
	assert.equal(first.targetFile, "knowledge/git-standards.md");
	assert.equal(first.sourceHeading, "Branch naming");
	assert.match(first.body, /Branches are named rl-MM-DD-<topic>/);
});

test("a ## Source section is provenance, not an assertion", () => {
	const report = proposeMigration([source("knowledge/git-standards.md", GIT_FILE)]);
	assert.equal(report.proposals.some((proposal) => proposal.key.endsWith("source")), false);
	assert.deepEqual(report.attribution.map((entry) => entry.sourceFile), ["knowledge/git-standards.md"]);
	assert.match(report.proposals[0]!.source, /Rodrigo Lazoti, Slack thread 2026-05-01/);
});

test("structural and empty sections are skipped with a reason, never silently", () => {
	const report = proposeMigration([source("knowledge/git-standards.md", GIT_FILE), source("knowledge/rl-adding-a-component.md", COMPONENT_FILE)]);
	const reasons = new Map(report.skippedSections.map((skip) => [`${skip.sourceFile}#${skip.heading}`, skip.reason]));
	assert.match(reasons.get("knowledge/git-standards.md#Purpose")!, /structural heading/);
	assert.match(reasons.get("knowledge/rl-adding-a-component.md#Notes")!, /structural heading/);
	assert.match(reasons.get("knowledge/rl-adding-a-component.md#Empty section")!, /no body text/);
});

test("a status snapshot stays in core/ rather than becoming entries", () => {
	const plan = `# Implementation plan\n\n## Phase 1: Documentation (COMPLETE - 36 commits)\n- wrote things\n\n## Branch: rl-10-03-x\nsome branch\n`;
	const report = proposeMigration([source("knowledge/implementation-plan.md", plan)]);
	assert.deepEqual(report.proposals, []);
	assert.equal(report.skippedFiles.length, 1);
	assert.match(report.skippedFiles[0]!.reason, /core\/activeProjects\.md/);
});

test("prose outside knowledge/ and non-markdown files are left alone, with the reason stated", () => {
	const report = proposeMigration([
		source("core/activeProjects.md", "# Active Projects\n\n## Now\nWork on memory.\n"),
		source("knowledge/index.csv", "trigger,file\npush,git-standards.md\n"),
	]);
	assert.deepEqual(report.proposals, []);
	assert.deepEqual(report.skippedFiles.map((skip) => skip.sourceFile), ["core/activeProjects.md", "knowledge/index.csv"]);
	assert.match(report.skippedFiles[0]!.reason, /stay prose/);
});

// ─── Inference is labelled, not hidden ──────────────────────────────────────

test("kind comes from a cue, and the cue is recorded", () => {
	const report = proposeMigration([source("knowledge/rl-adding-a-component.md", COMPONENT_FILE)]);
	const byKey = new Map(report.proposals.map((proposal) => [proposal.key, proposal]));
	assert.equal(byKey.get("rl-adding-a-component.required-pieces")!.kind, "procedure");
	assert.match(byKey.get("rl-adding-a-component.required-pieces")!.cues.join(" "), /steps or commands/);
	assert.equal(byKey.get("rl-adding-a-component.guards-a-new-component-trips")!.kind, "gotcha");
});

test("modal language makes a rule, and the quote is shown", () => {
	const report = proposeMigration([source("knowledge/git-standards.md", GIT_FILE)]);
	const push = report.proposals.find((proposal) => proposal.key === "git-standards.github-push-preferences")!;
	assert.equal(push.kind, "rule");
	assert.match(push.cues.join(" "), /modal obligation: "Never"/);
});

test("a section with no cue is a fact, flagged as a guess", () => {
	const report = proposeMigration([source("knowledge/plain.md", "# plain\n\n## Widget size\nThe widget is 12mm across.\n")]);
	assert.equal(report.proposals[0]!.kind, "fact");
	assert.ok(report.proposals[0]!.flags.includes("guessed-kind"));
});

test("asOf from a file mtime is flagged as inferred, not presented as the claim date", () => {
	const report = proposeMigration([source("knowledge/plain.md", "# plain\n\n## Widget size\nThe widget is 12mm across.\n", "2026-03-04")]);
	assert.equal(report.proposals[0]!.asOf, "2026-03-04");
	assert.equal(report.proposals[0]!.asOfFrom, "mtime");
	assert.ok(report.proposals[0]!.flags.includes("inferred-date"));
	assert.match(report.proposals[0]!.source, /mtime 2026-03-04/);
});

test("a guessed scope is always flagged, cue or no cue", () => {
	const report = proposeMigration([source("knowledge/rl-adding-a-component.md", COMPONENT_FILE)]);
	const procedure = report.proposals.find((proposal) => proposal.key === "rl-adding-a-component.required-pieces")!;
	assert.equal(procedure.scope, "global", "the text says \"this repo\" without naming it; inventing project:this-repo would create a scope that can never match a real cwd");
	assert.ok(procedure.flags.includes("guessed-scope"));
	assert.match(procedure.cues.join(" "), /not named — set project:<name> by hand/);
});

test("a section that reads like several claims is flagged for splitting, not merged into one blob", () => {
	const report = proposeMigration([source("knowledge/list.md", "# list\n\n## Rules\n- never push\n- always test\n- run lint first\n- keep it small\n")]);
	assert.ok(report.proposals[0]!.flags.includes("needs-split"));
});

test("identical slugs in one file and repeated headings across files are both reported", () => {
	const report = proposeMigration([
		source("knowledge/a.md", "# a\n\n## Don't push\nNever push.\n\n## Dont push\nNever push twice.\n"),
		source("knowledge/b.md", "# b\n\n## Don't push\nNever force push.\n"),
	]);
	assert.ok(report.keyCollisions.some((collision) => collision.key === "a.dont-push" && collision.sources.length === 2));
	assert.ok(report.proposals.filter((proposal) => proposal.key === "a.dont-push").every((proposal) => proposal.flags.includes("key-collision")));
	assert.ok(report.sameHeading.some((entry) => entry.heading === "don't push" && entry.sources.length === 2));
});

// ─── The migration is admitted by the same gate as any other write ──────────

const EMPTY_STORE = buildStore([]);

test("proposals flow through the gate and come back as valid topic files", () => {
	const report = proposeMigration([source("knowledge/git-standards.md", GIT_FILE)]);
	const simulation = simulateMigration(EMPTY_STORE, migrationRequests(report));

	assert.deepEqual(simulation.refused, []);
	assert.deepEqual(simulation.rejected, []);
	assert.equal(simulation.accepted.length, 2);
	assert.deepEqual(simulation.edits.map((edit) => edit.path), ["knowledge/git-standards.md"]);

	const written = simulation.edits[0]!.content;
	const reparsed = parseTopicFile(written, "knowledge/git-standards.md");
	assert.deepEqual(reparsed.entries.map((entry) => entry.key), ["git-standards.branch-naming", "git-standards.github-push-preferences"]);
	assert.deepEqual(reparsed.issues.filter((issue) => issue.severity === "error"), []);
	assert.deepEqual(reparsed.entries.map((entry) => entry.fields.migratedFrom), ["knowledge/git-standards.md#Branch naming", "knowledge/git-standards.md#GitHub push preferences"]);
	assert.deepEqual(simulation.violationsAfter, []);
});

test("two sections landing on one key are stopped before the gate can read them as amendments", () => {
	const report = proposeMigration([source("knowledge/dup.md", "# dup\n\n## Background colour\nNever use navy.\n\n## Background color\nNavy reads as black on dark displays; avoid it.\n")]);
	const requests = migrationRequests(report).map((request) => ({ ...request, key: "dup.background" }));
	const simulation = simulateMigration(EMPTY_STORE, requests);

	assert.deepEqual(simulation.accepted, ["dup.background"]);
	assert.equal(simulation.collided.length, 1);
	assert.deepEqual(
		[simulation.collided[0]!.first, simulation.collided[0]!.second],
		["knowledge/dup.md#Background colour", "knowledge/dup.md#Background color"],
	);
	// The loser's text is not in the store, and it is not a silent overwrite either.
	const written = simulation.edits[0]!.content;
	assert.match(written, /Never use navy\./);
	assert.equal(written.includes("Navy reads as black"), false);
	// Identical text is the same hazard: still one key, still two authors.
	const sameText = simulateMigration(EMPTY_STORE, migrationRequests(proposeMigration([source("knowledge/dup.md", "# dup\n\n## Background colour\nNever use navy.\n\n## Background color\nNever use navy.\n")])).map((request) => ({ ...request, key: "dup.background" })));
	assert.equal(sameText.collided.length, 1);
	assert.deepEqual(sameText.accepted, ["dup.background"]);
});

test("a section with no recoverable date cannot be migrated as an active claim", () => {
	const report = proposeMigration([{ path: "knowledge/plain.md", text: "# plain\n\n## Widget size\nThe widget is 12mm across.\n" }]);
	const simulation = simulateMigration(EMPTY_STORE, migrationRequests(report));
	assert.deepEqual(simulation.accepted, []);
	assert.equal(simulation.rejected[0]!.reason, "missing-asOf");
});

test("re-running the migration changes nothing: no duplicate claims, no churn", () => {
	const report = proposeMigration([source("knowledge/git-standards.md", GIT_FILE)]);
	const requests = migrationRequests(report);
	const first = simulateMigration(EMPTY_STORE, requests);
	const migrated = buildStore(first.edits.map((edit) => parseTopicFile(edit.content, edit.path)));
	const second = simulateMigration(migrated, requests);

	assert.deepEqual(second.accepted, []);
	assert.deepEqual(second.unchanged.sort(), ["git-standards.branch-naming", "git-standards.github-push-preferences"]);
	assert.deepEqual(second.edits, []);
});

test("the report says it wrote nothing and shows every judgement", () => {
	const report = proposeMigration([source("knowledge/git-standards.md", GIT_FILE), source("knowledge/implementation-plan.md", "# Implementation plan\n\n## Phase 1 (COMPLETE)\ndone\n")]);
	const text = renderMigrationReport(report);
	assert.match(text, /^Migration plan \(dry run — nothing was written\)/);
	assert.match(text, /Proposals: 2; skipped files: 1; skipped sections: 1/);
	assert.match(text, /git-standards\.branch-naming\s+→\s+knowledge\/git-standards\.md/);
	assert.match(text, /asOf 2026-10-10 \(file mtime — inferred\)/);
	assert.match(text, /Provenance folded into source:/);
});
