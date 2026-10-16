#!/usr/bin/env node
// Apply the knowledge-bank migration (memory Phase 5b-2).
//
//   node --experimental-strip-types --import ./test-support/register.mjs \
//     scripts/migrate-apply.mjs --yes [--bank <dir>] [--move "a => b"] [--no-split]
//
// Deliberately separate from migrate-report.mjs, and deliberately loud about the
// one thing that makes it safe: a backup that exists before the first write.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import { applyEdits, listKnowledgeFiles, loadKnowledgeStore, memoryPaths, resolveAnyInBank } from "../extensions/memory/fs-store.ts";
import { migrationRequests, prepareMigrationStore, proposeMigration, simulateMigration } from "../extensions/memory/migrate.ts";
import { parseTopicFile } from "../extensions/memory/schema.ts";
import { buildStore } from "../extensions/memory/resolver.ts";

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const flag = (name) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? undefined : args[index + 1];
};

if (!has("yes")) {
	console.error("Refusing to write without --yes. Run scripts/migrate-report.mjs first and read the plan.");
	process.exit(2);
}

const paths = flag("bank") ? memoryPaths({ ...process.env, PI_MEMORY_DIR: resolve(flag("bank")) }) : memoryPaths();
const moves = [];
for (let i = 0; i < args.length; i += 1) {
	if (args[i] !== "--move") continue;
	const [from, to] = (args[i + 1] ?? "").split("=>").map((part) => part.trim());
	if (from && to) moves.push({ from, to, reason: "decided while reviewing the dry run of this bank" });
}

const sources = [];
for (const relativePath of listKnowledgeFiles(paths)) {
	const absolute = join(paths.root, relativePath);
	const stat = statSync(absolute);
	sources.push({ path: relativePath, text: readFileSync(absolute, "utf8"), modified: stat.mtime.toISOString().slice(0, 10), modifiedFrom: "mtime" });
}

const report = proposeMigration(sources, { split: !has("no-split"), moves });
const migratedFiles = [...new Set(report.proposals.map((proposal) => proposal.sourceFile))];
const loaded = loadKnowledgeStore(paths);
const prepared = prepareMigrationStore(loaded.store, migratedFiles);
const simulation = simulateMigration(prepared.store, migrationRequests(report));

// The plan has to be clean before anything is written. A migration with refusals
// in it is an unfinished decision, and half-applying one is how a bank ends up with
// two accounts of itself.
const blocked = [...simulation.collided, ...simulation.refused, ...simulation.rejected];
if (blocked.length > 0) {
	console.error(`Plan is not clean: ${simulation.collided.length} collision(s), ${simulation.refused.length} refusal(s), ${simulation.rejected.length} rejection(s). Nothing was written.`);
	for (const item of blocked) console.error(`  ${item.key}: ${"explanation" in item ? item.explanation : `${item.first} vs ${item.second}`}`);
	process.exit(3);
}
if (simulation.edits.length === 0) {
	console.log("Nothing to do: every claim is already in the store.");
	process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backupDir = join(homedir(), ".pi", "backups");
const backup = join(backupDir, `memory-${stamp}.tar.gz`);
mkdirSync(backupDir, { recursive: true });
const tar = spawnSync("tar", ["czf", backup, "-C", paths.root, "."], { encoding: "utf8" });
if (tar.status !== 0) {
	console.error(`Backup failed (${tar.stderr.trim() || `exit ${tar.status}`}). Nothing was written.`);
	process.exit(4);
}
const listed = spawnSync("tar", ["tzf", backup], { encoding: "utf8" }).stdout.trim().split("\n").length;
console.log(`Backup: ${backup} (${listed} entries)`);
console.log(`Rollback: tar xzf ${backup} -C ${paths.root}`);

const written = applyEdits(paths, simulation.edits);
console.log(`Wrote ${written.length} file(s): ${written.join(", ")}`);

for (const move of moves) {
	const from = resolveAnyInBank(paths, move.from);
	const to = resolveAnyInBank(paths, move.to);
	if (from === null || to === null) {
		console.error(`Move refused (path outside the bank): ${move.from} => ${move.to}`);
		continue;
	}
	if (!existsSync(from)) {
		console.error(`Move refused (source missing): ${move.from}`);
		continue;
	}
	if (existsSync(to)) {
		console.error(`Move refused (target exists, refusing to overwrite): ${move.to}`);
		continue;
	}
	mkdirSync(dirname(to), { recursive: true });
	renameSync(from, to);
	console.log(`Moved ${move.from} -> ${move.to}`);
}

// Re-read from disk: the verification is of the bank, not of the in-memory plan.
const after = loadKnowledgeStore(paths);
const errors = [...after.raw.values()].flatMap((text) => parseTopicFile(text, "x").issues).filter((issue) => issue.severity === "error");
const store = buildStore([...after.store.byPath.values()]);
const entries = [...after.store.byPath.values()].reduce((total, file) => total + file.entries.length, 0);
const unkeyed = after.store.violations.filter((violation) => violation.code === "unkeyed-entry").length;

console.log(`After: ${entries} entries across ${after.store.byPath.size} file(s); parse errors ${errors.length}; store violations ${store.violations.length} (${unkeyed} unkeyed headings, expected in files that are still prose)`);
for (const violation of store.violations.filter((violation) => violation.code !== "unkeyed-entry")) console.log(`  ${violation.code} ${violation.path}: ${violation.message}`);
console.log(`Unreadable: ${after.unreadable.length === 0 ? "none" : after.unreadable.map((entry) => entry.path).join(", ")}`);
