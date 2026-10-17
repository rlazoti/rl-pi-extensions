/**
 * The bank on disk: where things live, how they are written so a crash cannot
 * half-write them, and what counts as damage.
 *
 * Layout (the spec's bank layout):
 *
 *     claims/rules/*.md, claims/facts/*.md   approved + pending claims
 *     history/                               superseded, rejected and replaced claims
 *     daily/today.md, daily/archive/YYYY-MM/ the daily log
 *     archive/                               read-only migrated prose and status text
 *     migration/state.json                   resumable migration progress
 *     metrics/                               trial metrics
 *     config.json
 *
 * Two rules from the repo's own history are load-bearing here:
 *
 *  - A derived filename is a slot, not an identity. `storeFileFor` names a file
 *    after the claim's namespace, but if that slot is held by a different
 *    namespace the claim takes the next free slot beside it instead of
 *    overwriting or blocking. (A name collision once made a live file
 *    permanently unwritable.)
 *  - Nothing is deleted. Supersession, rejection and replacement all move the
 *    old bytes to `history/`; migration moves source text to `archive/`.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";

import { identityOf, parseStore, renderStore, type Claim, type EntryError, type ParsedEntry, type ParsedStore } from "./grammar.js";
import { unrootedPathScopes } from "./scope.js";

export interface BankPaths {
	root: string;
	claims: string;
	rules: string;
	facts: string;
	history: string;
	daily: string;
	dailyArchive: string;
	archive: string;
	migration: string;
	metrics: string;
	config: string;
	/** Where backups go: outside the bank, so a backup is not backing itself up. */
	backups: string;
}

export function bankPaths(root?: string): BankPaths {
	const base = root ?? process.env.PI_MEMORY_DIR ?? join(homedir(), ".pi", "memory");
	const abs = canonical(base);
	return {
		root: abs,
		claims: join(abs, "claims"),
		rules: join(abs, "claims", "rules"),
		facts: join(abs, "claims", "facts"),
		history: join(abs, "history"),
		daily: join(abs, "daily"),
		dailyArchive: join(abs, "daily", "archive"),
		archive: join(abs, "archive"),
		migration: join(abs, "migration"),
		metrics: join(abs, "metrics"),
		config: join(abs, "config.json"),
		backups: resolve(join(abs, ".."), "backups"),
	};
}

export function ensureBankDirs(paths: BankPaths): void {
	for (const dir of [paths.root, paths.claims, paths.rules, paths.facts, paths.history, paths.daily, paths.dailyArchive, paths.archive, paths.migration, paths.metrics]) {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	}
}

// ── Reading ────────────────────────────────────────────────────────────────

export interface BankSnapshot {
	/** Every entry the store holds, with its file and line — the injector filters. */
	entries: ParsedEntry[];
	claims: Claim[];
	stores: ParsedStore[];
	errors: EntryError[];
	unreadable: { file: string; error: string }[];
	/** `*.tmp-*` siblings: a crash mid-write, never silently ignored. */
	tempFiles: string[];
	/** Symlinks that leave the bank, and why they were not read. */
	outsideLinks: { file: string; reason: string }[];
}

export const EMPTY_SNAPSHOT: BankSnapshot = { entries: [], claims: [], stores: [], errors: [], unreadable: [], tempFiles: [], outsideLinks: [] };

/**
 * Markdown files in a directory tree, skipping temp siblings and dotfiles.
 *
 * Two things about links matter here. A symlink that points outside the bank is
 * skipped and reported: a link out of the bank must not be read as if it were
 * inside, which is how an unrelated file turns into injected memory. A link that
 * points at a file already read is read once, because two paths to one file must
 * not look like two claims on one identity. Only real directories are walked,
 * so a link cycle cannot loop the walk.
 */
