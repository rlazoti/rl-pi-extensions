/**
 * Injection relevance tests.
 *
 * What question this answers: when a prompt arrives, which knowledge files enter
 * the prompt? The extension has a top-3 cut and no relevance floor, so a file
 * enters whenever it scores more than zero. That is a very low bar: an unrelated
 * prompt that shares one word with an alias list gets a 1 KB decision attached to
 * it. These cases say what should happen, in both directions.
 *
 * The bank here is a fixture, not ~/.pi/memory3. Six files sit in the same
 * directory on purpose: three knowledge slots and six candidates is the smallest
 * bank where ranking can be wrong in an interesting way. The file contents copy
 * the shape of real ones — a short body and an H1 that carries alias words —
 * because the alias list is what makes these files easy to match.
 *
 * Scores here are relative to these six files. The table is the contract; the
 * numbers are only evidence.
 *
 * One rule has shipped since these cases were written: function words are dropped
 * from queries, which cut the files these five noise prompts pull in from 15 to 9.
 * The bar itself did not move — above zero still admits a file, which is why every
 * "known defect" case below still fails to be empty and still asserts that it is.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryIndex, extractTitle } from "./search.js";

let tmpDir: string;
let index: MemoryIndex;

function write(rel: string, content: string) {
	const full = path.join(tmpDir, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, "utf-8");
}

const FILE = {
	concurrency: "# Concurrent writes (two agents, race, lost update, overwrite, locking, shared bank)\n\nTwo writers on one file. Guard the copy in hand; do not add lock files.\n",
	reversal: "# Reversed decisions (contradiction, stale record, supersede, change my mind, outdated preference)\n\nRewrite the record that covers the decision. Do not add a second file.\n",
	react: "# React forms (form, submit, double submit, controlled input, debounce, onClick)\n\nDisable the button while the request runs. Do not rely on the browser to block a second submit.\n",
	postgres: "# Postgres migrations (postgres, migration, add column, index, zero downtime, lock timeout)\n\nAdd a nullable column. Create indexes CONCURRENTLY. Never take an ACCESS EXCLUSIVE lock on a hot table.\n",
	tailwind: "# UI styling (tailwind, dark mode, spacing, rounded corners, modal, login page)\n\nUse the spacing scale. Dark mode classes go on the root element, not on each child.\n",
	python: "# Python performance (python, list comprehension, slow, profile, 100k rows, big-O)\n\nProfile before you rewrite. A comprehension is rarely the cost; the function inside it usually is.\n",
};

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-eval-"));
	for (const [name, content] of Object.entries(FILE)) {
		write(`knowledge/${name}.md`, content);
	}
	write(
		"history/daily/2026-10/2026-10-20-dailyContext.md",
		"## 2026-10-20\n\n### Completed\n- moved the shared bank off the laptop and set PI_MEMORY_DIR\n",
	);
	index = new MemoryIndex(tmpDir);
	index.build();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface Case {
	prompt: string;
	/** A key of FILE, or "none" when no knowledge file should appear. */
	expect: keyof typeof FILE | "none";
	why: string;
	/** True when the desired result and the actual result differ, and why. */
	known?: string;
}

