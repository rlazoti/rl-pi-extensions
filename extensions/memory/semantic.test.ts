/**
 * Optional semantic search (`qmd vsearch`) with a silent fallback.
 *
 * Nothing here mocks a module. A stand-in `qmd` (fixtures/fake-qmd.mjs) is put on disk behind a
 * tiny shell wrapper, PI_MEMORY_QMD points at it, and the code under test spawns it as a real child
 * process — so the argument list, the timeout, the exit codes and the kill are the real thing.
 * The real binary is never called from tests; scripts/smoke-semantic.mjs does that on demand.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	COLLECTION,
	Refresher,
	indexNameFor,
	indexStatus,
	parseStatus,
	parseVsearch,
	probe,
	qmdSlug,
	semanticSearch,
	slugMap,
} from "./semantic.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-qmd.mjs");

let tmp: string;
let root: string;
let logFile: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["PI_MEMORY_QMD", "FAKE_QMD_LOG", "FAKE_QMD_MODE", "FAKE_QMD_HITS", "FAKE_QMD_ADD", "FAKE_QMD_EMBED", "FAKE_QMD_DELAY_MS", "FAKE_QMD_TOTAL", "FAKE_QMD_PENDING"];

function installFake(): void {
	const wrapper = path.join(tmp, "qmd");
	fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
	process.env.PI_MEMORY_QMD = wrapper;
	process.env.FAKE_QMD_LOG = logFile;
}
const calls = (): string[][] =>
	fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).args) : [];
const verbs = () => calls().map((a) => {
	const rest = a[0] === "--index" ? a.slice(2) : a;
	return rest[0] === "collection" ? "collection " + rest[1] : rest[0];
});
const embeds = () => verbs().filter((v) => v === "embed").length;

/**
 * Wait for a scheduled pass to appear in the call log rather than sleeping a fixed number
 * of milliseconds. The first child process a test process spawns costs 350-480 ms
 * (measured 2026-11-10 with `execFile` inside a vitest fork; later spawns cost 7-143 ms),
 * so a fixed wait comfortable on one machine fails on another — and a fixed wait that
 * expires early passes while asserting about a pass that has not happened yet. Polling the
 * log keeps the assertion about the thing the test is watching, and a timeout says what
 * qmd was actually asked. `handlers.test.ts` waits the same way, which is why its
 * equivalent tests were green while these two were red.
 */
