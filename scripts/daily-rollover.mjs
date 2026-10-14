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

import { loadKnowledgeStore, memoryPaths, readBankFile, writeBankFile } from "../extensions/memory/fs-store.ts";
import { dailyFreshness, planDailyRollover, renderRolloverNotice } from "../extensions/memory/rollover.ts";
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

const file = readBankFile(paths, "core/dailyContext.md");
const today = new Date().toISOString().slice(0, 10);
const freshness = dailyFreshness(file, today);
console.log(`Daily file: core/dailyContext.md dated ${freshness.date?.date ?? "unknown"}${freshness.date?.source === "mtime" ? " (by file mtime — no date field)" : ""}; today is ${today}.`);

const plan = planDailyRollover(file, today, { force });
if (plan === null) {
	console.log("Already current — nothing archived. Use --force to archive a file whose content is from earlier days anyway.");
	process.exit(0);
}

if (writeBankFile(paths, plan.archivePath, plan.archiveText, { noOverwrite: true }) === null) {
	console.error(`Refusing to overwrite the existing record at ${plan.archivePath}. Nothing else changed.`);
	process.exit(3);
}
writeBankFile(paths, "core/dailyContext.md", plan.freshText);
console.log(renderRolloverNotice(plan));
if (plan.notCarried.length > 0) {
	console.log("\nNot carried, with reasons:");
	for (const item of plan.notCarried) console.log(`- ${item.heading}: ${item.reason}`);
}

const after = loadKnowledgeStore(paths);
console.log(`\nEntry stores unchanged: ${after.store.byPath.size} file(s), ${[...after.store.byPath.values()].reduce((total, entry) => total + entry.entries.length, 0)} entries.`);
