import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
	extractTitle,
	categorize,
	extractSnippet,
	walkMarkdownFiles,
	admitsToContext,
	topEligibleScore,
	withheldShare,
	MAX_WITHHELD_SHARE,
	MemoryIndex,
} from "./search.js";

// ── extractTitle ─────────────────────────────────────────────────

describe("extractTitle", () => {
	it("extracts h1 heading", () => {
		expect(extractTitle("# My Title\n\nSome content", "file.md")).toBe("My Title");
	});

	it("extracts h2 heading", () => {
		expect(extractTitle("## Second Level\n\nContent", "file.md")).toBe("Second Level");
	});

	it("extracts h3 heading", () => {
		expect(extractTitle("### Third Level", "file.md")).toBe("Third Level");
	});

	it("falls back to filename without .md", () => {
		expect(extractTitle("No heading here, just text.", "my-notes.md")).toBe("my-notes");
	});

	it("uses first heading even if not on line 1", () => {
		expect(extractTitle("Some preamble\n\n# The Heading\n\nMore text", "f.md")).toBe("The Heading");
	});

	it("trims whitespace from heading", () => {
		expect(extractTitle("#   Spaced Title   \n", "f.md")).toBe("Spaced Title");
	});
});

// ── categorize ───────────────────────────────────────────────────

describe("categorize", () => {
	it("returns 'core' for core/ paths", () => {
		expect(categorize("core/activeProjects.md")).toBe("core");
	});

	it("returns 'knowledge' for knowledge/ paths", () => {
		expect(categorize("knowledge/git-rules.md")).toBe("knowledge");
	});

	it("returns 'history' for history/ paths", () => {
		expect(categorize("history/daily/2025-03/file.md")).toBe("history");
	});

	it("returns 'other' for unknown paths", () => {
		expect(categorize("random/file.md")).toBe("other");
	});
});

// ── extractSnippet ───────────────────────────────────────────────

describe("extractSnippet", () => {
	it("returns snippet around matching line", () => {
		const content = "Line one\nLine two\nThe answer is 42\nLine four\nLine five";
		const snippet = extractSnippet(content, "answer");
		expect(snippet).toContain("The answer is 42");
	});

	it("ignores function words when choosing the line", () => {
		// The first line contains "the", and used to be chosen for almost every query,
		// because the query's own function words were among the terms searched for.
		const content = "The week started calmly.\n\nThe kanban board tracks each card by lane.\n";
		expect(extractSnippet(content, "the kanban board")).toContain("kanban board tracks");
	});

	it("falls back to the top of the file when the query is all function words", () => {
		const content = "First line.\n\nLater line.\n";
		expect(extractSnippet(content, "what is this about")).toContain("First line");
	});

	it("returns beginning of content when no match found", () => {
		const content = "Some long content that goes on and on";
		const snippet = extractSnippet(content, "nonexistent");
		expect(snippet).toContain("Some long content");
	});

	it("truncates long snippets with ellipsis", () => {
		const longLine = "x".repeat(300);
		const content = `${longLine}\nThe match is here`;
		const snippet = extractSnippet(content, "nonexistent", 50);
		expect(snippet.length).toBeLessThanOrEqual(51); // 50 + "…"
		expect(snippet).toContain("…");
	});

	it("includes context lines around the match", () => {
		const content = "Before line\nThe match line\nAfter line";
		const snippet = extractSnippet(content, "match");
		expect(snippet).toContain("Before line");
		expect(snippet).toContain("The match line");
		expect(snippet).toContain("After line");
	});

	it("handles empty query gracefully", () => {
		const content = "Some content here";
		const snippet = extractSnippet(content, "");
		expect(snippet).toContain("Some content");
	});

	it("does not add ellipsis when content fits", () => {
		const content = "Short";
		const snippet = extractSnippet(content, "nonexistent", 200);
		expect(snippet).toBe("Short");
	});

	it("adds ellipsis when matching snippet is truncated", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `Line ${i} with keyword`);
		const content = lines.join("\n");
		const snippet = extractSnippet(content, "keyword", 50);
		expect(snippet).toContain("…");
	});
});

// ── walkMarkdownFiles + MemoryIndex ──────────────────────────────

