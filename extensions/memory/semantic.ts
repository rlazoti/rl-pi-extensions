/**
 * Optional semantic search: `qmd vsearch` behind `memory_search`, with a silent fallback.
 *
 * What was measured before this was written (2026-11-10, a live bank of 402 files, 15 prompts of
 * which 9 avoid the target file's own words; labels by the agent, so a direction, not a benchmark):
 *
 *   correct file in the top 3    MiniSearch 8 of 15 · qmd vsearch (fresh index) 13 · qmd query 12
 *   latency per call             vsearch ~0.7 s · query 10-16 s (it loads an expansion and a rerank model each call)
 *   re-embedding a whole bank    51 s
 *
 * Hence the decisions this file carries out:
 *
 *   - `vsearch`, never `query`. Reranking was not better and costs 15x the time.
 *   - Async child processes with a timeout. The extension this was modelled on blocks Pi for up
 *     to 30 s per call (`execFileSync`); here a slow qmd costs the search its semantic half, not the session.
 *   - Its own index, named after the bank (`pi-memory-<hash of the bank root>`). A shared index goes
 *     stale: the one on the author's machine was last embedded six weeks before this was written,
 *     with 38% of the knowledge files missing vectors, because nothing ever re-embedded.
 *   - The extension keeps that index fresh itself (`Refresher`): debounced after writes, single
 *     flight, and safe across Pi sessions sharing a bank.
 *   - Never an error for the agent. Missing binary, timeout, bad output: the search answers from
 *     keywords alone. The reason is kept for `/memory doctor`.
 *
 * Injection never imports this file. Vector search has no relevance floor, so it is only used where
 * a person asked a question and the answer is labelled with where it came from.
 *
 * Nothing here is mocked in tests: PI_MEMORY_QMD names the binary, and the tests point it at a
 * stand-in (fixtures/fake-qmd.mjs) that real child processes spawn.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface SearchConfig {
	/** `auto`: use qmd when it is installed and answers in time. `off`: keywords only. */
	semantic: "off" | "auto";
	/** How long a search waits for qmd before answering from keywords alone. */
	semanticTimeoutMs: number;
	/** After a write (or a session start), wait this long before refreshing the index, so a burst becomes one pass. */
	refreshDelayMs: number;
}
/**
 * 8 s, not the 3 s first guessed. Measured with qmd 2.5.1 (2026-11-10, machine load average ~4): warm, a call takes
 * 0.8-1.3 s. After a pause, the first calls are erratic: 15, 3, 4, 3 and 13 s in one run, 3.6, 3.3, 14.5, 14.9 and
 * 2.9 s in another, then 0.8 s again. A search tool is called every few minutes, so many calls land in that stretch.
 * 8 s keeps the stall bounded and answers from keywords when qmd is slower; `search.semanticTimeoutMs 20000` waits
 * out the worst case seen, which is also about what the extension this replaced blocked for on every slow call.
 */
export const DEFAULT_SEARCH: SearchConfig = { semantic: "auto", semanticTimeoutMs: 8000, refreshDelayMs: 30_000 };

/** The one collection qmd holds for a bank, inside that bank's own index. */
export const COLLECTION = "bank";

/** The binary to run. PI_MEMORY_QMD overrides it (tests, and installs outside PATH). */
export function qmdBinary(): string {
	return process.env.PI_MEMORY_QMD || "qmd";
}

/** One index per bank, so a second bank, a test bank or a moved bank never shares vectors with this one. */
export function indexNameFor(root: string): string {
	let resolved = path.resolve(root);
	try { resolved = fs.realpathSync(resolved); } catch { /* a bank that does not exist yet still gets a stable name */ }
	return `pi-memory-${createHash("sha256").update(resolved).digest("hex").slice(0, 8)}`;
}

const slugSegment = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");

/**
 * The path qmd files a document under. qmd rewrites every run of non-letter, non-digit characters
 * in each path segment to one hyphen (and the stem's dots too, keeping `.md`), so `with space é.md`
 * is `with-space-é.md`. Checked against `qmd ls` for the names in semantic.test.ts and for all 402
 * files of a live bank. Needed to turn qmd's answers back into files this bank knows.
 */
export function qmdSlug(rel: string): string {
	const segments = rel.normalize("NFC").split("/");
	return segments
		.map((segment, i) => (i < segments.length - 1 ? slugSegment(segment) : `${slugSegment(segment.replace(/\.md$/i, ""))}.md`))
		.join("/");
}

