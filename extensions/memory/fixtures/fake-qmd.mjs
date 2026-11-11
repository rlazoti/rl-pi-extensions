// A stand-in for the `qmd` binary, driven by environment variables, so semantic search is tested
// by running real child processes instead of mocking a module (a repo rule: no ESM module mocking).
//
//   FAKE_QMD_LOG      file; every call appends one JSON line {args}
//   FAKE_QMD_MODE     ok (default) | notready | fail | garbage | slow | leak | noversion
//   FAKE_QMD_HITS     JSON array of "qmd://bank/<path>" strings; the search answers them, best first
//   FAKE_QMD_MARKER   with mode=leak: a worker in this process group writes this file 400 ms later,
//                     and its pid goes to `<MARKER>.pid` — so a test can prove the group was killed
//   FAKE_QMD_WORKER_DELAY_MS   with mode=leak: how long the worker waits before writing (default 400)
//   FAKE_QMD_ADD      "exists" makes `collection add` answer "already exists", exit 1 (as real qmd does)
//   FAKE_QMD_EMBED    ok (default) | fail | slow (waits FAKE_QMD_DELAY_MS, default 400)
//   FAKE_QMD_TOTAL / FAKE_QMD_PENDING   numbers `status` prints (pending omitted when 0, as real qmd does)
//
// Shapes copied from qmd 2.8.3 as probed on 2026-11-11: `query "vec: …" --format json` prints an array of
// {docid, score, file, line, title, snippet}; `status` prints "Total: N files indexed" and
// "Pending: N need embedding". The query branch also *checks the shape it was given* — see below.
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_QMD_LOG) appendFileSync(process.env.FAKE_QMD_LOG, JSON.stringify({ args: argv }) + "\n");
const env = (k, d) => process.env[k] ?? d;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rest = [...argv];
let index = "";
for (let i = 0; i < rest.length; i++) if (rest[i] === "--index") { index = rest[i + 1]; rest.splice(i, 2); break; }
const command = rest[0];
const mode = env("FAKE_QMD_MODE", "ok");

if (command === "--version" || command === "-v") {
	if (mode === "noversion") { console.error("unknown flag"); process.exit(2); }
	console.log("qmd 2.5.1");
} else if (command === "query") {
	// The shape this repo measured its way to, checked here so a regression fails loudly instead of
	// quietly calling the expensive form: one typed `vec:` line — single line, no quote characters,
	// because that is what qmd's typed grammar allows — JSON out, and the reranker off.
	const doc = rest[1] ?? "";
	const wellFormed = /^vec: \S/.test(doc) && !/[\r\n"'`]/.test(doc)
		&& rest[rest.indexOf("--format") + 1] === "json" && rest.includes("--no-rerank");
	if (!wellFormed) { console.error(`fake qmd: unexpected query shape: ${JSON.stringify(rest.slice(1))}`); process.exit(65); }
	if (mode === "notready") { console.error("Collection not found: bank"); process.exit(1); }
	if (mode === "fail") { console.error("boom: model failed to load"); process.exit(2); }
	if (mode === "garbage") { console.log("this is not json"); process.exit(0); }
	if (mode === "slow") await sleep(5000);
	if (mode === "leak") {
		// A worker in the same process group that would outlive this process by seconds. A timeout that
		// kills only the direct child leaves it running; the marker file then appears anyway.
		const marker = env("FAKE_QMD_MARKER", "");
		if (marker) {
			const worker = spawn(process.execPath, ["-e", `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "alive"), ${Number(env("FAKE_QMD_WORKER_DELAY_MS", "400"))})`], { stdio: "ignore" });
			writeFileSync(`${marker}.pid`, String(worker.pid));
		}
		await sleep(20000);
	}
	const hits = JSON.parse(env("FAKE_QMD_HITS", "[]"));
	console.log(JSON.stringify(hits.map((file, i) => ({
		docid: `#${i}`, score: Math.round((0.6 - i * 0.05) * 100) / 100, file: `${file}?index=${index}`, line: 1, title: "t", snippet: "s",
	})), null, 2));
} else if (command === "status") {
	const total = Number(env("FAKE_QMD_TOTAL", "0")), pending = Number(env("FAKE_QMD_PENDING", "0"));
	console.log(["QMD Status", "", `Index: /x/${index}.sqlite`, "", "Documents", `  Total:    ${total} files indexed`, `  Vectors:  ${total - pending} embedded`, ...(pending ? [`  Pending:  ${pending} need embedding (run 'qmd embed')`] : [])].join("\n"));
} else if (command === "collection" && rest[1] === "add") {
	if (env("FAKE_QMD_ADD", "") === "exists") { console.error("Collection 'bank' already exists.\nUse a different name with --name <name>"); process.exit(1); }
	console.log("✓ Collection 'bank' created successfully");
} else if (command === "update") {
	console.log("✓ All collections updated.");
} else if (command === "embed") {
	const m = env("FAKE_QMD_EMBED", "ok");
	if (m === "slow") await sleep(Number(env("FAKE_QMD_DELAY_MS", "400")));
	if (m === "fail") { console.error("embed failed: out of memory"); process.exit(3); }
	console.log("✓ Done!");
} else {
	console.error(`fake qmd: unhandled ${argv.join(" ")}`);
	process.exit(64);
}
