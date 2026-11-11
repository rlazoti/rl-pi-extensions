#!/usr/bin/env node
/**
 * Does meaning find files that keywords miss? Judged on a bank you name, with prompts you label.
 *
 *   npm run eval:semantic -- --bank ~/.pi/memory --cases my-cases.json
 *
 * cases.json:  [{ "id": "csv", "prompt": "where do I save the spreadsheet I export", "expect": ["knowledge/csv-output-location.md"] }]
 *
 * For each case it reports the rank of the first expected file for keywords alone and for keywords fused with
 * `qmd vsearch`, then how many landed in the top 3 each way, which cases meaning gained, and which the fusion
 * lost (should be none). The cases are never shipped with the repo: they name files of a private bank, and a label
 * is only as good as whoever wrote it. The first numbers (a live bank, 15 prompts, labels by the agent that ran
 * them) are in the README, as a direction.
 *
 * It works on a COPY of the bank in a temp directory, never on the bank itself: running the extension starts a
 * session, and a session may roll the daily file over, scaffold files and write a config. The copy gets its own qmd
 * index, built by the extension's own Refresher (about a minute for 400 files, so the index measured is the one the
 * extension would build), and both are deleted afterwards. The bank and the operator's indexes are never touched.
 * Needs qmd's models to be present already. `--limit N` sets k (default 3).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { loadHarness, checkArgs } from "./harness.mjs";

const repo = path.resolve(import.meta.dirname, "..");
checkArgs(["bank", "cases", "limit", "json"]);
const arg = (key, fallback) => { const i = process.argv.indexOf(`--${key}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const bankArg = arg("bank"), casesArg = arg("cases");
if (!bankArg || !casesArg) { console.error("Usage: npm run eval:semantic -- --bank <dir> --cases <cases.json> [--limit 3] [--json]"); process.exit(1); }
const bank = path.resolve(bankArg.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
const k = Number(arg("limit", "3"));
if (!fs.existsSync(path.join(bank, "core")) && !fs.existsSync(path.join(bank, "knowledge"))) { console.error(`${bank} does not look like a memory bank`); process.exit(1); }
const cases = JSON.parse(fs.readFileSync(path.resolve(casesArg), "utf8"));
const jiti = createJiti(import.meta.url);
const { firstRank, summarizeRanks } = await jiti.import(path.join(repo, "evaluation.ts"));
const { Refresher, probe } = await jiti.import(path.join(repo, "semantic.ts"));

const qmd = process.env.PI_MEMORY_EVAL_QMD || "qmd";
process.env.PI_MEMORY_QMD = qmd;
const found = await probe(5000);
if (!found.available) { console.error(`qmd is not available: ${found.reason}`); process.exit(1); }

// A copy, without the extension's own bookkeeping: recovery snapshots, locks and logs are not memory.
const copy = fs.mkdtempSync(path.join(os.tmpdir(), "memory-semantic-eval-"));
fs.cpSync(bank, copy, { recursive: true, filter: (src) => !/(^|\/)\.(revisions|write-locks|logs)(\/|$)/.test(path.relative(bank, src)) });
const { indexNameFor } = await jiti.import(path.join(repo, "semantic.ts"));
const indexFiles = ["", "-shm", "-wal"].map((suffix) => path.join(os.homedir(), ".cache", "qmd", `${indexNameFor(copy)}.sqlite${suffix}`));
const cleanup = () => { fs.rmSync(copy, { recursive: true, force: true }); for (const f of indexFiles) fs.rmSync(f, { force: true }); };
try {
	const harness = await loadHarness(path.join(repo, "index.ts"), copy);
	process.env.PI_MEMORY_QMD = qmd; // loadHarness points measurement scripts at a dead binary; this one wants the real qmd
	// A long timeout on purpose: this measures what fusion adds, and qmd's first calls after a pause can take 15 s.
	await harness.start({ search: { semantic: "auto", semanticTimeoutMs: 30000, refreshDelayMs: 600000 }, log: false });
	const refresher = new Refresher(copy, { debounceMs: 0 });
	console.error("building a semantic index for a copy of the bank (the first run can take a minute)…");
	const pass = await refresher.run();
	if (!pass.ran || !refresher.status().lastOk) throw new Error(`index refresh did not complete: ${JSON.stringify(pass)} ${refresher.status().lastError ?? ""}`);

	const search = (query, mode) => harness.commands.get("memory").handler(`config search.semantic ${mode}`, harness.ctx)
		.then(() => harness.tools.get("memory_search").execute("eval", { query, limit: 10 }));
	const rows = [];
	for (const c of cases) {
		const keyword = await search(c.prompt, "off");
		const fused = await search(c.prompt, "auto");
		rows.push({
			id: c.id,
			keyword: firstRank(keyword.details.results.map((r) => r.path), c.expect),
			fused: firstRank(fused.details.results.map((r) => r.path), c.expect),
			semanticUsed: fused.details.semantic?.used === true,
			whyNot: fused.details.semantic?.reason ?? (fused.details.semantic?.tried ? "qmd answered with no file the bank knows" : "not tried"),
		});
	}
	const summary = summarizeRanks(rows, k);
	if (process.argv.includes("--json")) console.log(JSON.stringify({ summary, rows }, null, 2));
	else {
		console.log(`semantic evaluation — ${summary.cases} cases, correct file in the top ${k}\n`);
		for (const r of rows) console.log(`keywords=${String(r.keyword ?? "-").padEnd(3)} fused=${String(r.fused ?? "-").padEnd(3)} ${r.semanticUsed ? "" : `(keywords only: ${r.whyNot}) `}${r.id}`);
		console.log(`\nkeywords alone: ${summary.keywordTopK} of ${summary.cases}\nkeywords + meaning: ${summary.fusedTopK} of ${summary.cases}`);
		console.log(`meaning gained: ${summary.gained.join(", ") || "none"}\nfusion lost: ${summary.lost.join(", ") || "none"}`);
		console.log("\nLabels are the author's. Read this as a direction, not a benchmark.");
	}
	await harness.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, harness.ctx);
} finally {
	cleanup();
}
