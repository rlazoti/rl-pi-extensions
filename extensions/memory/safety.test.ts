import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBankPath } from "./paths.js";
import { ServedVersions } from "./versions.js";
import { MemoryIndex } from "./search.js";

// Retain real filesystem operations but expose a spyable read seam to both callers.
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "memory-safety-"));
const root = path.join(temp, "bank");
process.env.PI_MEMORY_DIR = root;
const { default: extension } = await import("./index.js");
const tools = new Map<string, any>(), handlers = new Map<string, any>();
extension({ on: (e: string, h: any) => handlers.set(e, h), registerTool: (t: any) => tools.set(t.name, t), registerCommand() {} } as any);
const call = (name: string, args: unknown) => tools.get(name).execute("safety", args);
const quiet = { ui: { notify() {} } };
const file = "knowledge/version.md";
function put(rel: string, text: string) {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text);
	return full;
}
beforeEach(async () => { await handlers.get("session_start")({}, quiet); });
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

describe("content versions", () => {
	it.each([false, true])("refuses EACCES and EIO before writing, with revisions enabled=%s", async (enabled) => {
		const configFile = path.join(root, "config.json");
		const originalConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : null;
		const full = put(file, "# Unseen\n\n### Completed\n- preserve this\n");
		const originalRead = fs.readFileSync;
		try {
			put("config.json", JSON.stringify({ revisions: { enabled } }));
			await handlers.get("session_start")({}, quiet);
			for (const code of ["EACCES", "EIO"]) {
				const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((target: any, ...args: any[]) => {
					if (String(target) === full) throw Object.assign(new Error(code), { code });
					return (originalRead as any)(target, ...args);
				}) as any);
				try {
					for (const allowUnread of [false, true]) {
						const result = await call("memory_update", { file, content: "blind replacement", allowUnread });
						expect(result.isError).toBe(true); expect(result.details.refused).toBe("read-failed");
						expect(result.content[0].text).toContain(code);
					}
					const append = await call("memory_append", { file, section: "Completed", text: "- new" });
					expect(append.isError).toBe(true); expect(append.details.refused).toBe("read-failed");
				} finally { spy.mockRestore(); }
				expect(fs.readFileSync(full, "utf8")).toContain("preserve this");
			}
			// Both error paths released the target lock; a real read can recover.
			await call("memory_read", { file });
			expect((await call("memory_update", { file, content: "recovered" })).isError).not.toBe(true);
		} finally {
			if (originalConfig === null) fs.rmSync(configFile, { force: true }); else fs.writeFileSync(configFile, originalConfig);
		}
	});
	it("still creates genuinely missing files without an unread override", async () => {
		const rel = "knowledge/genuinely-new.md"; fs.rmSync(path.join(root, rel), { force: true });
		const result = await call("memory_update", { file: rel, content: "new note" });
		expect(result.isError).not.toBe(true); expect(fs.readFileSync(path.join(root, rel), "utf8")).toBe("new note");
	});
	it("refuses same-size content with the same mtime", async () => {
		const full = put(file, "# Version\nUse blue.\n"); fs.utimesSync(full, 1700000000, 1700000000);
		await call("memory_read", { file });
		fs.writeFileSync(full, "# Version\nUse pink.\n"); fs.utimesSync(full, 1700000000, 1700000000);
		const result = await call("memory_update", { file, content: "old-base replacement" });
		expect(result.isError).toBe(true); expect(fs.readFileSync(full, "utf8")).toContain("pink");
	});
	it("records the bytes read rather than a later disk revision", async () => {
		const full = put(file, "# Version\nOld decision.\n");
		const original = fs.readFileSync;
		let interleaved = false;
		const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((target: any, ...args: any[]) => {
			const content = (original as any)(target, ...args);
			if (!interleaved && String(target) === full) {
				interleaved = true; fs.writeFileSync(full, "# Version\nAn unseen new decision.\n");
			}
			return content;
		}) as any);
		try { expect((await call("memory_read", { file })).content[0].text).toContain("Old decision"); }
		finally { spy.mockRestore(); }
		expect(interleaved).toBe(true);
		const result = await call("memory_update", { file, content: "old-base replacement" });
		expect(result.isError).toBe(true); expect(fs.readFileSync(full, "utf8")).toContain("unseen");
	});
	it("requires a read or explicit unread override, never overriding partial protection", async () => {
		put(file, "# Existing\n");
		expect((await call("memory_update", { file, content: "blind" })).isError).toBe(true);
		expect((await call("memory_update", { file, content: "explicit", allowUnread: true })).isError).not.toBe(true);
		const served = new ServedVersions(); served.note(file, "explicit", true);
		expect(served.refusal(file, "explicit", true)).toContain("only part");
	});
	it("preserves complete visibility only for the exact unchanged content", () => {
		const versions = new ServedVersions();
		versions.note(file, "whole"); versions.note(file, "whole", true);
		expect(versions.complete(file, "whole")).toBe(true);
		expect(versions.refusal(file, "whole")).toBeNull();
		versions.note(file, "changed", true);
		expect(versions.complete(file, "changed")).toBe(false);
		expect(versions.refusal(file, "changed", true)).toContain("only part");
		versions.note(file, "changed"); expect(versions.complete(file, "changed")).toBe(true);
		versions.clear(); versions.note(file, "changed", true);
		expect(versions.refusal(file, "changed")).toContain("only part");
	});
	it.each([
		["cropped knowledge", "knowledge/visibility.md", 120],
		["withheld knowledge", "knowledge/visibility.md", 250],
		["cropped core", "core/activeProjects.md", 250],
	])("keeps a full read across later %s injection", async (_label, rel, count) => {
		const full = path.join(root, rel);
		const previous = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
		const text = "# Quasarfoxtrot\n\n" + Array.from({ length: count }, (_, i) => `Quasarfoxtrot row ${i}.`).join("\n");
		try {
			put(rel, text);
			const read = await call("memory_read", { file: rel });
			expect(read.isError).not.toBe(true); expect(read.content[0].text).toContain(`row ${count - 1}.`);
			const injected = await handlers.get("before_agent_start")({ messageType: "user", prompt: "quasarfoxtrot", systemPrompt: "" }, quiet);
			expect(injected.message.content).not.toContain(`row ${count - 1}.`);
			const updated = await call("memory_update", { file: rel, content: text + "\nupdated" });
			expect(updated.isError, updated.content[0].text).not.toBe(true);
			expect(fs.readFileSync(full, "utf8")).toContain("updated");
		} finally {
			if (previous === null) fs.rmSync(full, { force: true }); else fs.writeFileSync(full, previous);
		}
	});
	it("does not confuse metadata changes with content changes", () => {
		const versions = new ServedVersions(); versions.note(file, "same");
		expect(versions.refusal(file, "same")).toBeNull();
		expect(versions.refusal(file, null)).toContain("deleted");
	});
});

