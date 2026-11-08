import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireBankLock } from "./locks.js";
import { resolveBankPath } from "./paths.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "path-locks-")); fs.mkdirSync(path.join(root, "knowledge")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const pause = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("filesystem-aware target identity", () => {
	it.each([
		["case", "knowledge/note.md", "knowledge/NOTE.MD"],
		["directory case", "knowledge/note.md", "KNOWLEDGE/NOTE.MD"],
		["Unicode normalization", "knowledge/caf\u00e9.md", "knowledge/cafe\u0301.md"],
	])("uses actual filesystem %s semantics, not string folding", async (_label, name, other) => {
		const first = name, second = other;
		fs.writeFileSync(path.join(root, first), "first");
		const aliases = fs.existsSync(path.join(root, second));
		if (!aliases) { fs.mkdirSync(path.dirname(path.join(root, second)), { recursive: true }); fs.writeFileSync(path.join(root, second), "second"); }
		const a = resolveBankPath(root, first)!, b = resolveBankPath(root, second)!;
		expect(a.rel === b.rel).toBe(aliases);
		const releaseA = (await acquireBankLock(root, first))!;
		let settled = false;
		const pending = acquireBankLock(root, second).then((release) => { settled = true; return release; });
		try { await pause(); expect(settled).toBe(!aliases); }
		finally { releaseA(); (await pending)?.(); }
	});
	it("serializes missing-target aliases through creation and then resolves them again", async () => {
		const first = "knowledge/new.md", second = "knowledge/NEW.MD";
		const releaseA = (await acquireBankLock(root, first))!;
		let settled = false;
		const pending = acquireBankLock(root, second).then((release) => { settled = true; return release; });
		try {
			await pause(); expect(settled).toBe(false);
			fs.writeFileSync(path.join(root, first), "created under the lock");
			await pause(); expect(settled).toBe(false);
		} finally { releaseA(); (await pending)?.(); }
		const expectedAlias = fs.existsSync(path.join(root, second));
		expect(resolveBankPath(root, first)!.rel === resolveBankPath(root, second)!.rel).toBe(expectedAlias);
	});
	it("does not deadlock the nested revision-store lock while creating a target", async () => {
		const releaseTarget = (await acquireBankLock(root, "knowledge/new.md"))!;
		try {
			const releaseStore = await acquireBankLock(root, ".revisions");
			expect(releaseStore).not.toBeNull(); releaseStore?.();
		} finally { releaseTarget(); }
	});
	it("releases the namespace gate when revalidation rejects a newly introduced symlink", async () => {
		const release = (await acquireBankLock(root, "knowledge/creator.md"))!;
		const pending = acquireBankLock(root, "knowledge/raced.md").then(() => "unexpected", () => "refused");
		await pause(); fs.symlinkSync(path.join(root, "knowledge/creator.md"), path.join(root, "knowledge/raced.md"));
		release(); expect(await pending).toBe("refused");
		const recovered = await acquireBankLock(root, "knowledge/recovered.md");
		expect(recovered).not.toBeNull(); recovered?.();
	});
});
