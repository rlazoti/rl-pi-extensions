/** Cooperating-writer locks. Existing targets use their on-disk bank-relative
 * identity. A namespace gate serializes resolution against target creation, so
 * case/Unicode aliases of not-yet-existing targets cannot acquire different locks.
 * Existing targets release the gate before waiting for their per-target lock.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { ERR_OUTSIDE_BANK, resolveBankPath } from "./paths.js";

export async function acquireBankLock(root: string, file: string): Promise<(() => void) | null> {
	const lockDir = resolveBankPath(root, ".write-locks");
	let target = resolveBankPath(root, file);
	if (!lockDir || !target) throw new Error(ERR_OUTSIDE_BANK);
	fs.mkdirSync(lockDir.full, { recursive: true });
	const deadline = Date.now() + 3000;
	const acquire = async (name: string): Promise<(() => void) | null> => {
		const lock = path.join(lockDir.full, name + ".lock");
		for (;;) {
			try { fs.mkdirSync(lock); return () => fs.rmdirSync(lock); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (Date.now() >= deadline) return null;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}
	};
	let releaseNamespace: (() => void) | null = null;
	try {
		// The revision-store lock is a logical lock, not target creation. It is
		// nested inside target locks, so must never wait for the namespace gate.
		if (target.rel.toLowerCase() !== ".revisions") {
			releaseNamespace = await acquire("namespace");
			if (!releaseNamespace) return null;
			target = resolveBankPath(root, file); // another creator may have won
			if (!target) throw new Error(ERR_OUTSIDE_BANK);
			try {
				fs.lstatSync(target.full);
				releaseNamespace(); releaseNamespace = null;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				// Hold through commit and release: even filesystem-normalized names
				// must not be resolved by another writer halfway through creation.
			}
		}
		const name = createHash("sha256").update(target.rel).digest("hex");
		const releaseTarget = await acquire(name);
		if (!releaseTarget) { releaseNamespace?.(); return null; }
		return () => { try { releaseTarget(); } finally { releaseNamespace?.(); } };
	} catch (error) { releaseNamespace?.(); throw error; }
}