const CASES: Case[] = [
	// Desired and actual agree on these six. A real person's wording, not the
	// file's vocabulary: the react file says "double submit", the prompt says
	// "submits twice", and prefix plus a shared stem still connect them.
	{ prompt: "my react form submits twice when I click save, how do I stop that", expect: "react", why: "the forms file owns this" },
	{ prompt: "how do I add a column to a large postgres table without taking downtime", expect: "postgres", why: "the migrations file owns this" },
	{ prompt: "dark mode does not apply to my modal, I use tailwind", expect: "tailwind", why: "the styling file owns this" },
	{ prompt: "two sessions wrote to the same notes file and one edit disappeared", expect: "concurrency", why: "the concurrency decision, asked as a symptom" },
	{ prompt: "this python loop over 100k rows is slow, what should I measure first", expect: "python", why: "the profiling file owns this" },

	// Desired: found. Actual: not found, and no tuning of the scorer changes that.
	// BM25 is lexical. Fuzzy matching is an edit-distance budget, not a thesaurus.
	{
		prompt: "should I use a mutex or an actor to protect this worker queue in kotlin",
		expect: "concurrency",
		why: "genuinely about concurrent writes",
		known: "mutex, actor and queue appear nowhere in the file, so nothing matches",
	},
	{
		prompt: "we chose blue last week and green today but the memory still says blue",
		expect: "reversal",
		why: "the reversal rule, asked as a symptom",
		known: "the file says supersede and stale record; the prompt says chose and week and green",
	},

	// Desired: absent. Actual: one false positive, because scoring above zero is
	// the only admission test that exists.
	{ prompt: "what should I name this variable that holds the user's last login time", expect: "none", why: "naming is not in the bank", known: "any nonzero score admits a file" },
	{ prompt: "why does my docker image rebuild every layer when I change one file", expect: "none", why: "docker caching is not in the bank", known: "the words change and file appear in an unrelated alias list" },
	{ prompt: "how do I write a clearer error message for a failed payment", expect: "none", why: "prose style is not in the bank", known: "any nonzero score admits a file" },
	{ prompt: "how do I change the keyboard shortcut for format document", expect: "none", why: "editor settings are not in the bank", known: "the word change again" },
	{
		prompt: "what image dimensions should the export use for retina screens",
		expect: "none",
		why: "adjacent to the styling file, and still not styling conventions",
		known: "the most interesting false positive: it is one step from a real hit",
	},
];

