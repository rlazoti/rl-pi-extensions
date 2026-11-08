import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DEFAULT_SCOPE, detectScope, fileScope, scopeReason, validScopeName } from "./scope.js";
import { MemoryIndex } from "./search.js";
import { parseSettings } from "./settings.js";
describe("optional path-derived scope", () => {
	it("preserves flat/shared/global paths and fails closed for unresolved project folders", () => {
		const alpha = detectScope({ mode: "explicit", name: "alpha" }, "/tmp");
		for (const rel of ["knowledge/flat.md", "knowledge/shared/x.md", "knowledge/alpha/x.md", "core/dailyContext.md", "history/design.md"]) expect(scopeReason(rel, alpha)).toBeNull();
		expect(scopeReason("knowledge/beta/x.md", alpha)).toContain("outside alpha");
		const missing = detectScope({ mode: "explicit", name: "" }, "/tmp");
		expect(scopeReason("knowledge/alpha/x.md", missing)).not.toBeNull();
		expect(scopeReason("knowledge/shared/x.md", missing)).toBeNull();
		expect(scopeReason("knowledge/beta/x.md", detectScope(DEFAULT_SCOPE, "/tmp"))).toBeNull();
		expect(fileScope("knowledge/shared/deep/x.md")).toBeNull();
		for (const name of ["../alpha", "/tmp", "shared", ".", "..", "alpha\n"]) expect(validScopeName(name)).toBe(false);
		expect(parseSettings({ scope: { mode: "explicit", name: "../bad" } }).scope).toEqual({ mode: "explicit", name: "" });
	});
	it("detects the nearest git directory or worktree marker, with an explicit override", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-detect-"));
		try {
			const repo = path.join(root, "alpha"), nested = path.join(repo, "packages/widget"); fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(path.join(repo, ".git"), "gitdir: /unused/worktree\n");
			expect(detectScope({ mode: "auto", name: "" }, nested)).toEqual({ mode: "auto", name: "alpha", source: "git" });
			expect(detectScope({ mode: "auto", name: "override" }, nested).source).toBe("explicit");
			fs.mkdirSync(path.join(nested, ".git")); expect(detectScope({ mode: "auto", name: "" }, nested).name).toBe("widget");
			expect(detectScope({ mode: "auto", name: "" }, path.join(root, "no-repo")).source).toBe("cwd");
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
	it("excludes other projects before the candidate cap, without hiding them from explicit search", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-ranking-"));
		try {
			const put = (rel: string, body: string) => { const full = path.join(root, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, body); };
			for (let i = 0; i < 12; i++) put(`knowledge/beta/${i}.md`, "# Zephyrledger\n\nZephyrledger rules.\n");
			put("knowledge/alpha/note.md", "# Alpha\n\nZephyrledger note.\n");
			const index = new MemoryIndex(root); index.build(); const active = detectScope({ mode: "explicit", name: "alpha" }, root);
			expect(index.searchForContext("zephyrledger", 1, undefined, { filter: (rel) => !scopeReason(rel, active) }).map((r) => r.path)).toEqual(["knowledge/alpha/note.md"]);
			expect(index.search("zephyrledger", 20).some((r) => r.path.startsWith("knowledge/beta/"))).toBe(true);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
});