async function until(check: () => boolean, ms = 8000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error(`timed out after ${ms} ms; qmd was called with: ${verbs().join(", ") || "(nothing)"}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

beforeEach(() => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memory-semantic-"));
	root = path.join(tmp, "bank");
	fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
	logFile = path.join(tmp, "calls.log");
	installFake();
});
afterEach(() => {
	for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("qmdSlug: the path qmd gives a file", () => {
	// Every row was observed with qmd 2.5.1 on 2026-11-10: `qmd ls` against a bank holding these names.
	const rows: Array<[string, string]> = [
		["knowledge/plain-name.md", "knowledge/plain-name.md"],
		["knowledge/with space é.md", "knowledge/with-space-é.md"],
		["knowledge/UPPER Case_name.v2.md", "knowledge/UPPER-Case-name-v2.md"],
		["knowledge/Sub Dir/Nested (x) file.md", "knowledge/Sub-Dir/Nested-x-file.md"],
		["knowledge/a--b  c.md", "knowledge/a-b-c.md"],
		["knowledge/ünï côdé.md", "knowledge/ünï-côdé.md"],
		["history/daily/2026-11/2026-11-10-dailyContext.md", "history/daily/2026-11/2026-11-10-dailyContext.md"],
	];
	for (const [rel, slug] of rows) it(`${rel} -> ${slug}`, () => expect(qmdSlug(rel)).toBe(slug));

	it("treats a decomposed and a composed accent as the same file", () => {
		expect(qmdSlug("knowledge/cafe\u0301.md")).toBe(qmdSlug("knowledge/caf\u00e9.md"));
	});
});

describe("slugMap", () => {
	it("maps a slug back to the one file that owns it", () => {
		const map = slugMap(["knowledge/with space.md", "knowledge/plain.md"]);
		expect(map.get("knowledge/with-space.md")).toBe("knowledge/with space.md");
		expect(map.get("knowledge/plain.md")).toBe("knowledge/plain.md");
	});
	it("drops a slug two files share rather than guess which one qmd meant", () => {
		const map = slugMap(["knowledge/a b.md", "knowledge/a-b.md", "knowledge/other.md"]);
		expect(map.has("knowledge/a-b.md")).toBe(false);
		expect(map.get("knowledge/other.md")).toBe("knowledge/other.md");
	});
});

describe("indexNameFor", () => {
	it("is stable for a bank and different for another, so banks never share an index", () => {
		expect(indexNameFor("/a/bank")).toBe(indexNameFor("/a/bank"));
		expect(indexNameFor("/a/bank")).not.toBe(indexNameFor("/b/bank"));
		expect(indexNameFor("/a/bank")).toMatch(/^pi-memory-[0-9a-f]{8}$/);
	});
});

describe("parseVsearch", () => {
	const row = (file: string, score = 0.5) => ({ docid: "#1", score, file: `qmd://bank/${file}?index=x`, line: 1, title: "t", snippet: "s" });
	it("reads the rows, best first, stripping the collection and the index suffix", () => {
		const out = parseVsearch(JSON.stringify([row("knowledge/a.md", 0.6), row("knowledge/b.md", 0.4)]));
		expect(out).toEqual([{ file: "knowledge/a.md", score: 0.6 }, { file: "knowledge/b.md", score: 0.4 }]);
	});
	it("treats an empty array as zero hits, not as a failure", () => expect(parseVsearch("[]")).toEqual([]));
	it("tolerates a warning line before the array", () => {
		expect(parseVsearch(`Warning: 3 documents need embeddings\n${JSON.stringify([row("knowledge/a.md")])}`)).toHaveLength(1);
	});
	it("refuses anything that is not an array of {file, score}", () => {
		for (const bad of ["", "nope", "{}", '{"results":[]}', '[{"file":1,"score":0.5}]', '[{"file":"qmd://bank/a.md"}]', '[{"file":"qmd://bank/a.md","score":"x"}]', "[null]"]) {
			expect(parseVsearch(bad), bad).toBeNull();
		}
	});
	it("refuses a file that is not a qmd:// path in our collection", () => {
		expect(parseVsearch(JSON.stringify([{ docid: "#1", score: 0.5, file: "/etc/passwd", line: 1, title: "", snippet: "" }]))).toBeNull();
		expect(parseVsearch(JSON.stringify([{ docid: "#1", score: 0.5, file: "qmd://other/x.md", line: 1, title: "", snippet: "" }]))).toBeNull();
	});
});

describe("semanticSearch", () => {
	const known = ["knowledge/csv output location.md", "knowledge/branch-naming.md", "core/dailyContext.md"];
	const hits = (...files: string[]) => { process.env.FAKE_QMD_HITS = JSON.stringify(files.map((f) => `qmd://${COLLECTION}/${f}`)); };

	it("runs vsearch against this bank's own index and collection, as JSON, and never the slow `query` mode", async () => {
		hits("knowledge/csv-output-location.md");
		const r = await semanticSearch(root, "where do I save the spreadsheet", 7, 3000, known);
		expect(r).toEqual({ ok: true, hits: [{ path: "knowledge/csv output location.md", score: 0.6 }], dropped: 0 });
		const args = calls().find((a) => a.includes("vsearch"))!;
		expect(args).toEqual(["--index", indexNameFor(root), "vsearch", "where do I save the spreadsheet", "-c", COLLECTION, "-n", "7", "--json"]);
		expect(calls().flat()).not.toContain("query");
	});

	it("maps qmd's slugged names back to the real files and drops what the bank no longer holds", async () => {
		hits("knowledge/csv-output-location.md", "knowledge/deleted-since.md", "knowledge/branch-naming.md");
		const r = await semanticSearch(root, "q", 5, 3000, known);
		expect(r.ok && r.hits.map((h) => h.path)).toEqual(["knowledge/csv output location.md", "knowledge/branch-naming.md"]);
		expect(r.ok && r.dropped).toBe(1);
	});

	it("keeps a query that starts with a dash from being read as a flag", async () => {
		hits("knowledge/branch-naming.md");
		await semanticSearch(root, "--files and more", 5, 3000, known);
		const args = calls().find((a) => a.includes("vsearch"))!;
		expect(args[3]).toBe("files and more");
	});

	it("answers zero hits, without spawning anything, for a query with no words", async () => {
		const r = await semanticSearch(root, "  --  ", 5, 3000, known);
		expect(r).toEqual({ ok: true, hits: [], dropped: 0 });
		expect(calls()).toEqual([]);
	});

	const failures: Array<[string, string, string]> = [
		["notready", "not-ready", "Collection not found"],
		["fail", "failed", "boom"],
		["garbage", "bad-output", "not JSON"],
	];
	for (const [mode, reason, detail] of failures) {
		it(`falls back with reason ${reason} when qmd is in ${mode} mode`, async () => {
			process.env.FAKE_QMD_MODE = mode;
			const r = await semanticSearch(root, "q", 5, 3000, known);
			expect(r.ok).toBe(false);
			if (!r.ok) { expect(r.reason).toBe(reason); expect(r.detail).toContain(detail); }
		});
	}

	it("gives up at the timeout and kills the child, instead of waiting for it", async () => {
		process.env.FAKE_QMD_MODE = "slow";
		const started = Date.now();
		const r = await semanticSearch(root, "q", 5, 300, known);
		expect(Date.now() - started).toBeLessThan(2500);
		expect(r.ok === false && r.reason).toBe("timeout");
	});

	it("reports a missing binary as such", async () => {
		process.env.PI_MEMORY_QMD = path.join(tmp, "no-such-qmd");
		const r = await semanticSearch(root, "q", 5, 3000, known);
		expect(r.ok === false && r.reason).toBe("missing");
	});
});

