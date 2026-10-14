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
	return path.resolve(paths.root, file);
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
