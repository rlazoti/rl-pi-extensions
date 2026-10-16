#!/usr/bin/env node
// Daily rollover, on demand (memory Phase 6).
//
//   node --experimental-strip-types --import ./test-support/register.mjs \
//     scripts/daily-rollover.mjs [--bank <dir>] [--force]
//
// Normally the extension does this itself at session start. The --force case is for
// a file whose content is clearly from earlier days while its modification time is
// today — something no date check can see, so a human has to say it.
import { join, resolve } from "node:path";

import { loadKnowledgeStore, memoryPaths } from "../extensions/memory/fs-store.ts";
import { createService } from "../extensions/memory/service.ts";

const args = process.argv.slice(2);
const force = args.includes("--force");
const bankIndex = args.indexOf("--bank");
const paths = bankIndex === -1 ? memoryPaths() : memoryPaths({ ...process.env, PI_MEMORY_DIR: resolve(args[bankIndex + 1]) });

const service = createService(paths);
const status = service.daily();
if (!status.exists) {
	console.log(`No daily file at ${join(paths.root, "core", "dailyContext.md")} — nothing to roll over.`);
	process.exit(0);
}

const freshness = status.freshness;
console.log(`Daily file: core/dailyContext.md dated ${freshness.date?.date ?? "unknown"}${freshness.date?.source === "mtime" ? " (by file mtime — no date field)" : ""}; today is ${new Date().toISOString().slice(0, 10)}.`);

// One rollover, not two: the extension runs this same call at session start, so a
// second implementation here is how the two grow different rules (this script used to
// have its own archive-collision branch, and blocked on a day that already had a
// record while the service would have archived beside it).
const outcome = service.rollDaily({ force });
if (!outcome.performed) {
	const current = outcome.reason === "the daily file is already current";
	console.log(current ? "Already current — nothing archived. Use --force to archive a file whose content is from earlier days anyway." : `Not rolled over: ${outcome.reason}`);
	process.exit(current ? 0 : 3);
}

console.log(outcome.notice);
if (outcome.notCarriedDetail.length > 0) {
	console.log("\nNot carried, with reasons:");
	for (const item of outcome.notCarriedDetail) console.log(`- ${item.heading}: ${item.reason}`);
}

const after = loadKnowledgeStore(paths);
console.log(`\nEntry stores unchanged: ${after.store.byPath.size} file(s), ${[...after.store.byPath.values()].reduce((total, entry) => total + entry.entries.length, 0)} entries.`);