describe("probe and indexStatus", () => {
	it("reads the version", async () => expect(await probe()).toEqual({ available: true, version: "2.5.1" }));
	it("says why qmd is not usable", async () => {
		process.env.PI_MEMORY_QMD = path.join(tmp, "no-such-qmd");
		const p = await probe();
		expect(p.available).toBe(false);
		expect(p.reason).toContain("not found");
	});
	it("parses the document counts, with no Pending line meaning nothing is pending", () => {
		expect(parseStatus("Documents\n  Total:    402 files indexed\n  Vectors:  402 embedded\n")).toEqual({ total: 402, vectors: 402, pending: 0 });
		expect(parseStatus("  Total:    10 files indexed\n  Vectors:  4 embedded\n  Pending:  6 need embedding (run 'qmd embed')")).toEqual({ total: 10, vectors: 4, pending: 6 });
		expect(parseStatus("something else entirely")).toBeNull();
	});
	it("reads the counts for this bank's index from qmd", async () => {
		process.env.FAKE_QMD_TOTAL = "12"; process.env.FAKE_QMD_PENDING = "5";
		expect(await indexStatus(root)).toEqual({ total: 12, vectors: 7, pending: 5 });
		expect(calls().find((a) => a.includes("status"))![1]).toBe(indexNameFor(root));
	});
});

