#!/usr/bin/env node
/** Replay actual injection decisions, including category eligibility and withholding.
 * Today's bank and clipped logged prompts are not historical ground truth.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { loadHarness, checkArgs } from "./harness.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const arg = (key, fallback) => { const i = process.argv.indexOf(`--${key}`); return i >= 0 ? process.argv[i + 1] : fallback; };
checkArgs(["bank", "policy", "cuts"]);
const bank = path.resolve(arg("bank", process.env.PI_MEMORY_DIR ?? path.join(os.homedir(), ".pi/memory3")));
const jiti = createJiti(import.meta.url);
const { contentTerms } = await jiti.import(path.join(repo, "search.ts"));
const { splitLoggedSessions } = await jiti.import(path.join(repo, "evaluation.ts"));
const events = [], logs = path.join(bank, "logs");
for (const file of fs.readdirSync(logs).filter((f) => /^usage-.*\.jsonl$/.test(f)).sort()) {
  for (const line of fs.readFileSync(path.join(logs, file), "utf8").split("\n")) {
    try { events.push(JSON.parse(line)); } catch {}
  }
}
const { sessions, unattributed } = splitLoggedSessions(events);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "memory-replay-"));
try {
  for (const rel of ["core", "knowledge", "history"]) {
    const from = path.join(bank, rel); if (fs.existsSync(from)) fs.cpSync(from, path.join(temp, rel), { recursive: true });
  }
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(bank, "config.json"), "utf8")) ?? {}; } catch {}
  const policy = arg("policy", cfg.retrieval?.mode ?? "legacy");
  const harness = await loadHarness(path.join(repo, "index.ts"), temp);
  if (!["legacy", "balanced"].includes(policy)) throw new Error("--policy must be legacy or balanced");
  async function replay(mode, floor) {
    const rows = []; let prompts = 0, named = 0, chars = 0;
    for (const session of sessions) {
      await harness.start({ ...cfg, log: false, retrieval: { ...cfg.retrieval, mode, ...(floor === undefined ? {} : { minScorePerTerm: floor }) } });
      for (const prompt of session.prompts) {
        const result = await harness.inject(prompt); const details = result?.message?.details ?? {};
        const terms = details.queryTerms ?? new Set(contentTerms(prompt)).size;
        (details.files ?? []).forEach((hit, rank) => rows.push({ path: hit.path, rank, score: hit.score, norm: hit.score / Math.max(1, terms) }));
        prompts++; named += (details.withheld ?? []).length; chars += String(result?.message?.content ?? "").length;
      }
    }
    return { rows, prompts, named, chars };
  }
  const { rows, prompts, named, chars } = await replay(policy);
  const pctl = (values, p) => { const a = [...values].sort((x,y)=>x-y); return a.length ? a[Math.min(a.length-1,Math.floor(a.length*p))].toFixed(1) : "n/a"; };
  const counts = new Map(); for (const row of rows) counts.set(row.path, (counts.get(row.path) ?? 0) + 1);
  console.log(`Actual injection replay — bank ${bank}, policy ${policy}`);
  console.log(`${prompts} prompt events in ${sessions.length} sessions; ${rows.length} admitted slots; ${named} files named instead of sent; ${chars.toLocaleString()} chars`);
  for (const rank of [0,1,2]) {
    const sample = rows.filter((row)=>row.rank===rank);
    console.log(`  rank ${rank+1}: n=${sample.length}, score/content-term p25 ${pctl(sample.map(r=>r.norm),.25)}, p50 ${pctl(sample.map(r=>r.norm),.5)}, p75 ${pctl(sample.map(r=>r.norm),.75)}`);
  }
  console.log(`  most admitted: ${[...counts].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([f,n])=>`${f} ${n}`).join(", ")}`);
  if (process.argv.includes("--cuts")) {
    console.log("  Candidate floors through the same production handler (balanced; relative floor 0.25 unless configured):");
    for (const floor of arg("cuts", "3,5,8").split(",").map(Number)) {
      if (!Number.isFinite(floor) || floor < 0 || floor > 1000) throw new Error("Invalid --cuts list (0..1000)");
      const candidate = await replay("balanced", floor);
      console.log(`    A=${floor}: ${candidate.rows.length} admitted slots; ${candidate.named} named-only files; ${candidate.chars.toLocaleString()} chars (baseline ${chars.toLocaleString()})`);
    }
  }
  console.log(`${unattributed} legacy prompts lacked session IDs and were isolated. Retries are retained as prompt events.`);
  console.log("These are the actual injector's decisions, not four raw search ranks. Today's bank and clipped logged prompts size changes; only reviewed frozen labels can establish required recall.");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
