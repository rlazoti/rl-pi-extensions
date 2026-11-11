import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { scoreEvaluation, splitLoggedSessions, validateCorpus, type EvalCorpus } from "./evaluation.js";
const corpus = JSON.parse(fs.readFileSync(new URL("./fixtures/retrieval/corpus.json", import.meta.url), "utf8")) as EvalCorpus;

describe("frozen evaluation", () => {
	it("validates snapshots and never invents owner approval", () => {
		validateCorpus(corpus); expect(corpus.cases.length).toBeGreaterThanOrEqual(30);
		expect(corpus.provenance.reviewedBy).toBeNull();
		expect(() => validateCorpus({ ...corpus, cases: [...corpus.cases, corpus.cases[0]] })).toThrow("Duplicate");
		expect(() => validateCorpus({ ...corpus, files: {} })).toThrow("Missing snapshot");
	});
	it("keeps the fictional project examples consistent across snapshots and cases", () => {
		for (const name of ["lumo-build", "lumo-import", "harbor-stack"]) {
			const example = corpus.cases.find((item) => item.id === name);
			expect(example, name).toBeDefined();
			expect(example!.must).toContain(`knowledge/${name}.md`);
			expect(corpus.files[`knowledge/${name}.md`]).toBeTruthy();
		}
	});
	it("accounts for missing required files, irrelevant admissions, and no-memory cases separately", () => {
		const small: EvalCorpus = { schemaVersion: 1, provenance: corpus.provenance, files: { "a.md": "a", "b.md": "b" }, cases: [
			{ id: "positive", prompt: "a", must: ["a.md"] }, { id: "negative", prompt: "none", must: [], none: true },
		] };
		const result = scoreEvaluation(small, [
			{ id: "positive", files: ["b.md"], named: [], chars: 10 }, { id: "negative", files: [], named: [], chars: 5 },
		]);
		expect(result).toMatchObject({ found: 0, required: 1, relevant: 0, slots: 1, correctNone: 1, noMemory: 1, chars: 15, ownerReviewed: false });
		expect(result.failures[0]).toMatchObject({ missing: ["a.md"], irrelevant: ["b.md"] });
		expect(() => scoreEvaluation(small, [])).toThrow("every case");
	});
	it("improves provisional recall and cost without claiming owner review", () => {
		const run = (policy: string) => {
			const result = spawnSync(process.execPath, ["scripts/evaluate-retrieval.mjs", "--json", "--policy", policy], { cwd: process.cwd(), encoding: "utf8" });
			expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout);
		};
		const legacy = run("legacy"), balanced = run("balanced");
		expect(balanced.recall).toBe(1); expect(balanced.precision).toBeGreaterThanOrEqual(0.9);
		expect(balanced.correctNone).toBe(balanced.noMemory); expect(balanced.chars).toBeLessThan(legacy.chars);
		expect(balanced.ownerReviewed).toBe(false);
	});
	it("passes frozen scope-collision labels through the same handler", () => {
		for (const policy of ["legacy", "balanced"]) {
			const run = spawnSync(process.execPath, ["scripts/evaluate-retrieval.mjs", "--json", "--strict", "--policy", policy, "--corpus", "fixtures/retrieval/scope-corpus.json"], { cwd: process.cwd(), encoding: "utf8" });
			expect(run.status, run.stderr || run.stdout).toBe(0); const report = JSON.parse(run.stdout);
			expect(report.recall).toBe(1); expect(report.correctNone).toBe(report.noMemory); expect(report.ownerReviewed).toBe(false);
		}
	});
	it("runs the shipped handler, excluding core and named-only files from admitted slots",  () => {
		const run = spawnSync(process.execPath, ["scripts/evaluate-retrieval.mjs", "--json"], { cwd: process.cwd(), encoding: "utf8" });
		expect(run.status, run.stderr).toBe(0);
		const report = JSON.parse(run.stdout);
		expect(report.cases).toBe(corpus.cases.length); expect(report.ownerReviewed).toBe(false);
		expect(report.observations.every((r: any) => r.files.length <= 3 && r.files.every((f: string) => !f.startsWith("core/")))).toBe(true);
		const oversized = report.observations.find((r: any) => r.id === "oversize");
		expect(oversized.named).toContain("knowledge/oversized.md"); expect(oversized.files).not.toContain("knowledge/oversized.md");
	});
});

describe("session attribution", () => {
	const inject = (sid: string | undefined, minute: number, p: string) => ({ t: "inject", sid, ts: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(), p });
	it("does not merge concurrent sessions, and uses a gap in each session's own clock", () => {
		const result = splitLoggedSessions([inject("a", 0, "a0"), inject("b", 1, "b0"), inject("a", 2, "a1"), inject("b", 33, "b1")]);
		expect(result.sessions.map((s) => s.prompts)).toEqual([["a0", "a1"], ["b0"], ["b1"]]);
	});
	it("isolates unknown sessions, respects transcript resets, and skips redacted/invalid lines", () => {
		const result = splitLoggedSessions([inject(undefined, 0, "legacy"), inject("a", 1, "before"),
			{ t: "reset", sid: "a", ts: "2026-01-01T00:02:00.000Z" }, inject("a", 3, "after"),
			inject(undefined, 4, "legacy2"), inject("a", 5, "[redacted]"), { t: "inject", sid: "a", ts: "wrong", p: "bad" }]);
		expect(result.sessions.map((s) => s.prompts)).toEqual([["legacy"], ["before"], ["after"], ["legacy2"]]);
		expect(result).toMatchObject({ unattributed: 2, invalid: 1 });
	});
});

describe("judging memory_search", () => {
	it("finds the first expected file's 1-based rank, or null", async () => {
		const { firstRank } = await import("./evaluation.js");
		expect(firstRank(["a", "b", "c"], ["c", "b"])).toBe(2);
		expect(firstRank(["a"], ["z"])).toBeNull();
		expect(firstRank([], ["z"])).toBeNull();
	});
	it("counts top-k hits per mode and names what meaning gained and what fusion lost", async () => {
		const { summarizeRanks } = await import("./evaluation.js");
		const r = summarizeRanks([
			{ id: "both", keyword: 1, fused: 1 },
			{ id: "gained", keyword: null, fused: 2 },
			{ id: "gained-late", keyword: 5, fused: 3 },
			{ id: "lost", keyword: 2, fused: 4 },
			{ id: "neither", keyword: null, fused: null },
		], 3);
		expect(r).toEqual({ cases: 5, k: 3, keywordTopK: 2, fusedTopK: 3, gained: ["gained", "gained-late"], lost: ["lost"] });
	});
});