describe("filesystem boundaries and canonical identity", () => {
	it("shares served versions and search identity across case aliases, preserving distinct files when supported", async () => {
		const lower = "knowledge/case-note.md", upper = "knowledge/CASE-NOTE.MD";
		const full = put(lower, "# Case narwhal\nOriginal.\n");
		const aliases = fs.existsSync(path.join(root, upper));
		await call("memory_read", { file: lower });
		if (aliases) {
			expect(resolveBankPath(root, upper)!.rel).toBe(lower);
			const updated = await call("memory_update", { file: upper, content: "# Case narwhal\nUpdated.\n" });
			expect(updated.isError).not.toBe(true);
			fs.writeFileSync(full, "# Case narwhal\nUnseen external edit.\n");
			const refused = await call("memory_update", { file: upper, content: "stale", allowUnread: true });
			expect(refused.details.refused).toBe("stale-base");
			expect(fs.readFileSync(full, "utf8")).toContain("Unseen external edit");
		} else {
			expect((await call("memory_update", { file: upper, content: "# Case narwhal\nDistinct note.\n" })).isError).not.toBe(true);
			expect(fs.readFileSync(full, "utf8")).toContain("Original");
			expect(resolveBankPath(root, upper)!.rel).toBe(upper);
		}
		const search = await call("memory_search", { query: "case narwhal", limit: 10 });
		expect(search.details.results.filter((r: any) => [lower, upper].includes(r.path)).map((r: any) => r.path).sort()).toEqual(aliases ? [lower] : [upper, lower].sort());
		fs.rmSync(path.join(root, lower), { force: true }); fs.rmSync(path.join(root, upper), { force: true });
	});
	it("captures uppercase Markdown under canonical snapshot and search identity", async () => {
		const configFile = path.join(root, "config.json");
		const original = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : null;
		const lower = "knowledge/recovery-case.md", upper = "knowledge/RECOVERY-CASE.MD";
		put(lower, "original");
		const aliases = fs.existsSync(path.join(root, upper));
		if (!aliases) put(upper, "original");
		try {
			put("config.json", JSON.stringify({ revisions: { enabled: true } }));
			await handlers.get("session_start")({}, quiet);
			await call("memory_read", { file: upper });
			expect((await call("memory_update", { file: upper, content: "changed" })).isError).not.toBe(true);
			const entries = fs.readdirSync(path.join(root, ".revisions"), { recursive: true, encoding: "utf8" })
				.filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(root, ".revisions", f), "utf8")));
			const snapshot = entries.find((r) => r.path === (aliases ? lower : upper));
			expect(snapshot?.content).toBe("original");
			const index = new MemoryIndex(root); index.build();
			expect(index.search("changed").some((r) => r.path === (aliases ? lower : upper))).toBe(true);
		} finally {
			if (original === null) fs.rmSync(configFile, { force: true }); else fs.writeFileSync(configFile, original);
		}
	});
	it("refuses every casing of reserved recovery and lock targets", async () => {
		for (const rel of [".REVISIONS/sentinel.md", ".Revisions/sentinel.md", ".WRITE-LOCKS/sentinel.md"]) {
			const result = await call("memory_update", { file: rel, content: "poison", allowUnread: true });
			expect(result.isError).toBe(true); expect(result.content[0].text).toContain("internal recovery/lock");
			expect(fs.existsSync(path.join(root, rel))).toBe(false);
		}
	});
	it("tracks a newly created Unicode filename using the filesystem's stored spelling", async () => {
		const rel = "knowledge/caf\u00e9-new.md";
		const result = await call("memory_update", { file: rel, content: "# Unicode narwhal\nfirst" });
		expect(result.isError).not.toBe(true);
		const canonical = resolveBankPath(root, rel)!.rel;
		expect((await call("memory_update", { file: canonical, content: "# Unicode narwhal\nsecond" })).isError).not.toBe(true);
		const search = await call("memory_search", { query: "unicode narwhal", limit: 10 });
		expect(search.details.results.filter((r: any) => r.path === canonical)).toHaveLength(1);
		fs.rmSync(path.join(root, canonical), { force: true });
	});
	it("normalizes path aliases into one index document", async () => {
		const rel = "knowledge/identity.md";
		await call("memory_update", { file: rel, content: "# Narwhal identity\nNarwhal rule.\n", allowUnread: true });
		await call("memory_update", { file: "knowledge/./identity.md", content: "# Narwhal identity\nNarwhal rule.\n" });
		await call("memory_update", { file: path.join(root, rel), content: "# Narwhal identity\nNarwhal rule.\n" });
		const result = await call("memory_search", { query: "narwhal", limit: 10 });
		expect(result.details.results.map((r: any) => r.path)).toEqual([rel]);
	});
	it("refuses symlinked files, directories, and ancestors of new targets", async () => {
		const outside = path.join(temp, "outside"); fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(path.join(outside, "secret.md"), "# Axolotl secret\n");
		const link = path.join(root, "knowledge", "escape"); fs.symlinkSync(outside, link);
		const linkedFile = path.join(root, "knowledge", "linked.md"); fs.symlinkSync(path.join(outside, "secret.md"), linkedFile);
		try {
			expect((await call("memory_read", { file: "knowledge/linked.md" })).isError).toBe(true);
			expect((await call("memory_update", { file: "knowledge/escape/new/deep.md", content: "escape" })).isError).toBe(true);
			expect((await call("memory_list", { directory: "knowledge/escape" })).isError).toBe(true);
			expect(fs.existsSync(path.join(outside, "new"))).toBe(false);
			const idx = new MemoryIndex(root); idx.build(); expect(idx.search("axolotl")).toEqual([]);
		} finally { fs.unlinkSync(link); fs.unlinkSync(linkedFile); }
	});
	it("accepts valid dot-prefixed names, but not parent traversal", () => {
		expect(resolveBankPath(root, "knowledge/..valid.md")?.rel).toBe("knowledge/..valid.md");
		expect(resolveBankPath(root, "../outside/secret.md")).toBeNull();
	});
});