/** slug -> real path. A slug two files share is dropped: guessing which one qmd meant would cite the wrong file. */
export function slugMap(paths: string[]): Map<string, string> {
	const map = new Map<string, string>();
	const clashes = new Set<string>();
	for (const p of paths) {
		const slug = qmdSlug(p);
		if (map.has(slug) && map.get(slug) !== p) clashes.add(slug);
		else map.set(slug, p);
	}
	for (const slug of clashes) map.delete(slug);
	return map;
}

// ── Running qmd ───────────────────────────────────────────────────────

type RunResult =
	| { kind: "exit"; code: number; stdout: string; stderr: string }
	| { kind: "missing" }
	| { kind: "timeout" }
	| { kind: "aborted" };

function runQmd(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve({ kind: "aborted" });
		try {
			execFile(
				qmdBinary(),
				args,
				{ timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, signal, env: { ...process.env, NO_COLOR: "1" } },
				(error, stdout, stderr) => {
					if (!error) return resolve({ kind: "exit", code: 0, stdout: String(stdout), stderr: String(stderr) });
					const e = error as unknown as { code?: number | string; killed?: boolean; name?: string };
					if (e.code === "ENOENT" || e.code === "EACCES") return resolve({ kind: "missing" });
					if (e.name === "AbortError") return resolve({ kind: "aborted" });
					if (e.killed) return resolve({ kind: "timeout" });
					resolve({ kind: "exit", code: typeof e.code === "number" ? e.code : 1, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
				},
			);
		} catch {
			resolve({ kind: "missing" });
		}
	});
}

const firstLine = (text: string): string => text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

// ── Probe and status ──────────────────────────────────────────────────

export interface QmdProbe { available: boolean; version?: string; reason?: string }

export async function probe(timeoutMs = 3000, signal?: AbortSignal): Promise<QmdProbe> {
	const r = await runQmd(["--version"], timeoutMs, signal);
	if (r.kind === "missing") return { available: false, reason: `qmd not found (${qmdBinary()})` };
	if (r.kind === "timeout") return { available: false, reason: "qmd --version timed out" };
	if (r.kind === "aborted") return { available: false, reason: "cancelled" };
	if (r.code !== 0) return { available: false, reason: `qmd --version failed: ${firstLine(r.stderr || r.stdout)}` };
	const version = (r.stdout + r.stderr).match(/(\d+\.\d+\.\d+)/)?.[1];
	return version ? { available: true, version } : { available: true };
}

export interface IndexStatus { total: number; vectors: number; pending: number }

/** `qmd status` prints no Pending line when nothing is pending, so absence is zero once Total parsed. */
export function parseStatus(text: string): IndexStatus | null {
	const total = text.match(/Total:\s+(\d+)\s+files? indexed/i);
	if (!total) return null;
	const vectors = text.match(/Vectors:\s+(\d+)\s+embedded/i);
	const pending = text.match(/Pending:\s+(\d+)\s+need embedding/i);
	return { total: Number(total[1]), vectors: vectors ? Number(vectors[1]) : 0, pending: pending ? Number(pending[1]) : 0 };
}

export async function indexStatus(root: string, timeoutMs = 5000): Promise<IndexStatus | null> {
	const r = await runQmd(["--index", indexNameFor(root), "status"], timeoutMs);
	return r.kind === "exit" && r.code === 0 ? parseStatus(r.stdout) : null;
}

// ── Searching ─────────────────────────────────────────────────────────

export interface RawHit { file: string; score: number }

/**
 * Strict on purpose: a format change in qmd must read as "bad output" and fall back to keywords,
 * not as a half-parsed answer. A leading warning line (qmd prints one while vectors are missing)
 * is tolerated; the array itself must be complete.
 */
export function parseVsearch(stdout: string): RawHit[] | null {
	const text = stdout.trim();
	let value: unknown;
	try { value = JSON.parse(text); }
	catch {
		const at = text.indexOf("\n[");
		if (at < 0) return null;
		try { value = JSON.parse(text.slice(at + 1)); } catch { return null; }
	}
	if (!Array.isArray(value)) return null;
	const prefix = `qmd://${COLLECTION}/`;
	const hits: RawHit[] = [];
	for (const row of value) {
		if (!row || typeof row !== "object") return null;
		const { file, score } = row as { file?: unknown; score?: unknown };
		if (typeof file !== "string" || typeof score !== "number" || !Number.isFinite(score)) return null;
		if (!file.startsWith(prefix)) return null;
		const rest = file.slice(prefix.length);
		const q = rest.indexOf("?");
		hits.push({ file: q < 0 ? rest : rest.slice(0, q), score });
	}
	return hits;
}

