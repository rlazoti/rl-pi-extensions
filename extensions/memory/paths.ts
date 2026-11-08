/** One filesystem boundary and identity for tools, index entries, and locks. */
import * as fs from "node:fs";
import * as path from "node:path";

export interface BankPath { full: string; rel: string }

export const ERR_OUTSIDE_BANK = "Error: path must be within the memory bank directory.";
export const isMarkdownPath = (rel: string): boolean => /\.md$/i.test(rel);

/**
 * Reject symlinks below the configured root, including ancestors of new files.
 * The configured root may itself be a symlink. This is accident protection, not
 * a sandbox against another process racing directory replacements.
 *
 * Containment is decided on path *segments*. `full.startsWith(root)` is not a
 * containment test: with the bank at ~/.pi/memory3 the sibling ~/.pi/memory3-evil
 * also starts with that string, so `../memory3-evil/x.md` passed the old check and
 * `memory_update` wrote it.
 */
export function resolveBankPath(root: string, target: string): BankPath | null {
	if (target.includes("\0")) return null;
	const absoluteRoot = path.resolve(root);
	const relative = path.relative(absoluteRoot, path.resolve(absoluteRoot, target));
	if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return null;
	let realRoot: string;
	try { realRoot = fs.realpathSync(absoluteRoot); }
	catch { realRoot = absoluteRoot; }
	let full = realRoot;
	const segments: string[] = [];
	for (let segment of relative.split(path.sep).filter(Boolean)) {
		const parent = full;
		full = path.join(parent, segment);
		try {
			const stat = fs.lstatSync(full, { bigint: true });
			if (stat.isSymbolicLink()) return null;
			// realpath on macOS can preserve caller casing. Directory entries are
			// authoritative: only merge spellings the filesystem resolves to the
			// same inode, never lowercase distinct files on a case-sensitive volume.
			const names = fs.readdirSync(parent);
			if (!names.includes(segment)) {
				const matches = names.filter((name) => {
					try {
						const other = fs.lstatSync(path.join(parent, name), { bigint: true });
						return !other.isSymbolicLink() && other.dev === stat.dev && other.ino === stat.ino;
					} catch { return false; }
				});
				// Ambiguous hardlink aliases fail closed; exact entry names still work.
				if (matches.length !== 1) return null;
				segment = matches[0]; full = path.join(parent, segment);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
		}
		segments.push(segment);
	}
	return { full, rel: segments.join("/") };
}
