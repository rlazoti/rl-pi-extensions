/** Test-process isolation plus after-the-fact detection on the original banks.
 * HOME/USERPROFILE and PI_MEMORY_DIR are redirected before worker imports and
 * inherited by subprocesses. This protects ordinary default-path use, not code
 * deliberately naming an outside absolute path. The snapshot guard detects
 * persistent additions, overwrites and deletions; it cannot attribute a change
 * to tests versus a concurrent live session, or catch writes undone before exit.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

function snapshot(root: string): Map<string, string> {
	const found = new Map<string, string>();
	const walk = (full: string) => {
		let stat: fs.Stats;
		try { stat = fs.lstatSync(full); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error; // an unreadable original bank is not a successful snapshot
		}
		const rel = path.relative(root, full) || ".";
		let rootLink = "";
		if (stat.isSymbolicLink()) {
			const link = `link:${fs.readlinkSync(full)}`;
			if (full !== root) { found.set(rel, link); return; }
			// A configured bank root may be a symlink. Guard its contents too,
			// without descending arbitrary symlinks below that root.
			rootLink = link + ":";
			stat = fs.statSync(full);
		}
		if (stat.isDirectory()) {
			found.set(rel, rootLink + "directory");
			for (const name of fs.readdirSync(full)) walk(path.join(full, name));
		} else if (stat.isFile()) {
			found.set(rel, `file:${createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`);
		} else found.set(rel, `special:${stat.mode}`);
	};
	walk(root);
	return found;
}

/** Exported so detection, including deletions and explicit overrides, is tested
 * against throwaway banks rather than mutating the operator's real bank.
 */
export function guardBank(root: string): () => void {
	const before = snapshot(root);
	return () => {
		const after = snapshot(root);
		const changed = [...new Set([...before.keys(), ...after.keys()])]
			.filter((rel) => before.get(rel) !== after.get(rel));
		if (changed.length) throw new Error(
			`bank isolation leak: original bank changed at ${root}:\n` +
			changed.slice(0, 20).map((rel) => `  ${rel}`).join("\n") +
			"\nAdded, overwritten or deleted paths were detected. Concurrent live-bank writes can also trigger this check; it does not undo changes.",
		);
	};
}

export default function setup() {
	const keys = ["HOME", "USERPROFILE", "PI_MEMORY_DIR", "PI_MEMORY_TEST_SUITE_ROOT"] as const;
	const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	const roots = new Set([path.join(os.homedir(), ".pi", "memory3")]);
	if (process.env.PI_MEMORY_DIR) roots.add(path.resolve(process.env.PI_MEMORY_DIR));
	// An override is another original bank to protect, not permission to disable
	// detection. The opt-out only disables detection, never sandboxing.
	const guards = process.env.PI_MEMORY_GUARD === "off" ? [] : [...roots].map(guardBank);
	const suite = fs.mkdtempSync(path.join(os.tmpdir(), "memory-suite-"));
	const home = path.join(suite, "home"), bank = path.join(suite, "bank");
	fs.mkdirSync(home); fs.mkdirSync(bank);
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.PI_MEMORY_DIR = bank;
	process.env.PI_MEMORY_TEST_SUITE_ROOT = suite;
	return () => {
		try { for (const guard of guards) guard(); }
		finally {
			for (const key of keys) {
				if (original[key] === undefined) delete process.env[key];
				else process.env[key] = original[key];
			}
			fs.rmSync(suite, { recursive: true, force: true });
		}
	};
}
