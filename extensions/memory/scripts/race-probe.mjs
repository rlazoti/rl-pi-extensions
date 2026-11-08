#!/usr/bin/env node
/**
 * Concurrency probe: two Pi sessions, one shared memory bank.
 *
 * The default bank is global (~/.pi/memory3), so two Pi sessions on one machine
 * already share it, and the guidelines have both of them appending to the same
 * dailyContext.md all day. This script measures what happens when they write at
 * the same time. It runs against a throwaway directory and never touches the
 * real bank.
 *
 * Two worker processes per scenario (`scripts/race-worker.test.ts`, one
 * extension instance each), rendezvousing through marker files. Nothing is
 * measured from inside a worker: a process that lost a race is exactly the one
 * in the worst position to report it, and an early version of this script
 * believed a worker's "100% lost" line for a bank whose files were intact.
 * Everything below is read off disk afterwards.
 *
 * Usage:
 *   npm run race                       # all scenarios (~1 minute)
 *   npm run race -- update rollover    # a subset
 *   RACE_N=60 RACE_GAP=0 npm run race -- append
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const N = Number(process.env.RACE_N ?? 20);
const GAP = Number(process.env.RACE_GAP ?? 120);

// Days are local here, on purpose: `toISOString()` is UTC, which is a day ahead
// of most of the Americas in the evening and made rollover archive a file that
// had not finished yet. See the dayString tests.
const localDay = (offsetDays = 0) =>
	new Intl.DateTimeFormat("en-CA", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).format(
		new Date(Date.now() - offsetDays * 86_400_000),
	);

const SCENARIOS = ["update", "append", "mixed", "index", "rollover", "torn", "revisions", "alias-locks", "case-aliases"];

function seedBank(dir, scenario) {
	fs.mkdirSync(path.join(dir, "core"), { recursive: true });
	fs.mkdirSync(path.join(dir, "knowledge"), { recursive: true });
	fs.writeFileSync(path.join(dir, "core", "activeProjects.md"), "# Active Projects\n\n## P0 — Critical\n- probe (P0) - scratch bank\n");
	const seeds = {
		update: `## ${localDay()}\n\n### Completed\n- work both agents know about\n`,
		append: `## ${localDay()}\n\n### Completed\n\n### Key Decisions\n`,
		mixed: `## ${localDay()}\n\n### Completed\n- original\n`,
		index: `## ${localDay()}\n\n### Completed\n`,
		rollover: `## ${localDay(7)}\n\n### Completed\n- a week of work\n\n### Context for Tomorrow\n- finish the migration\n`,
		torn: `## ${localDay()}\n\n### Completed\n`,
		revisions: `## ${localDay()}\n\n### Completed\n`,
		"alias-locks": `## ${localDay()}\n\n### Completed\n`,
		"case-aliases": `## ${localDay()}\n\n### Completed\n`,
	};
	fs.writeFileSync(path.join(dir, "core", "dailyContext.md"), seeds[scenario]);
	if (scenario === "rollover") fs.mkdirSync(path.join(dir, "history", "daily"), { recursive: true });
	if (scenario === "case-aliases") {
		fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ revisions: { enabled: true } }));
		fs.writeFileSync(path.join(dir, "knowledge/case.md"), "before");
	}
	if (scenario === "alias-locks") {
		fs.symlinkSync(dir, path.join(dir, ".alias"), "dir");
		fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ revisions: { enabled: true } }));
		fs.writeFileSync(path.join(dir, "knowledge/alias.md"), "before");
	}
	if (scenario === "revisions") {
		fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ revisions: { enabled: true, maxPerFile: 4, maxTotalBytes: 65536 } }));
		for (const role of ["a", "b"]) fs.writeFileSync(path.join(dir, `knowledge/recovery-${role}.md`), `# Recovery ${role}\n\nversion 0\n${"x".repeat(6000)}\n`);
	}
}

async function runWorkers(scenario, bank, { gate = false } = {}) {
	const base = { ...process.env, RACE_BANK: bank, RACE_SCENARIO: scenario, RACE_N: String(N), RACE_GAP: String(GAP), RACE_CASE_INSENSITIVE: String(scenario === "case-aliases" && fs.existsSync(path.join(bank, "knowledge/CASE.MD"))) };
	if (gate) fs.writeFileSync(path.join(bank, ".race-go"), "");
	const runs = ["a", "b"].map((role) => {
		const log = fs.openSync(path.join(os.tmpdir(), `pi-memory-race-${scenario}-${role}.log`), "w");
		const child = spawn("npx", ["vitest", "run", "--dir", "scripts"], {
			cwd: projectDir,
			env: { ...base, RACE_ROLE: role, RACE_BANK: scenario === "alias-locks" && role === "b" ? path.join(bank, ".alias") : bank },
			stdio: ["ignore", log, log],
		});
		return new Promise((resolve) => child.once("exit", (code) => fs.closeSync(log) || resolve(code)));
	});
	const codes = await Promise.all(runs);
	return codes.map((c, i) => (c === 0 ? "ok" : `exit ${c} (see /tmp/pi-memory-race-${scenario}-${"ab"[i]}.log)`));
}

function measure(scenario, bank) {
	const daily = fs.readFileSync(path.join(bank, "core", "dailyContext.md"), "utf-8");
	const result = (label = "(worker wrote nothing)") => {
		try {
			return fs.readFileSync(path.join(bank, ".race-result"), "utf-8").trim();
		} catch {
			return label ?? "(worker wrote nothing)";
		}
	};
	switch (scenario) {
		case "update": {
			const kept = ["a", "b"].filter((r) => daily.includes(`decision from ${r}`));
			const refused = (result().match(/(\w) refused=true/g) ?? []).map((m) => m[0][0]);
			return {
				observed:
					`${kept.length} of 2 decisions survived` +
					(refused.length > 0 ? `, second write refused and re-applied (${refused.join(", ")})` : ` (${["a", "b"].filter((r) => !kept.includes(r)).join(", ")} lost)`),
				lossy: kept.length < 2,
			};
		}
		case "append": {
			const got = (daily.match(/- [ab]-\d+/g) ?? []).length;
			const want = 2 * N;
			return {
				observed: `${got} of ${want} entries survived (${want - got} lost, ${Math.round(((want - got) / want) * 100)}%)`,
				lossy: got < want,
			};
		}
		case "mixed": {
			const ok = daily.includes("- appended by a") && daily.includes("- update by b");
			return { observed: ok ? "append and update both survived" : "append or update lost", lossy: !ok };
		}
		case "index": {
			const observed = result();
			return { observed, lossy: false, fails: !observed.includes("search=true list=true") };
		}
		case "rollover": {
			const dir = path.join(bank, "history", "daily", localDay(7).slice(0, 7));
			const archives = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
			const carried = daily.includes("finish the migration");
			const dated = (daily.match(/^## (\d{4}-\d{2}-\d{2})/) ?? [])[1];
			const good = archives.length === 1 && carried && dated === localDay();
			return {
				observed: `${archives.length} archive, carried=${carried}, live dated ${dated} (today ${localDay()})`,
				lossy: false,
				fails: !good,
			};
		}
		case "revisions": {
			const dir = path.join(bank, ".revisions");
			const files = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json")) : [];
			let valid = true, bytes = 0; const snapshots = [];
			for (const file of files) {
				const full = path.join(dir, file); bytes += fs.statSync(full).size;
				try { const row = JSON.parse(fs.readFileSync(full, "utf8")); valid &&= row.sha256 === createHash("sha256").update(row.content).digest("hex"); snapshots.push(row); } catch { valid = false; }
			}
			const latest = ["a", "b"].every((role) => snapshots.some((r) => r.path === `knowledge/recovery-${role}.md` && r.content.includes(`version ${N - 1}\n`)));
			const current = ["a", "b"].every((role) => fs.readFileSync(path.join(bank, `knowledge/recovery-${role}.md`), "utf8").includes(`version ${N}\n`));
			const good = valid && latest && current && files.length === 2 * Math.min(4, N) && bytes <= 65536;
			return { observed: `${files.length} snapshots, checksums=${valid}, latest-backups=${latest}, current=${current}, ${bytes} bytes`, lossy: false, fails: !good };
		}
		case "case-aliases": {
			const observed = result();
			const store = path.join(bank, ".revisions");
			const rows = fs.readdirSync(store, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(store, f), "utf8")));
			const backup = rows.some((r) => r.path === "knowledge/case.md" && r.content === "before");
			const good = observed === "held=true updated=true creation=true internal=true" && backup && fs.readFileSync(path.join(bank, "knowledge/created.md"), "utf8") === "created by a";
			return { observed: `${observed} backup=${backup}`, lossy: false, fails: !good };
		}
		case "alias-locks": {
			const observed = result();
			const good = observed === "target=true store=true recovered=true" && fs.readFileSync(path.join(bank, "knowledge/alias.md"), "utf8") === "after";
			return { observed, lossy: false, fails: !good };
		}
		case "torn": {
			const line = result();
			// Writes land by rename, so an empty read is not a narrow window any
			// more: it is a write path that bypassed writeBankFile.
			const found = line.match(/wrong=(\d+)/);
			// No result means the workers never got that far, which is not a pass.
			const fails = !found || Number(found[1]) > 0;
			return { observed: `${line} (writes are atomic renames)`, lossy: false, fails };
		}
	}
}

const wanted = process.argv.slice(2).filter((s) => SCENARIOS.includes(s));
const list = wanted.length > 0 ? wanted : SCENARIOS;

console.log(`\nconcurrency probe — two sessions, one bank (${N} ops, ~${GAP}ms gap)\n`);
const rows = [];
let broken = false;

for (const scenario of list) {
	const bank = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-race-"));
	seedBank(bank, scenario);
	const runs = await runWorkers(scenario, bank, { gate: scenario === "rollover" });
	const m = measure(scenario, bank);
	if (m.fails || m.lossy || runs.some((r) => r !== "ok")) broken = true;
	fs.rmSync(bank, { recursive: true, force: true });
	rows.push({ scenario, ...m, runs: runs.join("/") });
	console.log(`  ${scenario.padEnd(9)} ${m.observed}${runs.includes("ok") ? "" : `  [workers: ${runs}]`}`);
}

console.log(
	`\n  update and append coordinate only with other updated memory-tool processes.\n` +
		"  External writers and older sessions remain outside the lock.\n",
);
process.exit(broken ? 1 : 0);
