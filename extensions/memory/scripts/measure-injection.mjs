// Retrospective prompt cost using the actual injector against today's bank copy.
// Session IDs and reset boundaries are respected. Unattributed legacy prompts are
// isolated: assuming they were one conversation would manufacture pointer savings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { loadHarness, checkArgs } from "./harness.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const bank = process.env.MEASURE_BANK ?? process.env.PI_MEMORY_DIR ?? path.join(os.homedir(), ".pi/memory3");
const arg = (key, fallback) => { const i = process.argv.indexOf(`--${key}`); return i >= 0 ? process.argv[i + 1] : fallback; };
checkArgs(["policy", "control"]);
const jiti = createJiti(import.meta.url);
const { splitLoggedSessions } = await jiti.import(path.join(repo, "evaluation.ts"));
const events = [];
for (const file of fs.readdirSync(path.join(bank, "logs")).filter((f) => /^usage-.*\.jsonl$/.test(f)).sort()) {
  for (const line of fs.readFileSync(path.join(bank, "logs", file), "utf8").split("\n")) {
    try { events.push(JSON.parse(line)); } catch { /* incomplete lines are normal in a live log */ }
  }
}
const { sessions, unattributed, invalid } = splitLoggedSessions(events);
function sections(block) {
  const out = []; let current = [];
  for (const line of block.split("\n")) {
    if (/^(## |--- |# Memory Bank Context)/.test(line) && current.length) { out.push(current.join("\n")); current = [line]; }
    else current.push(line);
  }
  if (current.length) out.push(current.join("\n")); return out;
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inject-measure-"));
let variant;
try {
  for (const rel of ["core", "knowledge", "history"]) {
    const from = path.join(bank, rel);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, rel), { recursive: true });
  }
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(bank, "config.json"), "utf8")) ?? {}; } catch {}
  config.log = false;
  config.retrieval = { ...config.retrieval, mode: arg("policy", config.retrieval?.mode ?? "legacy") };
  if (!["legacy", "balanced"].includes(config.retrieval.mode)) throw new Error("--policy must be legacy or balanced");
  let source = path.join(repo, "index.ts");
  const control = process.argv.includes("--control");
  if (control) {
    const parent = path.join(repo, ".measure-variant"); fs.mkdirSync(parent, { recursive: true });
    variant = fs.mkdtempSync(path.join(parent, "run-"));
    let patched = 0;
    for (const file of fs.readdirSync(repo).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const original = fs.readFileSync(path.join(repo, file), "utf8");
      const text = original.replace(/const MIN_DELTA_SAVING_CHARS = \d+;/, () => { patched++; return "const MIN_DELTA_SAVING_CHARS = 100000000;"; });
      fs.writeFileSync(path.join(variant, file), text);
    }
    if (patched !== 1) throw new Error(`Control must disable exactly one pointer threshold; found ${patched}`);
    source = path.join(variant, "index.ts");
  }
  const harness = await loadHarness(source, dir);
  const perPrompt = [];
  let sent = 0, repeated = 0;
  for (const session of sessions) {
    await harness.start(config);
    const seen = new Set();
    for (const prompt of session.prompts) {
      const result = await harness.inject(prompt);
      const block = String(result?.message?.content ?? ""); let again = 0;
      for (const section of sections(block)) {
        const key = section.trim(); if (!key) continue;
        if (seen.has(key)) again += key.length; else seen.add(key);
      }
      sent += block.length; repeated += again; perPrompt.push({ sent: block.length, repeated: again });
    }
  }
  const costs = perPrompt.map((p) => p.sent).sort((a, b) => a - b);
  const worst = [...perPrompt].sort((a, b) => b.repeated - a.repeated).slice(0, 3);
  console.log(`${perPrompt.length} prompts in ${sessions.length} sessions, bank ${bank}${control ? " [CONTROL: no pointer]" : ""}, policy ${config.retrieval.mode}`);
  console.log(`  sent ${sent.toLocaleString()} chars, of which ${repeated.toLocaleString()} were already in the session — ${sent ? (repeated / sent * 100).toFixed(1) : "0.0"} %`);
  console.log(`  median prompt ${(costs[Math.floor(costs.length / 2)] ?? 0).toLocaleString()} chars, largest ${(costs.at(-1) ?? 0).toLocaleString()}`);
  console.log(`  largest re-sends: ${worst.map((p) => `${p.repeated.toLocaleString()} of ${p.sent.toLocaleString()} chars`).join(" | ")}`);
  console.log(`  ${unattributed} legacy prompts lacked session IDs and were isolated; ${invalid} invalid timestamps skipped.`);
  console.log("  Retrospective reconstruction against today's bank, not historic ground truth. Retries are retained as actual prompt events.");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  if (variant) fs.rmSync(variant, { recursive: true, force: true });
}