describe("walkMarkdownFiles", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-"));

		// Create a mini memory bank structure
		fs.mkdirSync(path.join(tmpDir, "core"), { recursive: true });
		fs.mkdirSync(path.join(tmpDir, "knowledge"), { recursive: true });
		fs.mkdirSync(path.join(tmpDir, "history", "daily", "2025-03"), { recursive: true });

		fs.writeFileSync(path.join(tmpDir, "core", "activeProjects.md"), "# Active Projects\n\n- Project A\n");
		fs.writeFileSync(path.join(tmpDir, "core", "dailyContext.md"), "## 2025-03-24\n\n### In Progress\n- Task 1\n");
		fs.writeFileSync(
			path.join(tmpDir, "knowledge", "git-rules.md"),
			"# Git Rules\n\nAlways use conventional commits.\nSquash before merging.\n",
		);
		fs.writeFileSync(
			path.join(tmpDir, "knowledge", "tone-guide.md"),
			"# Tone Guide\n\nWrite proposals with confidence.\nAvoid hedging language.\nBe direct and specific.\n",
		);
		fs.writeFileSync(
			path.join(tmpDir, "history", "daily", "2025-03", "2025-03-20-dailyContext.md"),
			"## 2025-03-20\n\n### Completed\n- Decided on webhook topic naming\n",
		);

		// Non-md file should be ignored
		fs.writeFileSync(path.join(tmpDir, "knowledge", "scratch.txt"), "not indexed\n");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("finds all .md files recursively", () => {
		const docs = walkMarkdownFiles(tmpDir, tmpDir);
		expect(docs.length).toBe(5);
		expect(docs.map((d) => d.id).sort()).toEqual([
			"core/activeProjects.md",
			"core/dailyContext.md",
			"history/daily/2025-03/2025-03-20-dailyContext.md",
			"knowledge/git-rules.md",
			"knowledge/tone-guide.md",
		]);
	});

	it("skips non-.md files", () => {
		const docs = walkMarkdownFiles(tmpDir, tmpDir);
		expect(docs.find((d) => d.id.endsWith(".csv"))).toBeUndefined();
	});

	it("extracts titles from headings", () => {
		const docs = walkMarkdownFiles(tmpDir, tmpDir);
		const gitRules = docs.find((d) => d.id === "knowledge/git-rules.md");
		expect(gitRules?.title).toBe("Git Rules");
	});

	it("assigns correct categories", () => {
		const docs = walkMarkdownFiles(tmpDir, tmpDir);
		const categories = Object.fromEntries(docs.map((d) => [d.id, d.category]));
		expect(categories["core/activeProjects.md"]).toBe("core");
		expect(categories["knowledge/git-rules.md"]).toBe("knowledge");
		expect(categories["history/daily/2025-03/2025-03-20-dailyContext.md"]).toBe("history");
	});

	it("respects maxDepth", () => {
		const docs = walkMarkdownFiles(tmpDir, tmpDir, 1);
		// Should find core/ and knowledge/ files but NOT history/daily/2025-03/
		expect(docs.every((d) => !d.id.startsWith("history/daily/2025-03/"))).toBe(true);
	});

	it("returns empty array for nonexistent directory", () => {
		const docs = walkMarkdownFiles(path.join(tmpDir, "nonexistent"), tmpDir);
		expect(docs).toEqual([]);
	});
});

// ── MemoryIndex ──────────────────────────────────────────────────

