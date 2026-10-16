import assert from "node:assert/strict";
import test from "node:test";

import { isAssertionKey, parseTopicFile } from "./schema.ts";
import { buildStore } from "./resolver.ts";
import { migrationRequests, prepareMigrationStore, proposeMigration, renderMigrationReport, simulateMigration, type SourceFile } from "./migrate.ts";

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

test("a section that reads like several claims is split into one entry per claim", () => {
	const report = proposeMigration([source("knowledge/list.md", "# list\n\n## Rules\n- never push to main\n- always run npm test first\n- run lint before the tests\n- keep commits small\n")]);
	assert.deepEqual(report.proposals.map((proposal) => proposal.key), [
		"list.rules",
		"list.rules.always-npm-test-first",
		"list.rules.lint-before-tests",
		"list.rules.keep-commits-small",
	]);
	assert.ok(report.proposals.every((proposal) => new Set(proposal.flags).size === proposal.flags.length), "flags must not accumulate across siblings");
	assert.ok(report.proposals.every((proposal) => !proposal.flags.includes("same-heading-elsewhere")), "sibling claims share a heading by construction; that is not a repeat");
	assert.ok(report.proposals.every((proposal) => proposal.flags.includes("mechanical-split")));
	assert.ok(report.proposals.every((proposal) => !proposal.flags.includes("needs-split")));
	assert.match(report.proposals[1]!.source, /claim 2 of 4/);
	// Kind is judged per claim, not per section: only the modal bullet is a rule.
	assert.deepEqual(report.proposals.map((proposal) => proposal.kind), ["rule", "rule", "procedure", "fact"], "kind is judged per claim: only the modal bullets read as rules");
});

