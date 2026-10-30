/**
 * The acceptance criterion: 0 false positives over ~13,000 real bash commands,
 * and every hand-labelled broad scan among them caught.
 *
 * The corpus is the set of `bash` commands this machine's Pi sessions actually
 * ran — 13,084 of them at the time of writing — exported by
 * `scripts/export-bash-corpus.mjs`. The answer key is
 * `tests/fixtures/scan-guard-labels.json`, which is committed because it is a
 * judgement; the commands are not committed, because they are whatever those
 * sessions happened to type.
 *
 * So this test skips when the fixture is missing rather than failing: on a fresh
 * checkout there is nothing to measure, and a skipped test that prints how to
 * generate the data is honest, while a red one is noise. Run
 * `node scripts/export-bash-corpus.mjs` to produce it.
 *
 * Two numbers, published in the README and never averaged into one:
 *
 *   false positives   commands the guard flagged that no human called a broad
 *                     scan. The target is zero, and precision beats recall here
 *                     on purpose: a guard with one false positive in 13,000
 *                     commands gets switched off within a day.
 *   recall            the labelled scans it flagged. Missed ones are listed.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MAX_CHEAP_DEPTH, verdictForCommand, type ScanEnv } from "./classify.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const FIXTURE = join(REPO, "tests", "fixtures", "bash-commands.jsonl");
const LABELS = join(REPO, "tests", "fixtures", "scan-guard-labels.json");
const HOME = homedir();

interface Record_ {
	id: string;
	cmd: string;
	cwd: string;
	dur_ms: number | null;
	broad: boolean;
}

const unscrub = (p: string) => (p === "$HOME" ? HOME : p.startsWith("$HOME/") ? HOME + p.slice(5) : p);

const have = existsSync(FIXTURE) && existsSync(LABELS);
const skip = have ? false : `corpus not generated: run node scripts/export-bash-corpus.mjs (looked in ${FIXTURE})`;

function load(): { records: Record_[]; labels: Record<string, string> } {
	const labels = JSON.parse(readFileSync(LABELS, "utf-8")).broad as Record<string, string>;
	const records = readFileSync(FIXTURE, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record_);
	return { records, labels };
}

describe("the corpus of real bash commands", { skip }, () => {
	const { records, labels } = load();
	const home = HOME;

	function envFor(record: Record_): ScanEnv {
		const cwd = unscrub(record.cwd);
		return {
			cwd,
			home,
			hasFd: true,
			scopedRoots: [cwd, join(home, "Projects"), join(home, ".pi"), join(home, "Downloads")],
		};
	}

	it("has a label for every command the loose net found, and no stale labels", () => {
		const ids = new Set(records.map((r) => r.id));
		const stale = Object.keys(labels).filter((id) => !ids.has(id));
		assert.deepEqual(stale, [], "labels point at commands that are no longer in the corpus — re-decide them, do not carry them");
		const labelled = records.filter((r) => r.broad).length;
		assert.equal(labelled, Object.keys(labels).length, "the fixture and the answer key disagree — regenerate the fixture");
	});

	it("flags every labelled broad scan and nothing else, and is fast enough to run on every tool call", () => {
		let falsePositives: Record_[] = [];
		let misses: Record_[] = [];
		let blocks = 0;
		let warns = 0;
		const started = Date.now();

		for (const record of records) {
			let action: string;
			try {
				action = verdictForCommand(record.cmd, envFor(record)).action;
			} catch (error) {
				// A throw is the worst possible outcome — it would freeze the session's
				// shell via the fail-safe — so it fails the run loudly.
				assert.fail(`threw on ${record.id}: ${(error as Error).message}\\n${record.cmd.slice(0, 200)}`);
			}
			if (record.broad) {
				if (action === "allow") misses.push(record);
				else if (action === "block") blocks++;
				else warns++;
			} else if (action !== "allow") {
				falsePositives.push(record);
			}
		}

		const elapsed = Date.now() - started;
		const ordinary = records.length - records.filter((r) => r.broad).length;
		// The two numbers, printed every run: they are the thing the README claims.
		console.log(
			`    corpus: ${records.length} unique commands (${ordinary} ordinary) · ` +
				`false positives ${falsePositives.length}/${ordinary} · ` +
				`recall ${records.filter((r) => r.broad).length - misses.length}/${records.filter((r) => r.broad).length} ` +
				`(${blocks} blocked, ${warns} warned) · ${elapsed} ms`,
		);

		assert.deepEqual(
			falsePositives.map((r) => ({ id: r.id, cmd: r.cmd.slice(0, 160), cwd: r.cwd })),
			[],
			"one false positive in 13,000 commands is a guard that gets switched off",
		);
		assert.deepEqual(
			misses.map((r) => ({ id: r.id, cmd: r.cmd.slice(0, 160) })),
			[],
			"a labelled broad scan slipped through",
		);
		// A `tool_call` hook runs before every bash call in the session, so the shape
		// of the parse matters: a quadratic scan would show up here. The bound is
		// deliberately ~20× the observed 0.4 s, because this file runs alongside
		// every other test file and a timing assertion that fails under load is
		// noise, not a measurement — the number printed above is the measurement.
		assert.ok(elapsed < 10_000, `the corpus took ${elapsed} ms — the classifier is on every bash call`);
	});

	it("has enough breadth that 0 false positives means something", () => {
		// A guard measured against ten commands is not measured.
		assert.ok(records.length > 10_000, `${records.length} commands is too few to claim precision`);
		const withFind = records.filter((r) => /\b(find|fd)\b/.test(r.cmd)).length;
		assert.ok(withFind > 400, `only ${withFind} commands mention find/fd — the hard cases are under-represented`);
		// The labelled set must contain both verdicts, or the depth rule is untested.
		const depths = records.filter((r) => r.broad).map((r) => (/-maxdepth (\d+)/.exec(r.cmd) ?? [])[1]);
		assert.ok(depths.some((d) => d !== undefined && Number(d) <= MAX_CHEAP_DEPTH), "no bounded broad scan in the corpus");
		assert.ok(depths.some((d) => d === undefined), "no unbounded broad scan in the corpus");
	});

	it("never throws on any command in the corpus, whatever it is", () => {
		for (const record of records) {
			assert.doesNotThrow(() => verdictForCommand(record.cmd, envFor(record)), record.cmd.slice(0, 120));
		}
	});
});