describe("MemoryIndex", () => {
	let tmpDir: string;
	let index: MemoryIndex;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-idx-"));

		fs.mkdirSync(path.join(tmpDir, "core"), { recursive: true });
		fs.mkdirSync(path.join(tmpDir, "knowledge"), { recursive: true });
		fs.mkdirSync(path.join(tmpDir, "history", "daily", "2025-03"), { recursive: true });

		fs.writeFileSync(path.join(tmpDir, "core", "activeProjects.md"), "# Active Projects\n\n- Project Alpha P1\n");
		fs.writeFileSync(path.join(tmpDir, "core", "dailyContext.md"), "## 2025-03-24\n\n### Completed\n- Fixed auth bug\n");
		fs.writeFileSync(
			path.join(tmpDir, "knowledge", "git-rules.md"),
			"# Git Conventions\n\nUse conventional commits.\nAlways squash merge.\nPrefix with feat/fix/chore.\n",
		);
		fs.writeFileSync(
			path.join(tmpDir, "knowledge", "tone-guide.md"),
			"# Proposal Tone\n\nWrite with confidence and clarity.\nAvoid hedging words like maybe or perhaps.\nBe direct, specific, and assertive.\n",
		);
		fs.writeFileSync(
			path.join(tmpDir, "history", "daily", "2025-03", "2025-03-20-dailyContext.md"),
			"## 2025-03-20\n\n### Key Decisions\n- Decided on webhook naming convention\n- Auth refactor approach finalized\n",
		);

		index = new MemoryIndex(tmpDir);
		index.build();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("builds index with correct document count", () => {
		expect(index.documentCount).toBe(5);
	});

	it("searches by keyword", () => {
		const results = index.search("conventional commits");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].path).toBe("knowledge/git-rules.md");
	});

	it("finds knowledge files with fuzzy matching", () => {
		// "proposal" should match "Proposal Tone" title
		const results = index.search("proposal");
		expect(results.some((r) => r.path === "knowledge/tone-guide.md")).toBe(true);
	});

	it("searches across history files", () => {
		const results = index.search("webhook naming");
		expect(results.some((r) => r.path.includes("history/"))).toBe(true);
	});

	it("returns empty for empty query", () => {
		expect(index.search("")).toEqual([]);
		expect(index.search("   ")).toEqual([]);
	});

	it("returns empty for no matches", () => {
		const results = index.search("xyzzyplugh");
		expect(results).toEqual([]);
	});

	it("respects limit parameter", () => {
		const results = index.search("the", 2);
		expect(results.length).toBeLessThanOrEqual(2);
	});

	it("normalizes query case and diacritics just as indexed terms are normalized", () => {
		const file = path.join(tmpDir, "knowledge/unicode.md");
		fs.writeFileSync(file, "# LUMO São Paulo résumé\n\nBuild the LUMO résumé importer.\n");
		index.updateDocument("knowledge/unicode.md");
		for (const query of ["LUMO", "lumo", "SÃO PAULO", "sao paulo", "résumé", "resume"]) {
			expect(index.search(query)[0]?.path, query).toBe("knowledge/unicode.md");
		}
		expect(index.search("AND AM AN")).toEqual([]);
	});

	it("includes scores and snippets in results", () => {
		const results = index.search("git");
		expect(results[0].score).toBeGreaterThan(0);
		expect(results[0].snippet.length).toBeGreaterThan(0);
		expect(results[0].category).toBe("knowledge");
	});

	describe("updateDocument", () => {
		it("adds new documents to the index", () => {
			fs.writeFileSync(
				path.join(tmpDir, "knowledge", "new-rules.md"),
				"# New Rules\n\nSome brand new rules about deployment.\n",
			);
			index.updateDocument("knowledge/new-rules.md");
			expect(index.documentCount).toBe(6);

			const results = index.search("deployment");
			expect(results.some((r) => r.path === "knowledge/new-rules.md")).toBe(true);
		});

		it("updates existing documents in the index", () => {
			fs.writeFileSync(
				path.join(tmpDir, "knowledge", "git-rules.md"),
				"# Git Conventions\n\nNever force push to main.\n",
			);
			index.updateDocument("knowledge/git-rules.md");
			expect(index.documentCount).toBe(5); // same count

			const results = index.search("force push");
			expect(results.some((r) => r.path === "knowledge/git-rules.md")).toBe(true);
		});

		it("handles deleted files gracefully", () => {
			fs.unlinkSync(path.join(tmpDir, "knowledge", "git-rules.md"));
			index.updateDocument("knowledge/git-rules.md");
			expect(index.documentCount).toBe(4);
		});

		it("ignores non-.md files", () => {
			index.updateDocument("knowledge/scratch.txt");
			expect(index.documentCount).toBe(5); // unchanged
		});

		// Regression: with minisearch's default autoVacuum enabled, repeated
		// discard() + add() from many updateDocument() calls would schedule
		// async vacuum passes that mutated the radix tree while the iterator
		// was walking it, crashing with:
		//   TypeError: Cannot read properties of undefined (reading 'keys')
		//     at TreeIterator.dive
		//     at MiniSearch.performVacuuming
		it("survives many updates without crashing the minisearch iterator", async () => {
			// Seed the knowledge dir with enough docs and unique terms to push
			// minisearch past its internal vacuum thresholds (minDirtCount: 20,
			// minDirtFactor: 0.1).
			for (let i = 0; i < 40; i++) {
				const content = Array.from(
					{ length: 40 },
					(_, j) => `term${i}_${j}_${Math.random().toString(36).slice(2, 8)}`,
				).join(" ");
				fs.writeFileSync(
					path.join(tmpDir, "knowledge", `doc-${i}.md`),
					`# Doc ${i}\n\n${content}\n`,
				);
			}
			index.build();

			// Simulate many rounds of memory_update writes overwriting the files.
			expect(() => {
				for (let round = 0; round < 10; round++) {
					for (let i = 0; i < 40; i++) {
						const content = Array.from(
							{ length: 40 },
							(_, j) => `update${round}_${i}_${j}_${Math.random().toString(36).slice(2, 8)}`,
						).join(" ");
						fs.writeFileSync(
							path.join(tmpDir, "knowledge", `doc-${i}.md`),
							`# Doc ${i} r${round}\n\n${content}\n`,
						);
						index.updateDocument(`knowledge/doc-${i}.md`);
					}
				}
			}).not.toThrow();

			// Give any scheduled async vacuum a chance to run and potentially throw.
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Index is still usable.
			expect(index.documentCount).toBe(45); // 5 seeded + 40 generated
			expect(index.search("update9").length).toBeGreaterThan(0);
		});
	});

	describe("searchForContext", () => {
		it("returns knowledge files matching the prompt", () => {
			const hits = index.searchForContext("how to write proposals with good tone");
			expect(hits.some((h) => h.path === "knowledge/tone-guide.md")).toBe(true);
			expect(hits[0].content.length).toBeGreaterThan(0);
		});

		it("includes content in results", () => {
			const hits = index.searchForContext("git conventions");
			const gitHit = hits.find((h) => h.path === "knowledge/git-rules.md");
			expect(gitHit).toBeDefined();
			expect(gitHit!.content).toContain("conventional commits");
		});

		it("returns empty for empty query", () => {
			expect(index.searchForContext("")).toEqual([]);
			expect(index.searchForContext("   ")).toEqual([]);
		});

		it("filters out core files — they're already injected", () => {
			const hits = index.searchForContext("active projects");
			expect(hits.every((h) => h.path.startsWith("knowledge/") || h.path.startsWith("history/"))).toBe(true);
		});

		it("respects limit parameter", () => {
			const hits = index.searchForContext("the", 1);
			expect(hits.length).toBeLessThanOrEqual(1);
		});

		it("respects minScore parameter", () => {
			const hits = index.searchForContext("git", 10, 999999);
			expect(hits).toEqual([]);
		});

		it("includes high-scoring history files", () => {
			const hits = index.searchForContext("webhook naming convention");
			expect(hits.some((h) => h.path.includes("history/"))).toBe(true);
		});

		it("excludes knowledge when includeKnowledge is false", () => {
			const hits = index.searchForContext("git conventions", 3, undefined, { includeKnowledge: false });
			expect(hits.every((h) => !h.path.startsWith("knowledge/"))).toBe(true);
		});

		it("excludes history when includeHistory is false", () => {
			const hits = index.searchForContext("webhook naming convention", 3, undefined, { includeHistory: false });
			expect(hits.every((h) => !h.path.startsWith("history/"))).toBe(true);
		});

		it("returns empty when both categories excluded", () => {
			const hits = index.searchForContext("git", 3, undefined, { includeKnowledge: false, includeHistory: false });
			expect(hits).toEqual([]);
		});

		it("defaults to including both categories when options not provided", () => {
			const withOpts = index.searchForContext("webhook naming", 3, undefined, { includeKnowledge: true, includeHistory: true });
			const withoutOpts = index.searchForContext("webhook naming", 3);
			expect(withOpts.length).toBe(withoutOpts.length);
			expect(withOpts.map((h) => h.path)).toEqual(withoutOpts.map((h) => h.path));
		});
	});

	describe("search with deleted files", () => {
		it("handles files deleted after indexing in search()", () => {
			// Index includes the file, then delete it
			const results1 = index.search("git conventions");
			expect(results1.length).toBeGreaterThan(0);

			// A new retrieval reconciles the deletion, without an explicit refresh.
			fs.unlinkSync(path.join(tmpDir, "knowledge", "git-rules.md"));
			const results2 = index.search("git conventions");
			expect(results2.some((r) => r.path === "knowledge/git-rules.md")).toBe(false);
			expect(results2.every((r) => r.snippet.length > 0)).toBe(true);
		});

		it("handles files deleted after indexing in searchForContext()", () => {
			const hits1 = index.searchForContext("git conventions");
			expect(hits1.length).toBeGreaterThan(0);

			fs.unlinkSync(path.join(tmpDir, "knowledge", "git-rules.md"));
			const hits2 = index.searchForContext("git conventions");
			expect(hits2.some((r) => r.path === "knowledge/git-rules.md")).toBe(false);
			expect(hits2.every((r) => r.content.length > 0)).toBe(true);
		});
	});

	describe("disk reconciliation", () => {
		it("sees independent additions, same-mtime edits, renames and deletions", () => {
			const second = new MemoryIndex(tmpDir); second.build();
			const file = path.join(tmpDir, "knowledge/external.md");
			fs.writeFileSync(file, "# Nebula\n\nquokka1\n");
			expect(index.search("quokka1").some((r) => r.path === "knowledge/external.md")).toBe(true);
			const stat = fs.statSync(file);
			fs.writeFileSync(file, "# Nebula\n\noracle9\n"); fs.utimesSync(file, stat.atime, stat.mtime);
			expect(index.search("oracle9").some((r) => r.path === "knowledge/external.md")).toBe(true);
			expect(index.search("quokka1")).toEqual([]);
			fs.renameSync(file, path.join(tmpDir, "knowledge/renamed.md"));
			expect(second.search("oracle9").map((r) => r.path)).toContain("knowledge/renamed.md");
			expect(second.search("oracle9").some((r) => r.path === "knowledge/external.md")).toBe(false);
			fs.unlinkSync(path.join(tmpDir, "knowledge/renamed.md"));
			expect(second.search("oracle9")).toEqual([]);
		});
		it("does not reindex merely touched content or index internal directories", () => {
			const before = index.search("git conventions")[0].score;
			const file = path.join(tmpDir, "knowledge/git-rules.md"), at = new Date(Date.now() + 1000);
			fs.utimesSync(file, at, at);
			expect(index.reconcile()).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 5 });
			expect(index.search("git conventions")[0].score).toBe(before);
			fs.mkdirSync(path.join(tmpDir, ".revisions")); fs.writeFileSync(path.join(tmpDir, ".revisions/secret.md"), "# Zebracorn\n");
			expect(index.search("zebracorn")).toEqual([]);
		});
	});

	describe("rebuild", () => {
		it("rebuilds cleanly without duplicates", () => {
			index.build();
			index.build();
			expect(index.documentCount).toBe(5);
		});

		it("picks up new files on rebuild", () => {
			fs.writeFileSync(path.join(tmpDir, "knowledge", "extra.md"), "# Extra\n\nExtra content.\n");
			const count = index.build();
			expect(count).toBe(6);
			expect(index.documentCount).toBe(6);
		});
	});

	describe("empty memory bank", () => {
		it("builds with zero documents when no .md files exist", () => {
			const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-empty-"));
			try {
				const emptyIndex = new MemoryIndex(emptyDir);
				const count = emptyIndex.build();
				expect(count).toBe(0);
				expect(emptyIndex.documentCount).toBe(0);
				expect(emptyIndex.search("anything")).toEqual([]);
				expect(emptyIndex.searchForContext("anything")).toEqual([]);
			} finally {
				fs.rmSync(emptyDir, { recursive: true, force: true });
			}
		});
	});
});