export type SemanticOutcome =
	| { ok: true; hits: Array<{ path: string; score: number }>; dropped: number }
	| { ok: false; reason: "missing" | "timeout" | "not-ready" | "failed" | "bad-output"; detail: string };

/**
 * Ask qmd which files mean what the query means. `knownPaths` is what the keyword index holds: a
 * hit is kept only if it maps to one of those, so semantic results obey the same eligibility as
 * keyword results (no internal files, no files below the index depth, nothing deleted since).
 */
export async function semanticSearch(
	root: string,
	query: string,
	limit: number,
	timeoutMs: number,
	knownPaths: string[],
): Promise<SemanticOutcome> {
	// A query that begins with "-" would be read as a flag. Words are what carry meaning, not the dashes.
	const cleaned = query.replace(/^[-\s]+/, "").trim();
	if (!cleaned) return { ok: true, hits: [], dropped: 0 };
	const r = await runQmd(
		["--index", indexNameFor(root), "vsearch", cleaned, "-c", COLLECTION, "-n", String(Math.max(1, Math.floor(limit))), "--json"],
		timeoutMs,
	);
	if (r.kind === "missing") return { ok: false, reason: "missing", detail: `qmd not found (${qmdBinary()})` };
	if (r.kind === "timeout") return { ok: false, reason: "timeout", detail: `no answer within ${timeoutMs} ms` };
	if (r.kind === "aborted") return { ok: false, reason: "failed", detail: "cancelled" };
	if (r.code !== 0) {
		const said = firstLine(r.stderr || r.stdout);
		// No collection means this bank has not been indexed yet; the refresher builds it.
		if (/collection not found/i.test(r.stderr + r.stdout)) return { ok: false, reason: "not-ready", detail: said };
		return { ok: false, reason: "failed", detail: said || `exit ${r.code}` };
	}
	const raw = parseVsearch(r.stdout);
	if (!raw) return { ok: false, reason: "bad-output", detail: `not JSON of the expected shape: ${firstLine(r.stdout).slice(0, 80)}` };
	const map = slugMap(knownPaths);
	const hits: Array<{ path: string; score: number }> = [];
	const seen = new Set<string>();
	let dropped = 0;
	for (const hit of raw) {
		const real = map.get(hit.file.normalize("NFC"));
		if (!real) { dropped++; continue; }
		if (seen.has(real)) continue;
		seen.add(real);
		hits.push({ path: real, score: hit.score });
	}
	return { ok: true, hits, dropped };
}

// ── Keeping the index fresh ───────────────────────────────────────────

export interface RefreshStatus {
	running: boolean;
	passes: number;
	lastStartedAt?: number;
	lastFinishedAt?: number;
	lastOk?: boolean;
	lastError?: string;
}

export type RefreshResult =
	| { ran: true }
	| { ran: false; skipped: "running" | "locked-elsewhere" | "unavailable" | "disposed" };

export interface RefresherOptions {
	/** Wait this long after the last write before refreshing (a function is read each time, so a changed setting applies). Default 30 s. */
	debounceMs?: number | (() => number);
	/** Asked when a scheduled pass is due. A pass that was scheduled and then switched off (search.semantic off) is skipped. */
	enabled?: () => boolean;
}

/** A pass that outlives this is not alive: the lock is taken over. A whole bank embeds in ~1 minute. */
const LOCK_MAX_AGE_MS = 30 * 60 * 1000;
const STEP_TIMEOUT_MS = { add: 30_000, update: 120_000, embed: 15 * 60_000 } as const;

function pidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Brings a bank's qmd index up to date: collection, `update`, `embed`. One pass at a time in this
 * process (a write during a pass schedules one follow-up), one at a time across processes (a lock
 * file naming its owner, taken over when the owner is gone or the file is older than any real pass).
 * A failure is recorded, never thrown: the session must not notice.
 */
export class Refresher {
	private readonly root: string;
	private readonly debounceMs: number | (() => number);
	private readonly enabled: () => boolean;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private abort = new AbortController();
	private running = false;
	private again = false;
	private disposed = false;
	private state: RefreshStatus = { running: false, passes: 0 };

	constructor(root: string, options: RefresherOptions = {}) {
		this.root = root;
		this.debounceMs = options.debounceMs ?? 30_000;
		this.enabled = options.enabled ?? (() => true);
	}

	status(): RefreshStatus {
		return { ...this.state, running: this.running };
	}

