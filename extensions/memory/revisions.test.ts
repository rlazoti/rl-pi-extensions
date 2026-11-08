import { beforeEach, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_REVISIONS, RevisionStore } from "./revisions.js";
import { MemoryIndex } from "./search.js";

let bank: string, store: RevisionStore;
const config = { ...DEFAULT_REVISIONS, enabled: true };
const a = "knowledge/a.md", b = "knowledge/b.md";
const put = (file: string, text: string) => { const full = path.join(bank, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); };
const read = (file: string) => fs.readFileSync(path.join(bank, file), "utf8");
beforeEach(() => {
	bank = fs.mkdtempSync(path.join(os.tmpdir(), "revision-unit-")); fs.mkdirSync(path.join(bank, "knowledge"));
	// Unit IO is deliberately synchronous/simple. Handler, RPC and two-process
	// probes exercise the shipped atomic writer and real lock implementation.
	store = new RevisionStore(bank, (full, text) => fs.writeFileSync(full, text, { mode: 0o600 }), async () => () => {});
});
afterEach(() => fs.rmSync(bank, { recursive: true, force: true }));
describe("bounded optional local recovery", () => {
	it("is off by default and does not create a store", async () => {
		put(a, "# First\n"); await store.write(a, "# Second\n", DEFAULT_REVISIONS);
		expect(read(a)).toBe("# Second\n"); expect(fs.existsSync(path.join(bank, ".revisions"))).toBe(false);
	});
	it("captures canonical previous content, and restores with an undo backup even while disabled", async () => {
		put(a, "# Version one\n"); await store.write("knowledge/./a.md", "# Version two\n", config);
		const first = store.list(a, config).revisions[0]; expect(first.path).toBe(a);
		const result = await store.restore(a, first.id, DEFAULT_REVISIONS);
		expect(read(a)).toBe("# Version one\n"); expect(result.backupId).toBeTypeOf("string");
		await store.restore(a, result.backupId!, DEFAULT_REVISIONS); expect(read(a)).toBe("# Version two\n");
		const index = new MemoryIndex(bank); index.build(); expect(index.documentCount).toBe(1);
		expect(store.list(a, config).revisions.every((row) => !("content" in row))).toBe(true);
	});
	it("accepts valid older alias-spelled snapshots and restores with current filesystem identity", async () => {
		put(a, "one"); await store.write(a, "two", config);
		const first = store.list(a, config).revisions[0], upper = "knowledge/A.MD";
		const aliases = fs.existsSync(path.join(bank, upper));
		if (!aliases) put(upper, "distinct");
		const hash = (rel: string) => createHash("sha256").update(rel).digest("hex");
		const oldFull = path.join(bank, ".revisions", hash(a), first.id + ".json");
		const row = JSON.parse(fs.readFileSync(oldFull, "utf8")); row.path = upper;
		const newFolder = path.join(bank, ".revisions", hash(upper)); fs.mkdirSync(newFolder);
		fs.writeFileSync(path.join(newFolder, first.id + ".json"), JSON.stringify(row));
		fs.unlinkSync(oldFull); fs.rmdirSync(path.dirname(oldFull));
		const history = store.list(upper, config);
		expect(history.errors).toEqual([]); expect(history.revisions[0].path).toBe(aliases ? a : upper);
		const result = await store.restore(upper, first.id, config);
		expect(result.backupId).toBeTypeOf("string"); expect(read(upper)).toBe("one");
		expect(read(a)).toBe(aliases ? "one" : "two");
	});
	it("reserves internal names case-insensitively even when their directories are absent", async () => {
		for (const rel of [".REVISIONS/new.md", ".WRITE-LOCKS/new.md"]) {
			await expect(store.write(rel, "poison", config)).rejects.toThrow("Internal");
			expect(fs.existsSync(path.join(bank, rel))).toBe(false);
		}
	});
	it("prunes only old recovery copies to per-file and total byte bounds", async () => {
		const bounded = { enabled: true, maxPerFile: 2, maxTotalBytes: 65536 };
		put(a, "a0" + "x".repeat(20000)); put(b, "b0" + "y".repeat(20000));
		for (let i = 1; i <= 4; i++) {
			await store.write(a, `a${i}` + "x".repeat(20000), bounded);
			await store.write(b, `b${i}` + "y".repeat(20000), bounded);
		}
		const history = store.list(null, bounded);
		expect(history.errors).toEqual([]); expect(history.bytes).toBeLessThanOrEqual(65536);
		expect(history.revisions.length).toBeLessThanOrEqual(3);
		for (const file of [a, b]) expect(history.revisions.filter((r) => r.path === file).length).toBeLessThanOrEqual(2);
		expect(read(a)).toBe("a4" + "x".repeat(20000)); expect(read(b)).toBe("b4" + "y".repeat(20000));
	});
	it("lists and prunes valid old snapshots after lowering the byte budget", async () => {
		put(a, "x".repeat(70000));
		await store.write(a, "small current", config);
		const lowered = { ...config, maxTotalBytes: 65536 };
		const before = store.list(null, lowered);
		expect(before.errors).toEqual([]);
		expect(before.bytes).toBeGreaterThan(lowered.maxTotalBytes);
		expect(before.revisions).toHaveLength(1);
		// A large old snapshot for A must not block overwrites of B either.
		put(b, "small other"); await store.write(b, "new other", lowered);
		await store.write(a, "new current", lowered);
		const after = store.list(null, lowered);
		expect(after.errors).toEqual([]);
		expect(after.bytes).toBeLessThanOrEqual(lowered.maxTotalBytes);
		expect(after.revisions.some((r) => r.id === before.revisions[0].id)).toBe(false);
		expect(read(a)).toBe("new current"); expect(read(b)).toBe("new other");
		const backup = after.revisions.find((r) => r.path === a)!;
		await store.restore(a, backup.id, lowered); expect(read(a)).toBe("small current");
	});
	it("can restore an old snapshot larger than the lowered budget while backing up current text", async () => {
		const original = "z".repeat(70000); put(a, original);
		await store.write(a, "small", config);
		const first = store.list(a, config).revisions[0];
		const lowered = { ...config, maxTotalBytes: 65536 };
		const result = await store.restore(a, first.id, lowered);
		expect(read(a)).toBe(original); expect(result.backupId).toBeTypeOf("string");
		expect(store.list(null, lowered).errors).toEqual([]);
		expect(store.list(null, lowered).bytes).toBeLessThanOrEqual(lowered.maxTotalBytes);
		await expect(store.write(a, "replacement", lowered)).rejects.toThrow("previous text exceeds");
		expect(read(a)).toBe(original);
	});
	it("fails closed when previous text cannot fit in the backup budget", async () => {
		put(a, "z".repeat(80000));
		await expect(store.write(a, "replacement", { ...config, maxTotalBytes: 65536 })).rejects.toThrow("previous text exceeds");
		expect(read(a)).toBe("z".repeat(80000)); expect(store.list(a, config).revisions).toEqual([]);
	});
	it("verifies snapshot checksums, exact file identity and exact IDs before restoration", async () => {
		put(a, "one"); await store.write(a, "two", config); const first = store.list(a, config).revisions[0];
		await expect(store.restore(b, first.id, config)).rejects.toThrow("exact file");
		await expect(store.restore(a, "../../outside", config)).rejects.toThrow("exact revision ID");
		const files = fs.readdirSync(path.join(bank, ".revisions"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json"));
		const full = path.join(bank, ".revisions", files[0]), row = JSON.parse(fs.readFileSync(full, "utf8"));
		row.content = "tampered"; fs.writeFileSync(full, JSON.stringify(row));
		await expect(store.restore(a, first.id, config)).rejects.toThrow("inspection");
		await expect(store.write(a, "three", config)).rejects.toThrow("inspection"); expect(read(a)).toBe("two");
	});
	it("rejects internal targets, escaped paths, symlinked stores and busy locks", async () => {
		await expect(store.write(".revisions/fake.json", "x", config)).rejects.toThrow("Internal");
		await expect(store.write("../escaped.md", "x", config)).rejects.toThrow("Unsafe");
		put(a, "one");
		const busy = new RevisionStore(bank, () => { throw new Error("must not write"); }, async () => null);
		await expect(busy.write(a, "two", config)).rejects.toThrow("locked"); expect(read(a)).toBe("one");
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "revision-outside-"));
		try {
			fs.symlinkSync(outside, path.join(bank, ".revisions"), "dir");
			await expect(store.write(a, "two", config)).rejects.toThrow("Unsafe");
			expect(fs.readdirSync(outside)).toEqual([]); expect(read(a)).toBe("one");
		} finally { fs.rmSync(outside, { recursive: true, force: true }); }
	});
	it("can recover a missing target and makes same-content restoration a no-op", async () => {
		put(a, "one"); await store.write(a, "two", config); const first = store.list(a, config).revisions[0]; fs.unlinkSync(path.join(bank, a));
		expect(await store.restore(a, first.id, config)).toMatchObject({ restored: true, backupId: null });
		expect(read(a)).toBe("one"); expect(await store.restore(a, first.id, config)).toMatchObject({ restored: false });
	});
});
