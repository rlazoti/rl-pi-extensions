/**
 * The only module in this component that touches the filesystem.
 *
 * Everything above it — schema, resolver, gate, injection — is pure and can be
 * tested without a disk. This file is deliberately thin: read topic files, hand
 * back a parsed store, write back what the gate already rendered. It decides no
 * policy of its own; the two things it does decide (which files count as entry
 * stores, and where the memory bank lives) are stated here rather than scattered.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseTopicFile, type TopicFile } from "./schema.js";
import { buildStore, type MemoryStore } from "./resolver.js";
import { validateEntryPath, type FileEdit } from "./gate.js";

export interface MemoryPaths {
	/** Root of the memory bank, e.g. ~/.pi/memory or a PI_MEMORY_DIR override. */
	root: string;
	/** Directory holding entry stores: `<root>/knowledge`. */
	knowledge: string;
	/** Directory holding unresolved conflicts: `<root>/.pending`. */
	pending: string;
	/** Where enabled extensions live, used by the single-instance guard. */
	extensionsDir: string;
}

/**
 * `PI_MEMORY_DIR` and `PI_CODING_AGENT_DIR` are not decoration: validation,
 * migration dry runs and tests must run against a scratch bank, never the live
 * one. Development never touches the real bank.
 */
export function memoryPaths(env: NodeJS.ProcessEnv = process.env): MemoryPaths {
	// HOME is read from the passed env, not the process: the caller may be
	// pointing at a scratch bank, and a default that ignores it is how a test
	// ends up writing to a real bank.
	const home = env.HOME ?? os.homedir();
	const agentDir = env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent");
	// The bank is *not* under the agent dir: the live memory extension keeps it
	// at ~/.pi/memory, and cutover replaces that bank. Moving it silently would
	// split one history across two places.
	const root = env.PI_MEMORY_DIR ?? path.join(home, ".pi", "memory");
	return {
		root,
		knowledge: path.join(root, "knowledge"),
		pending: path.join(root, ".pending"),
		extensionsDir: path.join(agentDir, "extensions"),
	};
}

/** Resolve a memory-bank-relative path safely, or return null. */
export function resolveInBank(paths: MemoryPaths, file: string): string | null {
	if (validateEntryPath(file)) return null;
	const absolute = path.resolve(paths.root, file);
	const boundary = paths.root.endsWith(path.sep) ? paths.root : `${paths.root}${path.sep}`;
	if (!absolute.startsWith(boundary)) return null;
	return absolute;
}

/**
 * Resolve any path inside the bank — not only an entry store. Entry-path rules
 * (markdown, directly under `knowledge/`) guard *writes to claims*; a decided file
 * move crosses directories on purpose, so it needs containment without the
 * entry-shape rule. Both still refuse to leave the bank.
 */
export function resolveAnyInBank(paths: MemoryPaths, file: string): string | null {
	if (!file || file.startsWith("/") || file.includes("..")) return null;
	const absolute = path.resolve(paths.root, file);
	// A path that walks out of the bank by text is refused here, before anything is
	// opened. A *symlink* inside the bank pointing outside it is a different trick and
	// is caught on the read path, where the real target can be resolved.
	const boundary = paths.root.endsWith(path.sep) ? paths.root : `${paths.root}${path.sep}`;
	if (absolute !== paths.root && !absolute.startsWith(boundary)) return null;
	return absolute;
}

/**
 * Resolve symlinks and confirm the target really is inside the bank. Compares against
 * the *real* root, not the configured one: on macOS a temp root under `/var` resolves
 * to `/private/var`, and a false mismatch there would refuse every legitimate read.
 */
function realpathInsideBank(paths: MemoryPaths, absolute: string): boolean {
	try {
		const realRoot = fs.realpathSync(paths.root);
		const real = fs.realpathSync(absolute);
		const boundary = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
		return real === realRoot || real.startsWith(boundary);
	} catch {
		return false;
	}
}

/** Entry stores are the markdown files directly under `knowledge/`. */
export function listKnowledgeFiles(paths: MemoryPaths): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(paths.knowledge);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".md") && !name.startsWith("."))
		.sort()
		.map((name) => `knowledge/${name}`);
}

export interface LoadedStore {
	store: MemoryStore;
	/** Raw file text by memory-bank-relative path, for diffing and reporting. */
	raw: Map<string, string>;
	/** Files that could not be read at all, with the reason. */
	unreadable: Array<{ path: string; error: string }>;
}

/**
 * Read and parse every entry store. A missing `knowledge/` directory is an empty
 * store, not an error: a fresh bank is a normal state, and refusing to start
 * would make the migration that fills it in impossible to run.
 */