describe("which knowledge files a prompt is allowed to pull in", () => {
	it.each(CASES)("$prompt", (c) => {
		const hits = index.searchForContext(c.prompt, 3, undefined, { includeKnowledge: true, includeHistory: false });
		const paths = hits.map((h) => h.path);
		const listed = paths.map((p, i) => `${p.replace("knowledge/", "")} ${hits[i].score.toFixed(0)}`).join(", ") || "(nothing)";

		if (c.expect === "none") {
			if (c.known) {
				// Characterisation, not approval: this fails the day someone fixes it.
				expect(paths.length, `known defect — ${c.known}; got ${listed}`).toBeGreaterThan(0);
			} else {
				expect(paths, `${c.why}; got ${listed}`).toEqual([]);
			}
			return;
		}

		const want = `knowledge/${c.expect}.md`;
		if (c.known) {
			expect(paths, `known limit — ${c.known}; got ${listed}`).not.toContain(want);
		} else {
			expect(paths, `${c.why}\nactual: ${listed}`).toContain(want);
		}
	});

	it("pulls fewer files into a prompt that shares no content word", () => {
		// The measurement behind dropping function words from queries. These five prompts
		// share no content word with the bank. Before the rule they pulled in 15 files
		// (three each), because "the" in a body or "for" prefix-matching "form" in a title
		// scored above zero, and above zero is the only admission test. After it: 9, and
		// roughly half the scores. Recall did not move — every wanted prompt still gets its
		// file, in first place.
		const noise = CASES.filter((c) => c.expect === "none").map((c) => c.prompt);
		let files = 0;
		for (const p of noise) {
			files += index.searchForContext(p, 3, undefined, { includeKnowledge: true, includeHistory: false }).length;
		}
		expect(files).toBeLessThanOrEqual(9);

		// A prompt of nothing but function words asks for nothing, and gets nothing.
		expect(
			index.searchForContext("how do I feel about this", 3, undefined, { includeKnowledge: true, includeHistory: false }),
		).toEqual([]);
	});

	it("still ranks the right file when the bank is a hundred times bigger", () => {
		// The guard against regressions that only exist at size. BM25 magnitudes move with
		// corpus size — one prompt and one file scored 39 in a one-file bank and 176 in a
		// sixty-file bank — so a six-file fixture can be green while a year-old bank ranks
		// badly.
		//
		// What this test was measured to catch, by mutating the scorer and running the
		// suite: prefix matching on short terms (kills this test and passes all 206
		// others), requiring every query term to match, a minimum score above ~400, and two
		// knowledge files sharing an alias set. What it does not catch: a weaker title
		// boost, and a floor below ~400, because scores here sit high enough to survive
		// both. Do not describe it as a guard on tuning — it is a guard on vocabulary
		// collisions that need a big corpus to appear.
		//
		// Composition is the realistic one: 40 knowledge files and 460 daily archives.
		// Filler aliases must be lexically disjoint, not alpha10/alpha11 (one edit).
		// Correct case normalization exposed that old synthetic family as a genuine fuzzy
		// collision. Deterministic hashes avoid accidentally testing shared aliases.
		const bank = fs.mkdtempSync(path.join(os.tmpdir(), "memory-500-"));
		const put = (rel: string, content: string) => {
			const full = path.join(bank, rel);
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, content, "utf-8");
		};
		for (const [name, content] of Object.entries(FILE)) put(`knowledge/${name}.md`, content);
		for (let i = 0; i < 34; i++) {
			const aliases = Array.from({ length: 4 }, (_, j) => createHash("sha256").update(`filler:${i}:${j}`).digest("hex").slice(0, 16));
			put(
				`knowledge/filler-${i}.md`,
				`# Topic ${i} (${aliases.join(", ")})\n\nGuidance about topic ${i}, written as a paragraph with a few ordinary sentences.\n`,
			);
		}
		const words = ["session", "bank", "test", "refactor", "bug", "release", "config", "index", "docs", "cache"];
		for (let d = 0; d < 460; d++) {
			const day = new Date(Date.UTC(2023, 0, 1) + d * 86400000).toISOString().slice(0, 10);
			put(
				`history/daily/${day.slice(0, 7)}/${day}-dailyContext.md`,
				`## ${day}\n\n### Completed\n- closed the ${words[d % 10]} item and updated the ${words[(d + 3) % 10]} notes\n\n### Key Decisions\n- keep the ${words[(d + 2) % 10]} behaviour, the ${words[(d + 7) % 10]} path covers it\n`,
			);
		}
		const big = new MemoryIndex(bank);
		const built = (() => {
			const t = Date.now();
			const n = big.build();
			expect(Date.now() - t, "disaster bound, not a performance target: measured 32 ms").toBeLessThan(2000);
			return n;
		})();
		expect(built).toBe(500);

		// Recall, which is the assertion worth having: the wanted file does not merely
		// survive the top-3 cut, it stays first, as it is in the six-file bank above.
		for (const [want, prompt] of [
			["react", "my react form submits twice when I click save, how do I stop that"],
			["postgres", "how do I add a column to a large postgres table without taking downtime"],
			["tailwind", "dark mode does not apply to my modal, I use tailwind"],
			["concurrency", "two sessions wrote to the same notes file and one edit disappeared"],
			["python", "this python loop over 100k rows is slow, what should I measure first"],
		] as const) {
			const paths = big
				.searchForContext(prompt, 3, undefined, { includeKnowledge: true, includeHistory: true })
				.map((h) => h.path);
			expect(paths[0], `${prompt}\nactual: ${paths.join(", ")}`).toBe(`knowledge/${want}.md`);
			// Archives cannot crowd a good knowledge hit out, and the reason is
			// structural: a history file needs half the top score, and the top score here
			// is a title match. Rewriting these archives to use the prompts' own words does
			// not change this. So the trigger "all three injected files were archives" can
			// only fire when no knowledge file scores — which makes it a signal that the
			// bank is empty on the subject, not that archives are too greedy.
			expect(paths.filter((p) => p.startsWith("history/")).length).toBe(0);
		}

		// Drift in doctor's topic check: 0.35 was measured on a small bank, so prove the
		// number is not a small-bank artefact. Files with disjoint aliases must stay far
		// below it however many of them there are. Mirrors TOPIC_OVERLAP_RATIO in index.ts
		// (not exported), as the probe in overlappingTopics computes it.
		let worst = 0, worstPair = "";
		for (const f of fs.readdirSync(path.join(bank, "knowledge"))) {
			const rel = `knowledge/${f}`;
			const content = fs.readFileSync(path.join(bank, rel), "utf-8");
			const hits = big.search(extractTitle(content, f), 5);
			const own = hits.find((h) => h.path === rel)?.score ?? 0;
			if (own <= 0) continue;
			for (const hit of hits) {
				if (hit.path === rel || !hit.path.startsWith("knowledge/")) continue;
				if (hit.score / own > worst) { worst = hit.score / own; worstPair = `${rel} / ${hit.path}`; }
			}
		}
		expect(worst, `two unrelated knowledge files look like the same topic at 500 documents: ${worstPair}`).toBeLessThan(0.35);

		fs.rmSync(bank, { recursive: true, force: true });
	});

	it("keeps a secondary knowledge file that contradicts the top hit", () => {
		// This is why there is no "over half the top score" rule for knowledge. Two
		// records about one reversed decision score 16.9 and 16.5 here, and 115
		// against 52 in the recency fixtures — 0.45 of the top. A bar that removed
		// filler at 0.34 would remove the newer record at 0.45, and the point of
		// injecting both is that the model sees the contradiction.
		// Its own two-file bank: with six other files in the corpus, the top-3
		// candidate cut decides before any rule does, and that is not what is under
		// test here.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-contradiction-"));
		const put = (rel: string, content: string) => {
			const full = path.join(dir, rel);
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, content, "utf-8");
		};
		put("knowledge/background-blue.md", "# App background (background, color, app, blue)\n\nDecided Monday: the app background is blue.\n");
		put("knowledge/background-green.md", "# App background change (background, color, app, green)\n\nDecided Tuesday: the app background is green.\n");
		const both = new MemoryIndex(dir);
		both.build();
		const hits = both.searchForContext("what color should the app background be", 3, undefined, { includeKnowledge: true, includeHistory: false });
		fs.rmSync(dir, { recursive: true, force: true });
		const paths = hits.map((h) => h.path);
		expect(paths).toContain("knowledge/background-blue.md");
		expect(paths).toContain("knowledge/background-green.md");
	});

	it("has no transportable score scale", () => {
		// The measurement behind "there is no minimum score". One file, one prompt,
		// banks of different sizes: the score roughly quadruples while the ratio
		// between a relevant prompt and a noise prompt stays near nine. So the
		// separation is real and the magnitude is not a quantity you can pin down
		// once for every bank. A constant floor therefore either admits noise in a
		// big bank or hides the answer in a small one.
		const prompt = "two sessions wrote to the same notes file and one edit disappeared";
		const noise = "why does my docker image rebuild every layer when I change one file";
		const scores: number[] = [];
		const ratios: number[] = [];
		for (const n of [1, 6, 30]) {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-scale-"));
			const put = (rel: string, content: string) => {
				const full = path.join(dir, rel);
				fs.mkdirSync(path.dirname(full), { recursive: true });
				fs.writeFileSync(full, content, "utf-8");
			};
			put("knowledge/concurrency.md", FILE.concurrency);
			for (let i = 0; i < n - 1; i++) put(`knowledge/topic-${i}.md`, `# Topic ${i} (subject ${i}, area ${i}, notes ${i})\n\nGuidance about subject ${i}.\n`);
			const idx = new MemoryIndex(dir);
			idx.build();
			const hit = idx.search(prompt, 3).find((r) => r.path === "knowledge/concurrency.md");
			const top = idx.search(noise, 1)[0];
			scores.push(hit?.score ?? 0);
			ratios.push((hit?.score ?? 0) / (top?.score ?? 1));
			fs.rmSync(dir, { recursive: true, force: true });
		}
		expect(scores[2] / scores[0]).toBeGreaterThan(3);
		expect(ratios[0] / ratios[2]).toBeLessThan(2);
	});

	it("is a bar on a second history file, not on history itself", () => {
		// What the rule really does, found by measuring it. The bar is half the top
		// *eligible* score, and a daily file is very often the top eligible candidate —
		// so the leading daily file is compared with itself and admits at any absolute
		// score. Measured across six prompts, its ratio was 1.00 every time. The rule is
		// not a relevance floor for history; it is a "do not bring a second archive along"
		// rule, and it only starts deciding things once knowledge leads.
		//
		// The bank is the shape the guidelines produce: alias-titled knowledge files and
		// two daily files of short ordinary bullets, which is a high density of function
		// words. Scores were re-measured here after queries began ignoring those words.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-history-"));
		const put = (rel: string, content: string) => {
			const full = path.join(dir, rel);
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, content, "utf-8");
		};
		put("knowledge/concurrency.md", FILE.concurrency);
		put("knowledge/postgres.md", FILE.postgres);
		put("knowledge/reversal.md", FILE.reversal);
		put(
			"history/daily/2026-10/2026-10-20-dailyContext.md",
			"## 2026-10-20\n\n### Completed\n- moved the shared bank off the laptop and set PI_MEMORY_DIR\n- wrote up the rollover bug where a future date archived the wrong day\n\n### Key Decisions\n- the injection cap for core files is 300 lines\n",
		);
		put(
			"history/daily/2026-10/2026-10-26-dailyContext.md",
			"## 2026-10-26\n\n### Completed\n- memory_update now refuses a write whose base moved, so two sessions no longer overwrite each other\n- added npm run race to measure what sharing one bank costs\n\n### Key Decisions\n- guard the copy in hand: no lock files, no merging, no shared index\n",
		);
		const bank = new MemoryIndex(dir);
		bank.build();
		const ask = (q: string) =>
			bank.searchForContext(q, 3, undefined, { includeKnowledge: true, includeHistory: true }).map((h) => h.path);
		const D20 = "history/daily/2026-10/2026-10-20-dailyContext.md";
		const D26 = "history/daily/2026-10/2026-10-26-dailyContext.md";

		// Asked about the past, and the answer is in the past: found, at a low absolute
		// score (8.7) and at ratio 1.00. This is the regression check for the function-word
		// change — daily files are the ones that lost the most score.
		for (const [q, want] of [
			["which day did I move the shared bank and set PI_MEMORY_DIR", D20],
			["what did we do about the rollover archiving a future date", D20],
			["what did I do yesterday about the injection cap", D20],
		] as const) {
			expect(ask(q), q).toContain(want);
		}

		// Knowledge leads, so the bar decides, and it decides differently for the two
		// archives here: 0.81 admits and 0.28 does not. This is the only place the rule can
		// act, and the flip is small — in a scratch bank with a longer daily file the second
		// archive went from 0.51 (admitted, riding along) to 0.47 (not) when queries stopped
		// matching function words.
		const knowledgeLeads = ask("two sessions wrote the same file and one edit disappeared");
		expect(knowledgeLeads).toContain("knowledge/concurrency.md");
		expect(knowledgeLeads.filter((p) => p.startsWith("history/"))).toEqual([D26]);

		// A prompt about nothing in the bank used to admit an archive at ratio 0.82 — high
		// ratio, no relevance, because a ratio inherits nothing about what the files are about.
		// This assertion fails against the code before the function-word change; it is the
		// gain, pinned.
		expect(ask("what should I name this variable that holds the last login time").filter((p) => p.startsWith("history/"))).toEqual([]);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("does not admit history merely because knowledge was cut", () => {
		// The two admission rules are independent. Knowledge looks for relevance;
		// history only has to beat half the top eligible score, which is a weaker test
		// than it sounds — see the test above.
		const hits = index.searchForContext("which day did I move the shared bank and set PI_MEMORY_DIR", 3, undefined, {
			includeKnowledge: true,
			includeHistory: true,
		});
		expect(hits.map((h) => h.path)).toContain("history/daily/2026-10/2026-10-20-dailyContext.md");
	});
});

/**
 * Prints the table with scores: `EVAL_REPORT=1 npx vitest run injection-eval`.
 * This is how the two rejected rules in the header note were measured, and how
 * anyone can re-measure them after changing the scorer or the fixtures.
 */
it.skipIf(!process.env.EVAL_REPORT)("report", () => {
	const lines: string[] = [];
	for (const c of CASES) {
		const rows = index.search(c.prompt, 6).map((r) => `${r.path.replace("knowledge/", "")} ${r.score.toFixed(0)}`);
		const wanted = c.expect === "none" ? "NONE" : `WANT ${c.expect}`;
		lines.push(`${wanted.padEnd(14)} ${c.prompt.slice(0, 52).padEnd(54)} ${rows.slice(0, 3).join(" | ")}`);
	}
	fs.writeFileSync("/tmp/injection-eval.txt", lines.join("\n") + "\n");
});