	/** A write happened: refresh once things settle. Calls inside the window collapse into one pass. */
	schedule(): void {
		if (this.disposed) return;
		if (this.timer) clearTimeout(this.timer);
		const wait = typeof this.debounceMs === "function" ? this.debounceMs() : this.debounceMs;
		this.timer = setTimeout(() => { this.timer = null; if (this.enabled()) void this.run(); }, Math.max(0, wait));
		this.timer.unref?.();
	}

	/** Refresh soon, without the settle window (the index does not exist yet, or a session just began). */
	kick(): void {
		if (this.disposed) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => { this.timer = null; if (this.enabled()) void this.run(); }, 0);
		this.timer.unref?.();
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.abort.abort();
	}

	private lockPath(): string {
		return path.join(this.root, ".write-locks", "semantic-refresh.lock");
	}

	private takeLock(): boolean {
		const file = this.lockPath();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const fd = fs.openSync(file, "wx");
				try { fs.writeSync(fd, `${process.pid}\n${Date.now()}\n`); } finally { fs.closeSync(fd); }
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				let owner = 0, at = 0;
				try {
					const [pid, ts] = fs.readFileSync(file, "utf8").split("\n");
					owner = Number(pid); at = Number(ts);
				} catch { /* unreadable: treated as abandoned below */ }
				const abandoned = !Number.isFinite(owner) || owner <= 0 || !pidAlive(owner) || !Number.isFinite(at) || Date.now() - at > LOCK_MAX_AGE_MS;
				if (!abandoned) return false;
				try { fs.unlinkSync(file); } catch { /* another process took it over first; the next attempt sees theirs */ }
			}
		}
		return false;
	}

	private dropLock(): void {
		try { fs.unlinkSync(this.lockPath()); } catch { /* already gone */ }
	}

	/** One pass. Exposed for tests; the extension uses schedule() and kick(). */
	async run(): Promise<RefreshResult> {
		if (this.disposed) return { ran: false, skipped: "disposed" };
		if (this.running) { this.again = true; return { ran: false, skipped: "running" }; }
		this.running = true;
		let finished: RefreshResult = { ran: true };
		try {
			// Ask whether qmd exists before touching the bank: a machine without it should leave no lock file behind.
			const probed = await probe(3000, this.abort.signal);
			if (!probed.available) {
				this.fail(probed.reason ?? "qmd is not available");
				return { ran: false, skipped: "unavailable" };
			}
			let locked = false;
			try { locked = this.takeLock(); }
			catch (error) { this.fail(`could not take the refresh lock: ${(error as Error).message}`); return { ran: false, skipped: "unavailable" }; }
			if (!locked) return { ran: false, skipped: "locked-elsewhere" };
			try {
				this.state = { ...this.state, lastStartedAt: Date.now() };
				const index = indexNameFor(this.root);
				const add = await runQmd(["--index", index, "collection", "add", this.root, "--name", COLLECTION, "--mask", "**/*.md"], STEP_TIMEOUT_MS.add, this.abort.signal);
				// Re-adding is how a pass learns the collection exists: qmd answers "already exists" and exits 1.
				if (!(add.kind === "exit" && (add.code === 0 || /already exists/i.test(add.stdout + add.stderr)))) {
					this.fail(`collection add ${describeRun(add)}`);
					return finished;
				}
				const update = await runQmd(["--index", index, "update"], STEP_TIMEOUT_MS.update, this.abort.signal);
				if (!(update.kind === "exit" && update.code === 0)) { this.fail(`update ${describeRun(update)}`); return finished; }
				const embed = await runQmd(["--index", index, "embed"], STEP_TIMEOUT_MS.embed, this.abort.signal);
				if (!(embed.kind === "exit" && embed.code === 0)) { this.fail(`embed ${describeRun(embed)}`); return finished; }
				this.state = { ...this.state, passes: this.state.passes + 1, lastFinishedAt: Date.now(), lastOk: true, lastError: undefined };
				return finished;
			} finally {
				this.dropLock();
			}
		} finally {
			this.running = false;
			if (this.again && !this.disposed) { this.again = false; this.schedule(); }
		}
	}

	private fail(message: string): void {
		this.state = { ...this.state, passes: this.state.passes + 1, lastFinishedAt: Date.now(), lastOk: false, lastError: message };
	}
}

function describeRun(r: RunResult): string {
	if (r.kind === "missing") return "failed: qmd not found";
	if (r.kind === "timeout") return "timed out";
	if (r.kind === "aborted") return "cancelled";
	return `failed (exit ${r.code}): ${firstLine(r.stderr || r.stdout).slice(0, 120)}`;
}