export function loadKnowledgeStore(paths: MemoryPaths): LoadedStore {
	const files: TopicFile[] = [];
	const raw = new Map<string, string>();
	const unreadable: LoadedStore["unreadable"] = [];

	for (const file of listKnowledgeFiles(paths)) {
		const absolute = resolveInBank(paths, file);
		if (absolute === null) {
			unreadable.push({ path: file, error: "path escapes the memory bank" });
			continue;
		}
		try {
			const text = fs.readFileSync(absolute, "utf8");
			raw.set(file, text);
			files.push(parseTopicFile(text, file));
		} catch (error) {
			unreadable.push({ path: file, error: error instanceof Error ? error.message : String(error) });
		}
	}

	return { store: buildStore(files), raw, unreadable };
}

export interface BankFile {
	text: string;
	/** Day the file last changed (YYYY-MM-DD). Used only when the file does not say
	 * what day it is about — and only as evidence, labelled as such. */
	modified?: string;
}

/** Read any file inside the bank, not only an entry store. */
export function readBankFile(paths: MemoryPaths, file: string): BankFile | null {
	const absolute = resolveAnyInBank(paths, file);
	if (absolute === null) return null;
	try {
		const text = fs.readFileSync(absolute, "utf8");
		let modified: string | undefined;
		try {
			modified = fs.statSync(absolute).mtime.toISOString().slice(0, 10);
		} catch {
			modified = undefined;
		}
		return { text, modified };
	} catch {
		return null;
	}
}

/**
 * Read a window of any file inside the bank, for `memory_read`. Offsets count
 * **graphemes** — what a person counts as one character — not bytes or UTF-16 units.
 * A byte offset splits an emoji in half and a code-unit offset splits a ZWJ sequence
 * (`🧑‍💻` is three code points), and either hands back mojibake that the reader cannot
 * tell apart from the file. The total is reported so a truncation is never mistaken
 * for the whole file.
 */
export interface BankSlice {
	text: string;
	totalChars: number;
	offset: number;
	shownChars: number;
	truncated: boolean;
	modified?: string;
}

const graphemeSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;

/** Split into graphemes, falling back to code points where `Intl.Segmenter` is absent. */
function graphemes(text: string): string[] {
	if (graphemeSegmenter) return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
	return Array.from(text);
}

/** Files an interrupted write left behind: damage, and the doctor reports them. */
const TEMP_FILE = /\.tmp-\d+(-\d+)?$/;

export function isTempFile(name: string): boolean {
	return TEMP_FILE.test(name);
}

export function readBankSlice(
	paths: MemoryPaths,
	file: string,
	options: { offset?: number; maxChars?: number } = {},
): BankSlice | null {
	const absolute = resolveAnyInBank(paths, file);
	if (absolute === null) return null;
	let text: string;
	try {
		text = fs.readFileSync(absolute, "utf8");
	} catch {
		return null;
	}
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const maxChars = Math.max(1, Math.floor(options.maxChars ?? 20_000));
	const units = graphemes(text);
	const window = units.slice(offset, offset + maxChars);
	const shown = window.join("");
	let modified: string | undefined;
	try {
		modified = fs.statSync(absolute).mtime.toISOString().slice(0, 10);
	} catch {
		modified = undefined;
	}
	return {
		text: shown,
		totalChars: units.length,
		offset,
		shownChars: window.length,
		truncated: offset + window.length < units.length,
		modified,
	};
}

export type BankRead =
	| { kind: "read"; slice: BankSlice }
	| { kind: "missing" }
	| { kind: "directory" }
	| { kind: "outside" };

export function readBankFileChecked(
	paths: MemoryPaths,
	file: string,
	options: { offset?: number; maxChars?: number } = {},
): BankRead {
	const absolute = resolveAnyInBank(paths, file);
	if (absolute === null) return { kind: "outside" };
	try {
		if (fs.statSync(absolute).isDirectory()) return { kind: "directory" };
	} catch {
		return { kind: "missing" };
	}
	if (!realpathInsideBank(paths, absolute)) return { kind: "outside" };
	const slice = readBankSlice(paths, file, options);
	return slice === null ? { kind: "missing" } : { kind: "read", slice };
}

export interface BankEntryInfo {
	path: string;
	directory: boolean;
	chars?: number;
	modified?: string;
}

export interface BankListing {
	entries: BankEntryInfo[];
	/** True when the walk stopped early — always reported, never silently shortened. */
	truncated: boolean;
	truncatedBecause: "limit" | "depth" | null;
}

export type BankListingResult =
	| { kind: "listed"; dir: string; listing: BankListing }
	| { kind: "missing" }
	| { kind: "outside" }
	| { kind: "not-a-directory" };

/**
 * List what is inside the bank — not only the entry stores. `knowledge/` is the
 * authority surface; `core/` and `history/` are the working and archived state that
 * nothing else can reach, which is exactly why this exists. Hidden entries (`.pending`,
 * temp files) are skipped: the queue is reported by `/memory pending` and the doctor.
 */
