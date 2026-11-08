/**
 * One bank root, one atomic writer, one config file.
 *
 * The root is read once, at import: every path in the extension descends from it, and a
 * root that changed mid-session would leave half the writes in the old bank. It is also
 * the reason `PI_MEMORY_DIR` is honoured rather than configured in config.json — the
 * config file lives inside the bank it is meant to describe.
 *
 * `writeBankFile` and `patchConfigFile` are the only ways this extension puts bytes on
 * disk, so "every write is atomic" and "saving one setting never drops another" are
 * properties of one function each instead of habits repeated at every call site.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ERR_OUTSIDE_BANK, resolveBankPath } from "./paths.js";

/**
 * Refuse to bind to the operator's bank inside a test run.
 *
 * These constants are read once, so the env var has to be set before this module
 * is evaluated — and ES imports hoist above a test file's own statements. A test
 * that sets PI_MEMORY_DIR in its body while statically importing anything that
 * reaches bank.ts evaluates this file with no override, caches the operator's
 * real bank in the module registry, and then writes its fixtures there. That
 * happened on 2026-11-08. setupFiles (vitest.isolate-bank.ts) makes it
 * impossible; this makes it loud if that hook is ever removed, or if a test
 * file is added outside the vitest include pattern.
 */
if (process.env.VITEST && !process.env.PI_MEMORY_DIR) {
	throw new Error(
		"memory3: test process imported bank.ts with no PI_MEMORY_DIR. " +
			"vitest.isolate-bank.ts (setupFiles) is supposed to set it — check that the file is still " +
			"configured, and that the importing test loads the extension with a dynamic import after " +
			"pointing PI_MEMORY_DIR at a temp directory.",
	);
}

export const MEMORY_ROOT = process.env.PI_MEMORY_DIR ?? path.join(os.homedir(), ".pi", "memory3");
export const CORE_DIR = path.join(MEMORY_ROOT, "core");
export const KNOWLEDGE_DIR = path.join(MEMORY_ROOT, "knowledge");
export const HISTORY_DIR = path.join(MEMORY_ROOT, "history", "daily");
export const CONFIG_PATH = path.join(MEMORY_ROOT, "config.json");
export const LOG_DIR = path.join(MEMORY_ROOT, "logs");

/**
 * Replace a bank file atomically. writeFileSync truncates first, so a reader in
 * another process can open the file between the truncate and the write and find it
 * empty — measured at 2-4% of reads taken while another session wrote a 5 KB file
 * (npm run race), and an empty read that an agent writes back is a lost file
 * rather than a stale one. A rename within a directory is atomic: a reader sees
 * the old file or the new one, never the gap. The temp name keeps a .md-ish suffix
 * off the end so a crash cannot leave something the indexer or a listing picks up
 * as a note.
 */
export function writeBankFile(filePath: string, content: string): void {
	const safe = resolveBankPath(MEMORY_ROOT, filePath);
	if (!safe) throw new Error(ERR_OUTSIDE_BANK);
	const tmp = `${safe.full}.tmp-${process.pid}-${randomUUID()}`;
	try {
		const fd = fs.openSync(tmp, "wx", 0o600);
		try { fs.writeFileSync(fd, content, "utf-8"); } finally { fs.closeSync(fd); }
		fs.renameSync(tmp, safe.full);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* nothing to clean up */
		}
		throw err;
	}
}

/** Safety-critical reads: only absence permits creation. Permission and I/O
 * failures must never be mistaken for a missing file before an overwrite. */
export function readCurrentFile(filePath: string): string | null {
	try { return fs.readFileSync(filePath, "utf-8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export function readIfExists(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

/**
 * config.json as an object, or empty when it is missing or unparseable.
 *
 * A broken file is not an error: the extension runs on defaults and `/memory doctor`
 * says so. Silent would be the lie, which is why doctor — not this function — owns
 * the warning.
 */
export function readConfigFile(): Record<string, unknown> {
	try {
		const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * Merge one section into config.json and write it back atomically.
 *
 * Every setting used to do this read-modify-write itself, and a save that forgot to
 * re-read would quietly delete another section — the injection frequencies, the log
 * switches, the retrieval policy. One owner means one place for "unknown keys are
 * preserved", which is also what keeps settings written by an older or newer build.
 */
export function patchConfigFile(patch: Record<string, unknown>): void {
	writeBankFile(CONFIG_PATH, JSON.stringify({ ...readConfigFile(), ...patch }, null, 2) + "\n");
}
