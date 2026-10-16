#!/usr/bin/env node
// Dry run of the knowledge-bank migration (memory Phase 5b).
//
//   node --experimental-strip-types --import ./test-support/register.mjs \
//     scripts/migrate-report.mjs [--bank <dir>] [--out <file>]
//
// There is deliberately no --apply flag. The writer that matters lives behind the
// admission gate in the extension; a report script that could also overwrite your
// bank is a tool you will eventually run by habit.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { listKnowledgeFiles, loadKnowledgeStore, memoryPaths } from "../extensions/memory/fs-store.ts";
import { migrationRequests, prepareMigrationStore, proposeMigration, renderMigrationReport, simulateMigration } from "../extensions/memory/migrate.ts";

const args = process.argv.slice(2);
const flag = (name) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? undefined : args[index + 1];
};

const paths = flag("bank") ? memoryPaths({ ...process.env, PI_MEMORY_DIR: resolve(flag("bank")) }) : memoryPaths();
const sources = [];

const dateOf = (absolute) => {
	const modified = statSync(absolute).mtime;
	return { modified: modified.toISOString().slice(0, 10), modifiedFrom: "mtime" };
};

for (const relativePath of listKnowledgeFiles(paths)) {
	const absolute = join(paths.root, relativePath);
	const date = dateOf(absolute);
	sources.push({ path: relativePath, text: readFileSync(absolute, "utf8"), ...date });
}

// Read so they can be reported as skipped with a reason: a dry run must account for
// every file in the bank, not just the ones it plans to change.
for (const entry of ["activeProjects.md", "dailyContext.md"]) {
	const absolute = join(paths.root, "core", entry);
	if (existsSync(absolute)) sources.push({ path: `core/${entry}`, text: readFileSync(absolute, "utf8"), ...dateOf(absolute) });
}

const moves = [];
for (let i = 0; i < args.length; i += 1) {
	if (args[i] !== "--move") continue;
	const [from, to] = (args[i + 1] ?? "").split("=>").map((part) => part.trim());
	if (from && to) moves.push({ from, to, reason: "decided by the human while reviewing an earlier dry run of this bank" });
}

const report = proposeMigration(sources, { split: flag("no-split") === undefined ? true : false, moves });
report.skippedFiles.push({ sourceFile: "history/", reason: "dated session context — it is a record of what was true on a day, and the entry store keeps claims that are still true" });

const loaded = loadKnowledgeStore(paths);
const migratedFiles = [...new Set(report.proposals.map((proposal) => proposal.sourceFile))];
const prepared = prepareMigrationStore(loaded.store, migratedFiles);
const simulation = simulateMigration(prepared.store, migrationRequests(report));

const lines = [
	renderMigrationReport(report).trimEnd(),
	"",
	"Simulated through the admission gate:",
	`- accepted: ${simulation.accepted.length}`,
	`- unchanged (already in the store): ${simulation.unchanged.length}`,
	`- refused as rival claims: ${simulation.refused.length}`,
	`- stopped as same-key collisions inside the batch: ${simulation.collided.length}`,
	`- rejected as malformed: ${simulation.rejected.length}`,
	`- files that would change: ${simulation.edits.map((edit) => edit.path).join(", ") || "(none)"}`,
	"",
	"This migration writes entries into the files it read them from:",
	...simulation.edits.map((edit) => `- ${edit.path} (replaces the prose it came from)`),
	"A backup of the bank is not optional, and staging the entries in new files instead is a target-rename decision to make before anything is applied.",
];

// Violations are only meaningful once separated by cause: files the migration
// leaves as prose are expected to be unkeyed, files it writes must not be.
const written = new Set(simulation.edits.map((edit) => edit.path));
const causedByMigration = simulation.violationsAfter.filter((violation) => written.has(violation.split(" ")[1] ?? ""));
const leftAsProse = simulation.violationsAfter.length - causedByMigration.length;