describe("Refresher", () => {
	let refresher: Refresher;
	afterEach(() => refresher?.dispose());
	const lockPath = () => path.join(root, ".write-locks", "semantic-refresh.lock");

	it("sets up the collection, updates, then embeds — in that order, against this bank's index", async () => {
		refresher = new Refresher(root, { debounceMs: 10 });
		const r = await refresher.run();
		expect(r).toEqual({ ran: true });
		expect(verbs()).toEqual(["--version", "collection add", "update", "embed"]);
		const add = calls().find((a) => a.includes("collection"))!;
		expect(add).toEqual(["--index", indexNameFor(root), "collection", "add", root, "--name", COLLECTION, "--mask", "**/*.md"]);
		expect(refresher.status().lastOk).toBe(true);
	});

	it("treats 'collection already exists' as success, so every later pass is just update and embed", async () => {
		process.env.FAKE_QMD_ADD = "exists";
		refresher = new Refresher(root, { debounceMs: 10 });
		expect(await refresher.run()).toEqual({ ran: true });
		expect(verbs()).toEqual(["--version", "collection add", "update", "embed"]);
		expect(refresher.status().lastOk).toBe(true);
	});

	it("collapses a burst of schedule() calls into one pass", async () => {
		refresher = new Refresher(root, { debounceMs: 60 });
		for (let i = 0; i < 6; i++) refresher.schedule();
		await until(() => embeds() === 1 && !refresher.status().running);
		// One pass's four calls and nothing queued behind them, checked after a quiet stretch
		// far longer than the debounce. Counting `embed` alone would miss a second pass that a
		// burst had queued: it is still on its first call when the first pass's `embed` lands.
		await new Promise((r) => setTimeout(r, 400));
		expect(verbs()).toEqual(["--version", "collection add", "update", "embed"]);
	});

	it("runs one pass at a time, and remembers that a write landed meanwhile", async () => {
		process.env.FAKE_QMD_EMBED = "slow"; process.env.FAKE_QMD_DELAY_MS = "300";
		refresher = new Refresher(root, { debounceMs: 20 });
		const first = refresher.run();
		await new Promise((r) => setTimeout(r, 100));
		expect(await refresher.run()).toEqual({ ran: false, skipped: "running" });
		await first;
		// The skipped request was not lost: one follow-up pass ran after the first finished.
		await until(() => embeds() === 2);
		expect(embeds()).toBe(2);
	});

	it("does not start while another live process holds the lock", async () => {
		fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
		fs.writeFileSync(lockPath(), `${process.pid}\n${Date.now()}\n`);
		refresher = new Refresher(root, { debounceMs: 10 });
		expect(await refresher.run()).toEqual({ ran: false, skipped: "locked-elsewhere" });
		// It asked whether qmd exists (so a machine without it leaves no lock file), then stopped.
		expect(verbs()).toEqual(["--version"]);
		expect(fs.existsSync(lockPath())).toBe(true);
	});

	it("takes over a lock whose process is gone, and releases its own afterwards", async () => {
		fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
		fs.writeFileSync(lockPath(), `2147483646\n${Date.now()}\n`);
		refresher = new Refresher(root, { debounceMs: 10 });
		expect(await refresher.run()).toEqual({ ran: true });
		expect(fs.existsSync(lockPath())).toBe(false);
	});

	it("takes over a lock that is older than any real pass", async () => {
		fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
		fs.writeFileSync(lockPath(), `${process.pid}\n${Date.now() - 3 * 60 * 60 * 1000}\n`);
		refresher = new Refresher(root, { debounceMs: 10 });
		expect(await refresher.run()).toEqual({ ran: true });
	});

	it("records a failed embed instead of throwing, and releases the lock", async () => {
		process.env.FAKE_QMD_EMBED = "fail";
		refresher = new Refresher(root, { debounceMs: 10 });
		const r = await refresher.run();
		expect(r.ran).toBe(true);
		expect(refresher.status().lastOk).toBe(false);
		expect(refresher.status().lastError).toContain("embed");
		expect(fs.existsSync(lockPath())).toBe(false);
	});

	it("does nothing, and says why, when qmd is not installed, leaving no lock file behind", async () => {
		process.env.PI_MEMORY_QMD = path.join(tmp, "no-such-qmd");
		refresher = new Refresher(root, { debounceMs: 10 });
		expect(await refresher.run()).toEqual({ ran: false, skipped: "unavailable" });
		expect(refresher.status().lastError).toContain("not found");
		expect(fs.existsSync(path.join(root, ".write-locks"))).toBe(false);
	});

	it("skips a pass that was scheduled and then switched off", async () => {
		let on = true;
		refresher = new Refresher(root, { debounceMs: 30, enabled: () => on });
		refresher.schedule();
		on = false;
		await new Promise((r) => setTimeout(r, 300));
		expect(calls()).toEqual([]);
	});

	it("reads a debounce given as a function each time it schedules", async () => {
		// The first value is a ten-minute wait, so honouring it means no pass ever arrives: the
		// pass appearing at all is the proof that the function was read again at schedule().
		let delay = 600_000;
		refresher = new Refresher(root, { debounceMs: () => delay });
		refresher.schedule();
		delay = 20;
		refresher.schedule();
		await until(() => embeds() === 1);
	});

	it("dispose cancels a pending pass and stops a running one", async () => {
		refresher = new Refresher(root, { debounceMs: 80 });
		refresher.schedule();
		refresher.dispose();
		await new Promise((r) => setTimeout(r, 300));
		expect(calls()).toEqual([]);

		process.env.FAKE_QMD_EMBED = "slow"; process.env.FAKE_QMD_DELAY_MS = "3000";
		const second = new Refresher(root, { debounceMs: 10 });
		const running = second.run();
		await new Promise((r) => setTimeout(r, 200));
		second.dispose();
		const started = Date.now();
		await running;
		expect(Date.now() - started).toBeLessThan(2000);
		expect(fs.existsSync(lockPath())).toBe(false);
	});
});