// ── admitsToContext / topEligibleScore ─────────────────────────────
//
// The 50%-of-top-score bar used to live inline inside searchForContext, where
// testing it meant constructing two BM25 scores in a specific ratio — length
// normalisation makes that fragile. It is a pure rule now, so the rule and the
// reason strings the injection debug line prints are testable on their own.

describe("withheldShare", () => {
	// The rule §3.5 applies after the ranking: a file whose cut would leave less than half
	// of it is named in the prompt instead, because a fragment is a wrong claim with a
	// pointer to the right one. One rule, three callers — the boundary is pinned here so
	// the injector, the log and the debug line cannot each have their own.
	it("lets a file that keeps most of itself through, and withholds one that does not", () => {
		expect(withheldShare(9000, 3000)).toEqual({ skipWhole: false, share: 1 / 3 });
		expect(withheldShare(9000, 6000)).toEqual({ skipWhole: true, share: 2 / 3 });
	});

	it("draws the line at half, and half still arrives", () => {
		expect(MAX_WITHHELD_SHARE).toBe(0.5);
		expect(withheldShare(1000, 500).skipWhole).toBe(false);
		expect(withheldShare(1000, 501).skipWhole).toBe(true);
	});

	it("never withholds an uncapped file, and never divides by an empty one", () => {
		expect(withheldShare(4000, 0).skipWhole).toBe(false);
		expect(withheldShare(0, 0).skipWhole).toBe(false);
	});
});

