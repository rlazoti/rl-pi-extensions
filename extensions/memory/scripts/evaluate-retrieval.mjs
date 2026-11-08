#!/usr/bin/env node
/** Frozen fixture evaluation of the actual before_agent_start pipeline. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { loadHarness, checkArgs } from "./harness.mjs";

const repo = path.resolve(import.meta.dirname, "..");
checkArgs(["corpus", "policy", "json", "strict"]);
const arg = (key, fallback) => { const i = process.argv.indexOf(`--${key}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const corpus = JSON.parse(fs.readFileSync(path.resolve(arg("corpus", path.join(repo, "fixtures/retrieval/corpus.json"))), "utf8"));
const jiti = createJiti(import.meta.url);
const { validateCorpus, scoreEvaluation } = await jiti.import(path.join(repo, "evaluation.ts"));
validateCorpus(corpus);
const bank = fs.mkdtempSync(path.join(os.tmpdir(), "memory-evaluation-"));
const observations = [];
const policy = arg("policy", "legacy");
try {
  if (!["legacy", "balanced"].includes(policy)) throw new Error("--policy must be legacy or balanced");
  for (const [rel, text] of Object.entries(corpus.files)) {
    const file = path.join(bank, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  }
  const harness = await loadHarness(path.join(repo, "index.ts"), bank);
  let session;
  for (const row of corpus.cases) {
    const next = row.session ?? row.id;
    if (session !== next) {
      await harness.start({ ...corpus.config, ...row.config, retrieval: { ...corpus.config?.retrieval, ...row.config?.retrieval, mode: policy }, maintenance: { historyMaxDays: 0, ...corpus.config?.maintenance, ...row.config?.maintenance } }); session = next;
    }
    const result = await harness.inject(row.prompt);
    const details = result?.message?.details ?? {};
    observations.push({ id: row.id, files: (details.files ?? []).map((h) => h.path), named: details.withheld ?? [], chars: String(result?.message?.content ?? "").length });
  }
  const report = scoreEvaluation(corpus, observations);
  const output = { policy, provenance: corpus.provenance, ...report, observations };
  if (process.argv.includes("--json")) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`Frozen retrieval evaluation — ${report.cases} cases, ${Object.keys(corpus.files).length} snapshots, policy ${policy}`);
    console.log(`Labels: ${corpus.provenance.status}; owner reviewed: ${report.ownerReviewed}`);
    console.log(`Required recall: ${report.found}/${report.required} (${Math.round(report.recall * 100)}%); relevant slots: ${report.relevant}/${report.slots} (${Math.round(report.precision * 100)}%)`);
    console.log(`No-memory cases: ${report.correctNone}/${report.noMemory}; sent ${report.chars.toLocaleString()} chars; ${report.failures.length} cases differ from labels`);
    for (const failure of report.failures) console.log(`  ${failure.id}: ${JSON.stringify(failure)}`);
  }
  // Strict is a fixture contract, never a claim of owner approval or live-bank accuracy.
  if (process.argv.includes("--strict") && report.failures.length) process.exitCode = 1;
} finally { fs.rmSync(bank, { recursive: true, force: true }); }