export function markdownFiles(dir: string, root?: string, skipped?: { file: string; reason: string }[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	walk(dir);
	return out;

	function walk(current: string): void {
		let names: string[];
		try {
			names = readdirSync(current);
		} catch {
			return;
		}
		for (const name of names.sort()) {
			if (name.startsWith(".")) continue;
			const full = join(current, name);
			const stat = lstatSyncOrNull(full);
			if (!stat) continue;
			if (stat.isDirectory()) {
				walk(full);
				continue;
			}
			if (isTempSibling(name) || !name.endsWith(".md")) continue;
			if (stat.isSymbolicLink()) {
				const target = realpathOrNull(full);
				if (target === undefined) {
					skipped?.push({ file: full, reason: "a symlink with nothing behind it" });
					continue;
				}
				if (root !== undefined && !isWithin(canonical(root), target)) {
					skipped?.push({ file: full, reason: `a symlink out of the bank to ${target}` });
					continue;
				}
				if (seen.has(target)) continue;
				seen.add(target);
			} else {
				const own = canonical(full);
				if (seen.has(own)) continue;
				seen.add(own);
			}
			out.push(full);
		}
	}
}

export function isTempSibling(name: string): boolean {
	return /\.tmp-\d+/.test(name);
}

function realpathOrNull(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/**
 * A path with every link resolved, for comparison only. On macOS a temp path is
 * `/var/folders/…` but resolves to `/private/var/…`: comparing an unresolved
 * root against a resolved target makes a file inside the bank look outside it.
 */
export function canonical(path: string): string {
	return realpathOrNull(path) ?? resolve(path);
}

/** Is `child` at or below `parent`, both absolute? */
export function isWithin(parent: string, child: string): boolean {
	if (parent === child) return true;
	return child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function lstatSyncOrNull(path: string) {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

/**
 * Read the claim stores. A file that cannot be read or parsed is reported, never
 * guessed at: the turn proceeds with what is readable (R30).
 */
export function readClaims(paths: BankPaths): BankSnapshot {
	const snapshot: BankSnapshot = { entries: [], claims: [], stores: [], errors: [], unreadable: [], tempFiles: [], outsideLinks: [] };
	for (const dir of [paths.rules, paths.facts]) {
		for (const file of markdownFiles(dir, paths.root, snapshot.outsideLinks)) {
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch (error) {
				snapshot.unreadable.push({ file, error: errorMessage(error) });
				continue;
			}
			const parsed = parseStore(text, file);
			snapshot.stores.push(parsed);
			snapshot.entries.push(...parsed.entries);
			snapshot.claims.push(...parsed.entries.map((entry) => entry.claim));
			snapshot.errors.push(...parsed.errors);
		}
	}
	for (const dir of [paths.rules, paths.facts, paths.claims]) {
		for (const name of listNames(dir)) if (isTempSibling(name)) snapshot.tempFiles.push(join(dir, name));
	}
	return snapshot;
}

function listNames(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Read a history or archive tree as entries, for search and read only (D12). */
export function readEntryFiles(files: string[]): { claims: Claim[]; errors: EntryError[] } {
	const claims: Claim[] = [];
	const errors: EntryError[] = [];
	for (const file of files) {
		try {
			const parsed = parseStore(readFileSync(file, "utf8"), file);
			claims.push(...parsed.entries.map((entry) => entry.claim));
			errors.push(...parsed.errors);
		} catch (error) {
			errors.push({ file, line: 0, message: `unreadable: ${errorMessage(error)}` });
		}
	}
	return { claims, errors };
}

// ── Writing ────────────────────────────────────────────────────────────────

/**
 * Write through a sibling temp file and rename. A crash leaves a `.tmp-<pid>`
 * sibling, which `inspect` reports rather than hides.
 */
export function writeAtomic(file: string, text: string): void {
	if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, text, "utf8");
	renameSync(tmp, file);
}

export function readFileOrNull(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/** The directory a claim of this kind belongs in. */
export function kindDir(paths: BankPaths, kind: Claim["kind"]): string {
	return kind === "rule" ? paths.rules : paths.facts;
}

/** The namespace a claim's file is named after: its first key segment. */
export function namespaceOf(key: string): string {
	return key.includes(".") ? key.split(".")[0]! : key;
}

/**
 * The record a claim is: identity plus state. One identity may hold one approved
 * and one pending claim (R11), so writing a pending claim must never be read as
 * replacing the approved one — only a record with the same state may be replaced.
 */
export function recordOf(claim: Claim): string {
	return `${claim.key}\u0000${claim.scope}\u0000${claim.state}`;
}

/**
 * The store file a claim belongs in, in this order:
 *
 *  1. the file that already holds this identity — an identity always resolves to
 *     the same file, however the bank is otherwise arranged, or a second write
 *     would create the very rival claim the store is meant to prevent;
 *  2. a file that already holds this claim's namespace, so one namespace stays
 *     in one file and a hand-written preamble stays meaningful;
 *  3. the name derived from the namespace, walking to the next free slot beside
 *     it when the slot is held by other namespaces. A derived filename is a
 *     slot, not an identity: it never overwrites what is already there.
 */
export function storeFileFor(paths: BankPaths, claim: Claim): { file: string; slot: number } {
	const dir = kindDir(paths, claim.kind);
	const namespace = namespaceOf(claim.key);
	const stores: ParsedStore[] = [];
	for (const file of markdownFiles(dir, paths.root)) {
		const text = readFileOrNull(file);
		if (text === undefined) continue;
		stores.push(parseStore(text, file));
	}
	for (const store of stores) {
		if (store.entries.some((entry) => recordOf(entry.claim) === recordOf(claim))) {
			return { file: store.file, slot: slotOf(store.file, namespace) };
		}
	}
	// The same identity in the other state: keep an approved claim and the
	// proposal waiting against it in one file, so a hand edit sees them together.
	for (const store of stores) {
		if (store.entries.some((entry) => identityOf(entry.claim) === identityOf(claim))) {
			return { file: store.file, slot: slotOf(store.file, namespace) };
		}
	}
	for (const store of stores) {
		if (store.entries.some((entry) => namespaceOf(entry.claim.key) === namespace)) {
			return { file: store.file, slot: slotOf(store.file, namespace) };
		}
	}
	for (let slot = 1; slot < 100; slot++) {
		const file = join(dir, slot === 1 ? `${namespace}.md` : `${namespace}-${slot}.md`);
		if (!existsSync(file)) return { file, slot };
	}
	throw new Error(`no free slot for "${namespace}" in ${dir} after 99 tries`);
}

function slotOf(file: string, namespace: string): number {
	const base = basename(file, ".md");
	if (base.startsWith(`${namespace}-`)) {
		const suffix = Number(base.slice(namespace.length + 1));
		if (Number.isInteger(suffix) && suffix > 1) return suffix;
	}
	return 1;
}

/**
 * Put a claim in its store file, replacing the claim with the same identity if
 * there is one. Returns the file written and what happened to the previous
 * occupant of that identity.
 */
export function upsertClaim(paths: BankPaths, claim: Claim): { file: string; replaced: boolean } {
	const { file } = storeFileFor(paths, claim);
	const existingText = readFileOrNull(file);
	const parsed = existingText === undefined ? undefined : parseStore(existingText, file);
	const preamble = parsed?.preamble ?? defaultPreamble(claim);
	const entries: Claim[] = (parsed?.entries ?? []).map((entry) => entry.claim);
	const previous = entries.findIndex((entry) => recordOf(entry) === recordOf(claim));
	if (previous >= 0) entries[previous] = claim;
	else entries.push(claim);
	writeAtomic(file, renderStore(preamble, entries));
	return { file, replaced: previous >= 0 };
}

export function defaultPreamble(claim: Claim): string {
	return `# ${claim.kind} claims about ${namespaceOf(claim.key)}`;
}

/** Remove one claim (by identity) from its store file. Returns false when absent. */
export function removeClaim(paths: BankPaths, claim: Claim): boolean {
	const { file } = storeFileFor(paths, claim);
	const text = readFileOrNull(file);
	if (text === undefined) return false;
	const parsed = parseStore(text, file);
	const kept = parsed.entries.map((entry) => entry.claim).filter((entry) => recordOf(entry) !== recordOf(claim));
	if (kept.length === parsed.entries.length) return false;
	writeAtomic(file, renderStore(parsed.preamble, kept));
	return true;
}

/**
 * Move a claim's bytes to `history/` unchanged, stamped with one date field
 * (R13). One file per moved claim; an occupied name takes the next free slot
 * beside it, because a history record is never overwritten.
 */
export function moveToHistory(paths: BankPaths, claim: Claim, stamp: { field: "supersededAt" | "rejectedAt"; day: string }): string {
	const stamped: Claim = { ...claim, [stamp.field]: stamp.day, state: "approved" } as Claim;
	for (let slot = 1; slot < 100; slot++) {
		const file = slot === 1 ? join(paths.history, `${claim.key}.md`) : join(paths.history, `${claim.key}-${slot}.md`);
		if (!existsSync(file)) {
			writeAtomic(file, renderStore(`# History: ${claim.key}`, [stamped]));
			return file;
		}
		const mine = readFileOrNull(file);
		if (mine !== undefined && renderStore(`# History: ${claim.key}`, [stamped]) === mine) return file; // identical bytes: already recorded
	}
	throw new Error(`no free history slot for "${claim.key}" after 99 tries`);
}

// ── Archive ────────────────────────────────────────────────────────────────

/** Move a source file into the read-only archive without ever deleting it (R39). */
export function archiveFile(paths: BankPaths, source: string): { file: string } {
	const name = basename(source);
	let target = join(paths.archive, name);
	for (let slot = 2; existsSync(target); slot++) target = join(paths.archive, `${name.replace(/\.md$/, "")}-${slot}.md`);
	renameSync(source, target);
	return { file: target };
}

/** Archive prose that is not a file: leftover status text pulled out of a claim body. */
export function archiveText(paths: BankPaths, name: string, text: string): { file: string } {
	const slug = name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "note";
	let target = join(paths.archive, `${slug}.md`);
	for (let slot = 2; existsSync(target); slot++) target = join(paths.archive, `${slug}-${slot}.md`);
	writeAtomic(target, text.endsWith("\n") ? text : `${text}\n`);
	return { file: target };
}

// ── Backup (R37) ───────────────────────────────────────────────────────────

export type ExecFn = (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const nodeExec: ExecFn = (command, args) =>
	new Promise((fulfill) => {
		execFile(command, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			fulfill({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});

/**
 * Back the bank up, then prove the tarball can be listed. A backup nobody can
 * open is not a backup, and every other migration step refuses without one.
 */
export async function backupBank(paths: BankPaths, opts: { exec?: ExecFn; day: string; clock?: () => Date }): Promise<{ file: string; entries: number }> {
	const exec = opts.exec ?? nodeExec;
	if (!existsSync(paths.root)) throw new Error(`no memory bank to back up at ${paths.root}`);
	if (!existsSync(paths.backups)) mkdirSync(paths.backups, { recursive: true });
	const when = opts.clock ? new Date(opts.clock().getTime()) : new Date();
	const name = `memory-${opts.day}-${String(when.getHours()).padStart(2, "0")}-${String(when.getMinutes()).padStart(2, "0")}-${String(when.getSeconds()).padStart(2, "0")}.tar.gz`;
	const file = join(paths.backups, name);
	const created = await exec("tar", ["-czf", file, "-C", paths.root, "."]);
	if (created.code !== 0 || existsSync(file) === false) throw new Error(`backup failed: ${created.stderr.trim() || `tar exited ${created.code}`}`);
	const listed = await exec("tar", ["-tzf", file]);
	if (listed.code !== 0) {
		rmSync(file, { force: true });
		throw new Error(`backup could not be listed back: ${listed.stderr.trim() || `tar exited ${listed.code}`}`);
	}
	const entries = listed.stdout.split("\n").filter((line) => line.trim() !== "" && !line.endsWith("/")).length;
	if (entries === 0) throw new Error(`backup ${file} contains no files`);
	return { file, entries };
}

export interface BackupRecord {
	file: string;
	verifiedAt: string;
	entries: number;
}

export function readJson<T>(file: string): T | undefined {
	const text = readFileOrNull(file);
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

export function writeJson(file: string, value: unknown): void {
	writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ── Health ─────────────────────────────────────────────────────────────────

export interface BankHealth {
	claims: { approved: number; pending: number; byKind: { rule: number; fact: number } };
	malformed: EntryError[];
	/** Identities with more than one approved claim: nothing injects for them (R12). */
	contested: { key: string; scope: string; files: string[] }[];
	unrooted: string[];
	unreadable: { file: string; error: string }[];
	tempFiles: string[];
	outsideLinks: { file: string; reason: string }[];
	historyFiles: number;
	archiveFiles: number;
}

/**
 * Contested identities, decided without a session context: two approved claims
 * on one key+scope is a fact about the store, not about where the question was
 * asked. Context-specific shadowing is `scope.ts`'s job.
 */
export function findContested(entries: ParsedEntry[]): { key: string; scope: string; files: string[] }[] {
	const byIdentity = new Map<string, ParsedEntry[]>();
	for (const entry of entries) {
		if (entry.claim.state !== "approved") continue;
		const list = byIdentity.get(identityOf(entry.claim)) ?? [];
		list.push(entry);
		byIdentity.set(identityOf(entry.claim), list);
	}
	const contested: { key: string; scope: string; files: string[] }[] = [];
	for (const [identity, group] of byIdentity) {
		if (group.length < 2) continue;
		const [key, scope] = identity.split("\u0000");
		contested.push({ key: key!, scope: scope!, files: group.map((entry) => `${entry.file}:${entry.startLine}`) });
	}
	return contested.sort((a, b) => `${a.key}${a.scope}`.localeCompare(`${b.key}${b.scope}`));
}

export function inspectBank(snapshot: BankSnapshot, paths: BankPaths): BankHealth {
	const byKind = { rule: 0, fact: 0 };
	let approved = 0;
	let pending = 0;
	for (const claim of snapshot.claims) {
		byKind[claim.kind] += 1;
		if (claim.state === "pending") pending++;
		else approved++;
	}
	return {
		claims: { approved, pending, byKind },
		malformed: snapshot.errors,
		contested: findContested(snapshot.entries),
		unrooted: unrootedPathScopes(snapshot.claims).map((claim) => `${claim.key} @ ${claim.scope}`),
		unreadable: snapshot.unreadable,
		tempFiles: snapshot.tempFiles,
		outsideLinks: snapshot.outsideLinks,
		historyFiles: markdownFiles(paths.history, paths.root).length,
		archiveFiles: markdownFiles(paths.archive, paths.root).length,
	};
}

/** Scratch helper for tests and the CLI: is this bank dir real? */
export function bankExists(paths: BankPaths): boolean {
	const stat = lstatSyncOrNull(paths.root);
	return stat !== undefined && stat.isDirectory();
}

export function describePaths(paths: BankPaths): string {
	return `${paths.root} (claims: ${paths.claims}, history: ${paths.history}, daily: ${paths.daily}, archive: ${paths.archive})`;
}