describe("admitsToContext", () => {
	const both = { includeKnowledge: true, includeHistory: true };

	it("admits any matching knowledge file and never core or other", () => {
		expect(admitsToContext("knowledge", 0.1, 100, both)).toEqual({ admit: true, reason: "knowledge" });
		expect(admitsToContext("core", 100, 100, both)).toEqual({ admit: false, reason: "core is injected directly" });
		expect(admitsToContext("other", 100, 100, both).admit).toBe(false);
	});

	it("requires history to clear strictly more than half the top score", () => {
		expect(admitsToContext("history", 50.1, 100, both).admit).toBe(true);
		expect(admitsToContext("history", 50, 100, both).admit).toBe(false); // strict >, as before
		expect(admitsToContext("history", 49.9, 100, both).admit).toBe(false);
	});

	it("names the rule in the reason, for the debug line to print verbatim", () => {
		expect(admitsToContext("history", 10, 100, both).reason).toBe("history under half of 100.0");
		expect(admitsToContext("history", 90, 100, both).reason).toBe("history over half the top score");
		expect(admitsToContext("knowledge", 5, 10, { includeKnowledge: false, includeHistory: true }).reason)
			.toBe("knowledge injection off");
		expect(admitsToContext("history", 5, 10, { includeKnowledge: true, includeHistory: false }).reason)
			.toBe("history injection off");
	});

	it("treats a zero top score as no bar to clear", () => {
		expect(admitsToContext("history", 0.1, 0, both).admit).toBe(true);
	});
});

