#!/usr/bin/env node
/**
 * Semantic search against the REAL qmd, end to end, on a throwaway bank.
 *
 * Unit tests run a stand-in qmd and can never start the real one (see vitest.isolate-bank.ts), so this is the
 * only check that qmd's actual output shape, its file-name rewriting and `qmd embed` still behave the way
 * semantic.ts assumes. Run it after upgrading qmd, and when semantic results look wrong.
 *
 *   npm run smoke:semantic
 *
 * It builds a four-file bank in a temp directory, lets the extension's own Refresher build the index for it,
 * then asks a question that shares no word with the file that answers it. It needs qmd's models to be present
 * already (it will not download them: with the models missing it reports and stops). It writes one qmd index,
 * named after the temp bank, under ~/.cache/qmd, and deletes it afterwards. The operator's own indexes are
 * never touched. Skipped, exit 0, when qmd is not installed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { loadHarness } from "./harness.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const qmd = process.env.PI_MEMORY_SMOKE_QMD || "qmd";
const jiti = createJiti(import.meta.url);

const bank = fs.mkdtempSync(path.join(os.tmpdir(), "memory-semantic-smoke-"));
const files = {
	"knowledge/rubber duck debugging.md": "# Rubber duck debugging\n\nExplain your code line by line, out loud, to a toy. The act of explaining exposes the bug.\n",
	"knowledge/pasta.md": "# Pasta\n\nBoil water, add salt, cook for eight minutes, drain.\n",
	"knowledge/Release Checklist (2026).md": "# Release checklist\n\nTag the build, write the notes, announce it to the team channel.\n",
	"core/activeProjects.md": "# Active Projects\n\n- none\n",
};
for (const [rel, text] of Object.entries(files)) {
	const full = path.join(bank, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, text);
}

const { Refresher, indexNameFor, probe } = await jiti.import(path.join(repo, "semantic.ts"));
const index = indexNameFor(bank);
const indexFiles = () => ["", "-shm", "-wal"].map((suffix) => path.join(os.homedir(), ".cache", "qmd", `${index}.sqlite${suffix}`));
const cleanup = () => { fs.rmSync(bank, { recursive: true, force: true }); for (const f of indexFiles()) fs.rmSync(f, { force: true }); };
let failed = false;
const check = (ok, text) => { console.log(`${ok ? "ok  " : "FAIL"} ${text}`); if (!ok) failed = true; };

try {
	process.env.PI_MEMORY_QMD = qmd;
	const found = await probe(5000);
	if (!found.available) { console.log(`skipped: ${found.reason}`); process.exit(0); }
	console.log(`qmd ${found.version}, temp index ${index}`);

	const harness = await loadHarness(path.join(repo, "index.ts"), bank);
	process.env.PI_MEMORY_QMD = qmd; // loadHarness points measurement scripts at a dead binary; this script wants the real one
	await harness.start({ search: { semantic: "auto", refreshDelayMs: 600000 } });

	const refresher = new Refresher(bank, { debounceMs: 0 });
	const started = Date.now();
	const pass = await refresher.run();
	check(pass.ran === true && refresher.status().lastOk === true, `index built in ${((Date.now() - started) / 1000).toFixed(1)} s${refresher.status().lastError ? ` — ${refresher.status().lastError}` : ""}`);

	// Shares no word with the answer: "stuffed animal", "narrate", "defect" against "toy", "explain", "bug".
	const search = await harness.tools.get("memory_search").execute("smoke", { query: "narrate your program to a stuffed animal to find the defect", limit: 3 });
	const results = search.details.results;
	// What the bank holds now, not what this script wrote: starting a session scaffolds files
	// (`core/dailyContext.md`), and a result for one of those is a result for a real file.
	const bankPaths = new Set();
	const walk = (rel) => {
		for (const entry of fs.readdirSync(path.join(bank, rel), { withFileTypes: true })) {
			const p = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(p);
			else if (p.endsWith(".md")) bankPaths.add(p);
		}
	};
	walk("");
	console.log(search.content[0].text.split("\n").filter((l) => l.includes("Path:")).join("\n"));
	check(search.details.semantic.used === true, `semantic search answered (${search.details.semantic.reason ?? "used"})`);
	check(results[0]?.path === "knowledge/rubber duck debugging.md", "the file with a space in its name came back under its real name, first");
	check(results.every((r) => bankPaths.has(r.path)), `every result is a file the bank really holds (${[...bankPaths].join(", ")})`);
	check(results.some((r) => r.via === "semantic" || r.via === "both"), "at least one result says it was found by meaning");

	// A name qmd rewrites twice over: spaces, brackets and a year.
	const second = await harness.tools.get("memory_search").execute("smoke-2", { query: "how do I ship a version and tell everyone", limit: 3 });
	check(second.details.results.some((r) => r.path === "knowledge/Release Checklist (2026).md"), "a name with spaces and brackets maps back too");

	const status = await jiti.import(path.join(repo, "semantic.ts")).then((m) => m.indexStatus(bank));
	check(status && status.total >= 3 && status.pending === 0, `qmd reports ${status ? `${status.total} files, ${status.pending} without vectors` : "no status"}`);
	await harness.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, harness.ctx);
} catch (error) {
	console.log(`FAIL ${error?.stack ?? error}`);
	failed = true;
} finally {
	cleanup();
}
console.log(failed ? "\nsemantic smoke FAILED" : "\nsemantic smoke passed");
process.exit(failed ? 1 : 0);