test("an example bullet qualifies the claim above it instead of becoming a claim", () => {
	const text = `# git

## Branch naming

All branches follow this pattern:

\`\`\`
rl-<MM>-<DD>-<short_description>
\`\`\`

- \`MM\` and \`DD\` are the current local month/day, zero-padded
- Example: rl-02-16-cancel-button
- Branches are cut from main at the point of the release
`;
	const report = proposeMigration([source("knowledge/git-standards.md", text)]);
	const keys = report.proposals.map((proposal) => proposal.key);
	assert.deepEqual(keys, ["git-standards.branch-naming", "git-standards.branch-naming.branches-cut-main-point"], "the month/day definition and the worked example qualify the pattern; they do not become claims of their own");
	const lead = report.proposals[0]!;
	assert.match(lead.body, /```/);
	assert.match(lead.body, /zero-padded/);
	assert.ok(isAssertionKey(lead.key) && keys.every((key) => isAssertionKey(key)));
});

test("splitting can be turned off, and the section then stays flagged instead", () => {
	const report = proposeMigration([source("knowledge/list.md", "# list\n\n## Rules\n- never push to main\n- always run npm test first\n- run lint before the tests\n")], { split: false });
	assert.deepEqual(report.proposals.map((proposal) => proposal.key), ["list.rules"]);
	assert.ok(report.proposals[0]!.flags.includes("needs-split"));
});

test("two claims in one section that read alike are flagged, even though the gate cannot see them as rivals", () => {
	const report = proposeMigration([source("knowledge/list.md", "# list\n\n## Notes on loading\n- never use require at the top level of anything\n- never use require at the top level of modules\n- keep it simple\n")]);
	const twins = report.proposals.filter((proposal) => proposal.flags.includes("similar-claim"));
	assert.equal(twins.length, 2, "the lead claim and its paraphrase, not just the paraphrase");
	assert.ok(twins.every((proposal) => proposal.cues.join(" ").includes("sibling claim")));
	assert.deepEqual(report.similarClaims.map((group) => group.keys.sort()), [report.proposals.filter((proposal) => proposal.key !== "list.notes-on-loading.keep-simple").map((proposal) => proposal.key).sort()]);
	// Different keys, so the gate is blind here by construction: the flag is the net.
	assert.deepEqual(report.keyCollisions, []);
	assert.match(renderMigrationReport(report), /Claims that read like the same assertion/);
});

test("a claim lead is shortened rather than turning into an unreadable key", () => {
	const long = "Extensions load through jiti so types are stripped and never checked which means a repo can be type-broken with zero errors";
	const report = proposeMigration([source("knowledge/list.md", `# list\n\n## Loading\n- ${long}\n- keep it simple\n- run tsc yourself\n`)]);
	for (const proposal of report.proposals) {
		const segment = proposal.key.split(".").pop()!;
		assert.ok(segment.length <= 40, `${proposal.key} has a ${segment.length}-character final segment`);
		assert.ok(isAssertionKey(proposal.key), `${proposal.key} is not a valid assertion key`);
	}
});

test("in-place migration consumes the prose it read, and keeps claims someone wrote by hand", () => {
	const prose = `# Docs preference

## Rule

Do NOT create an intent / spec / scenarios trio.
- One README per component is the source of truth.

## Applies to

Each extension already has its own README.

## rl-docs-preference.readme-first

- kind: rule
- scope: global
- asOf: 2026-06-01
Write the README before the code, not after.
`;
	const prepared = prepareMigrationStore(buildStore([parseTopicFile(prose, "knowledge/rl-docs-preference.md")]), ["knowledge/rl-docs-preference.md"]);
	assert.deepEqual(prepared.consumed.map((entry) => entry.heading), ["Rule", "Applies to"], "unkeyed prose is the migration input, not a claim to preserve");
	assert.deepEqual(prepared.preserved, ["knowledge/rl-docs-preference.md#rl-docs-preference.readme-first"]);

	const report = proposeMigration([source("knowledge/rl-docs-preference.md", prose)]);
	const simulation = simulateMigration(prepared.store, migrationRequests(report));
	const written = simulation.edits.find((edit) => edit.path === "knowledge/rl-docs-preference.md")!.content;
	assert.match(written, /## rl-docs-preference\.rule/);
	assert.match(written, /## rl-docs-preference\.readme-first/);
	assert.equal(written.includes("## Applies to"), false, "the skipped section does not come back dressed up as an entry with a kind: field");
	assert.match(written, /# Docs preference/, "the file keeps its title");
});

test("a half-migrated file is not re-mined for claims out of its own metadata", () => {
	const prose = `# Docs preference

## Rule

Write the README before the code.

## rl-docs-preference.readme-first

- kind: rule
- scope: global
- asOf: 2026-06-01
Write the README before the code, not after.
`;
	const report = proposeMigration([source("knowledge/rl-docs-preference.md", prose)]);
	assert.deepEqual(report.proposals.map((proposal) => proposal.key), ["rl-docs-preference.rule"]);
	assert.deepEqual(report.alreadyEntries, [{ sourceFile: "knowledge/rl-docs-preference.md", heading: "rl-docs-preference.readme-first" }]);
	assert.equal(report.proposals.some((proposal) => proposal.body.includes("kind: rule")), false, "an entry's fields are not claims");
	assert.match(renderMigrationReport(report), /Already entries, left untouched/);
});

test("a heading that claims to be an entry but is not entry-shaped is reported as broken", () => {
	const report = proposeMigration([source("knowledge/broken.md", "# broken\n\n## ui.background\nsome prose with no fields\n")]);
	assert.deepEqual(report.proposals, []);
	assert.match(report.skippedSections[0]!.reason, /broken entry/);
});

test("a migrated claim that lands on a hand-written claim is stopped, not applied over it", () => {
	const prose = `# Docs preference

## Rule
Write the README before the code, always.

## Scope of the rule
Each extension already has its own README.

## rl-docs-preference.rule

- kind: rule
- scope: global
- asOf: 2026-06-01
Write the README before the code, not after.
`;
	const prepared = prepareMigrationStore(buildStore([parseTopicFile(prose, "knowledge/rl-docs-preference.md")]), ["knowledge/rl-docs-preference.md"]);
	const report = proposeMigration([source("knowledge/rl-docs-preference.md", prose)]);
	const simulation = simulateMigration(prepared.store, migrationRequests(report));

	// The gate would have allowed it: same key, same heading, so it reads as an
	// amendment. A migration does not own a claim someone wrote by hand.
	assert.deepEqual(simulation.accepted, ["rl-docs-preference.scope-of-the-rule"]);
	assert.deepEqual(simulation.collided, [{ key: "rl-docs-preference.rule", file: "knowledge/rl-docs-preference.md", first: "knowledge/rl-docs-preference.md#rl-docs-preference.rule", second: "knowledge/rl-docs-preference.md#Rule" }]);
	const written = simulation.edits.find((edit) => edit.path === "knowledge/rl-docs-preference.md")!.content;
	assert.match(written, /Write the README before the code, not after\./, "the hand-written claim keeps its own text");
	assert.equal(written.includes("Write the README before the code, always."), false);
});

test("a split claim does not inherit the list's indentation", () => {
	const report = proposeMigration([source("knowledge/indent.md", "# indent\n\n## Rule\nDo NOT create a trio of files\n  for design docs.\n- One README is the source of truth\n- Keep it short\n")]);
	for (const proposal of report.proposals) {
		assert.equal(/^ {2,}\S/m.test(proposal.body), false, `${proposal.key} kept the source indentation`);
	}
});

test("decided file moves are reported as decisions, not performed", () => {
	const report = proposeMigration([source("knowledge/planish.md", "# planish\n\n## Done\nShipped.\n")], { moves: [{ from: "knowledge/implementation-plan.md", to: "core/implementation-plan.md", reason: "status snapshot, not durable claims" }] });
	assert.equal(report.moves.length, 1);
	assert.match(renderMigrationReport(report), /knowledge\/implementation-plan\.md -> core\/implementation-plan\.md/);
	assert.ok(!report.proposals.some((proposal) => proposal.sourceFile === "knowledge/implementation-plan.md"));
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

test("re-applying an applied plan stops instead of duplicating or churning", () => {
	const report = proposeMigration([source("knowledge/git-standards.md", GIT_FILE)]);
	const requests = migrationRequests(report);
	const first = simulateMigration(EMPTY_STORE, requests);
	const migrated = buildStore(first.edits.map((edit) => parseTopicFile(edit.content, edit.path)));

	const replay = simulateMigration(migrated, requests);
	assert.deepEqual(replay.accepted, []);
	assert.deepEqual(replay.edits, [], "nothing is rewritten, so a re-run cannot churn the bank");
	assert.equal(replay.collided.length, 2, "both claims are already in the store under those identities");

	// The honest second pass: re-read the migrated file and it proposes nothing,
	// because everything in it is already an entry.
	const second = proposeMigration([source("knowledge/git-standards.md", first.edits[0]!.content)]);
	assert.deepEqual(second.proposals, []);
	assert.equal(second.alreadyEntries.length, 2);
});

test("the report says it wrote nothing and shows every judgement", () => {
	const report = proposeMigration([source("knowledge/git-standards.md", GIT_FILE), source("knowledge/implementation-plan.md", "# Implementation plan\n\n## Phase 1 (COMPLETE)\ndone\n")]);
	const text = renderMigrationReport(report);
	assert.match(text, /^Migration plan \(dry run — nothing was written\)/);
	assert.match(text, /Proposals: 2; skipped files: 1; skipped sections: 2/);
	assert.match(text, /git-standards\.branch-naming\s+→\s+knowledge\/git-standards\.md/);
	assert.match(text, /asOf 2026-10-10 \(file mtime — inferred\)/);
	assert.match(text, /Provenance folded into source:/);
	assert.match(text, /§ Source: provenance . folded into the entries/);
});