describe("topEligibleScore", () => {
	const candidates = [
		{ category: "history", score: 100 },
		{ category: "knowledge", score: 40 },
	];

	it("takes the highest scoring eligible category", () => {
		expect(topEligibleScore(candidates, { includeKnowledge: true, includeHistory: true })).toBe(100);
	});

	it("ignores excluded categories, so they cannot raise the history bar", () => {
		expect(topEligibleScore(candidates, { includeKnowledge: true, includeHistory: false })).toBe(40);
		expect(topEligibleScore(candidates, { includeKnowledge: false, includeHistory: true })).toBe(100);
	});

	it("ignores core and other entirely", () => {
		expect(topEligibleScore([{ category: "core", score: 999 }], { includeKnowledge: true, includeHistory: true })).toBe(0);
		expect(topEligibleScore([], { includeKnowledge: true, includeHistory: true })).toBe(0);
	});
});

// ── fuzzy and prefix limits ────────────────────────────────────────
//
// The README states these as numbers, so they are pinned against the library
// rather than against memory: MiniSearch computes the edit budget as
// Math.round(term.length * fuzzy), which is not the intuitive "one edit per
// term" and gives different answers at different word lengths.
describe("fuzzy and prefix limits", () => {
	let tmpDir: string;
	let idx: MemoryIndex;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-fuzzy-"));
		fs.mkdirSync(path.join(tmpDir, "knowledge"), { recursive: true });
		const write = (name: string, text: string) =>
			fs.writeFileSync(path.join(tmpDir, "knowledge", name), `# ${name}\n\n${text}\n`, "utf-8");
		write("node.md", "The node runtime.");
		write("case.md", "A case of wine.");
		write("inventory.md", "Inventory counts.");
		write("webhook.md", "Webhook delivery rules.");
		idx = new MemoryIndex(tmpDir);
		idx.build();
	});

	afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	const paths = (query: string) => idx.search(query).map((r) => r.path);

	it("fuzzes a 4-character term: note finds node", () => {
		expect(paths("note")).toContain("knowledge/node.md");
	});

	it("spends one edit, not two: cache does not find case", () => {
		expect(paths("cache")).not.toContain("knowledge/case.md");
	});

	it("prefix-matches terms of 3 or more characters", () => {
		expect(paths("webh")).toContain("knowledge/webhook.md");
	});

	it("does not prefix-match a short term", () => {
		// The bug this guards: "i am stuck" prefix-matching "inventory" and pulling
		// an unrelated knowledge file into the prompt.
		expect(paths("i am out")).not.toContain("knowledge/inventory.md");
	});
});