export function listBankFiles(
	paths: MemoryPaths,
	relDir = ".",
	options: { limit?: number; maxDepth?: number } = {},
): BankListingResult {
	const root = relDir === "." || relDir === "" ? paths.root : resolveAnyInBank(paths, relDir);
	if (root === null) return { kind: "outside" };
	let isDirectory = false;
	try {
		isDirectory = fs.statSync(root).isDirectory();
	} catch {
		return { kind: "missing" };
	}
	if (!isDirectory) return { kind: "not-a-directory" };
	// After the existence check: realpath on a path that does not exist throws, and
	// "does not exist" must stay a missing answer rather than becoming "outside".
	if (!realpathInsideBank(paths, root)) return { kind: "outside" };

	const limit = Math.max(1, Math.floor(options.limit ?? 200));
	const maxDepth = Math.max(1, Math.floor(options.maxDepth ?? 4));
	const entries: BankEntryInfo[] = [];
	let truncatedBecause: BankListing["truncatedBecause"] = null;

	const walk = (dir: string, depth: number): boolean => {
		let names: string[];
		try {
			names = fs.readdirSync(dir).filter((name) => !name.startsWith(".")).sort();
		} catch {
			return true;
		}
		for (const name of names) {
			if (entries.length >= limit) {
				truncatedBecause = "limit";
				return false;
			}
			const full = path.join(dir, name);
			const relative = path.relative(paths.root, full);
			let stats: fs.Stats | undefined;
			try {
				// The bank is a plain tree. A link inside it could point outside it, or
				// loop, so the listing skips links rather than guessing what they mean.
				if (fs.lstatSync(full).isSymbolicLink()) continue;
				stats = fs.statSync(full);
			} catch {
				continue;
			}
			if (stats.isDirectory()) {
				entries.push({ path: `${relative}/`, directory: true });
				if (depth >= maxDepth) {
					truncatedBecause = "depth";
					continue;
				}
				if (!walk(full, depth + 1)) return false;
			} else {
				let chars: number | undefined;
				try {
					chars = graphemes(fs.readFileSync(full, "utf8")).length;
				} catch {
					chars = undefined;
				}
				// A `.tmp-<pid>` sibling is listed, not hidden: it means a write was
				// interrupted, and a listing that hides it makes the damage invisible.
				entries.push({ path: relative, directory: false, chars, modified: stats.mtime.toISOString().slice(0, 10) });
			}
		}
		return true;
	};

	walk(root, 1);
	return { kind: "listed", dir: relDir === "" ? "." : relDir, listing: { entries, truncated: truncatedBecause !== null, truncatedBecause } };
}

/**
 * Write any file inside the bank (archives, daily context). Same discipline as
 * applyEdits: write beside, then rename, and never leave a temp file behind.
 * `noOverwrite` is for archives, which are records: a record is never rewritten.
 */
export function writeBankFile(paths: MemoryPaths, file: string, content: string, options: { noOverwrite?: boolean } = {}): string | null {
	const absolute = resolveAnyInBank(paths, file);
	if (absolute === null) return null;
	if (options.noOverwrite === true && fs.existsSync(absolute)) return null;
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`;
	try {
		fs.writeFileSync(temporary, content, "utf8");
		fs.renameSync(temporary, absolute);
	} catch (error) {
		try {
			fs.rmSync(temporary, { force: true });
		} catch {
			/* the temp file may not exist */
		}
		throw error;
	}
	return file;
}

/**
 * Write exactly what the gate rendered — byte for byte. This function does not
 * re-render, re-order or re-validate entries: the rendered text *is* the
 * decision, and rewriting it here is how a write path acquires a second, subtly
 * different serializer.
 */
export function applyEdits(paths: MemoryPaths, edits: readonly FileEdit[]): string[] {
	const written: string[] = [];
	for (const edit of edits) {
		const absolute = resolveInBank(paths, edit.path);
		if (absolute === null) throw new Error(`refusing to write outside the memory bank: ${edit.path}`);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		// Write-then-rename: a crash mid-write leaves the previous file intact
		// rather than a half-written topic file that the parser would report as
		// corrupt.
		const temp = `${absolute}.tmp-${process.pid}`;
		fs.writeFileSync(temp, edit.content, "utf8");
		fs.renameSync(temp, absolute);
		written.push(edit.path);
	}
	return written;
}

/** True when another memory extension is loaded as a real directory. */
export function foreignMemoryExtension(paths: MemoryPaths): string | null {
	const target = path.join(paths.extensionsDir, "memory");
	try {
		const stats = fs.lstatSync(target);
		// Our own component is enabled by symlink; a real directory is the old
		// standalone extension, which registers the same tool names.
		return stats.isSymbolicLink() ? null : target;
	} catch {
		return null;
	}
}