const rewritten = new Set(simulation.edits.map((edit) => edit.path));
const carried = new Set(report.proposals.filter((proposal) => rewritten.has(proposal.targetFile)).map((proposal) => `${proposal.targetFile}#${proposal.sourceHeading}`));
const dropped = prepared.consumed.filter((heading) => !carried.has(`${heading.path}#${heading.heading}`));

lines.push("", "Prose consumed by the rewrite — each heading either became an entry listed above or is listed as dropped below; the original file survives only in the backup:");
for (const heading of prepared.consumed) {
	if (!carried.has(`${heading.path}#${heading.heading}`)) continue;
	lines.push(`- ${heading.path} § ${heading.heading} → entries`);
}
lines.push("", "Not carried over into entries. The reason is the one given above; anything here that reads like a claim should get its own heading before the plan is approved:");
if (dropped.length === 0) lines.push("- nothing");
const skipReason = new Map(report.skippedSections.map((skip) => [`${skip.sourceFile}#${skip.heading}`, skip.reason]));
for (const heading of dropped) {
	const reason = skipReason.get(`${heading.path}#${heading.heading}`) ?? "";
	const where = reason.includes("folded into") ? " → folded into the entries' source: field" : reason.includes("structural") ? " → structural heading, prose not kept" : " → not kept";
	lines.push(`- ${heading.path} § ${heading.heading}${where}`);
}
if (prepared.preserved.length > 0) lines.push("", `Pre-existing claims kept in those files: ${prepared.preserved.join(", ")}`);
else lines.push("", "Pre-existing claims kept in those files: none — these files hold no keyed entries yet");

lines.push("", "After the migration:");
lines.push(`- violations introduced by files the migration writes: ${causedByMigration.length === 0 ? "none" : causedByMigration.join("; ")}`);
lines.push(`- violations in files left as prose (expected until they are migrated or moved out of knowledge/): ${leftAsProse}`);

if (simulation.collided.length > 0) {
	lines.push("", "Sections that would land on one key — a human has to name one of them:");
	for (const collision of simulation.collided) lines.push(`- ${collision.key} in ${collision.file}: ${collision.first} vs ${collision.second}`);
}
if (simulation.refused.length > 0) {
	lines.push("", "Rival claims the gate refused:");
	for (const refusal of simulation.refused) lines.push(`- ${refusal.key}: ${refusal.explanation}`);
}
if (simulation.rejected.length > 0) {
	lines.push("", "Proposals the schema rejected:");
	for (const rejection of simulation.rejected) lines.push(`- ${rejection.key} (${rejection.reason}): ${rejection.explanation}`);
}
if (loaded.unreadable.length > 0) {
	lines.push("", `Could not read: ${loaded.unreadable.map((entry) => entry.path ?? entry).join(", ")}`);
}

lines.push("", `Bank: ${paths.root}`, `Sources read: ${sources.length}`, "Written: nothing");

// --preview writes the exact bytes the gate would write, into a scratch directory.
// Reading the migrated file is the only review that counts: a table of proposals is
// a summary of the decision, not the decision.
const preview = flag("preview");
if (preview) {
	for (const edit of simulation.edits) {
		const target = join(resolve(preview), edit.path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, edit.content);
	}
	lines.push("", `Preview of the exact bytes written into ${resolve(preview)} (${simulation.edits.length} files) — the bank itself was not touched`);
}

const text = `${lines.join("\n")}\n`;
const out = flag("out");
if (out) {
	mkdirSync(dirname(resolve(out)), { recursive: true });
	writeFileSync(resolve(out), text);
	console.log(`Report written to ${resolve(out)} (${sources.length} files read from ${paths.root}; nothing in the bank was modified)`);
	console.log(`Applying this plan means replacing ${simulation.edits.length} file(s) in place: back up ${paths.root} first.`);
} else {
	console.log(text);
}
