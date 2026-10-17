import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, applyConfig, describeConfig, loadConfig } from "./config.ts";
import { bankPaths } from "./store.ts";

function scratchFile(): { file: string; paths: ReturnType<typeof bankPaths>; cleanup: () => void } {
	// bankPaths canonicalises, so the temp dir has to be canonical too or the
	// warning paths will not line up.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "memory-config-")));
	return { file: join(dir, "config.json"), paths: bankPaths(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("config: the defaults are the spec's defaults", () => {
	assert.deepEqual(DEFAULT_CONFIG, {
		budgetTokens: 2000,
		coreTokens: 600,
		dailyTokens: 500,
		maxRetrievedClaims: 6,
		pendingFlagDays: 14,
		inlineConflictDialog: false,
		ranker: "bm25",
		searchLimit: 12,
	});
});

test("config: no file means defaults and no warning", () => {
	const { paths, cleanup } = scratchFile();
	try {
		const result = loadConfig(paths);
		assert.deepEqual(result.config, DEFAULT_CONFIG);
		assert.deepEqual(result.warnings, []);
	} finally {
		cleanup();
	}
});

test("config: a partial file keeps the other defaults", () => {
	const { file, paths, cleanup } = scratchFile();
	try {
		writeFileSync(file, JSON.stringify({ budgetTokens: 1200, inlineConflictDialog: true }));
		const result = loadConfig(paths);
		assert.deepEqual(result.config, { ...DEFAULT_CONFIG, budgetTokens: 1200, coreTokens: 600, dailyTokens: 500, inlineConflictDialog: true });
		assert.deepEqual(result.warnings, []);
	} finally {
		cleanup();
	}
});

test("config: every invalid value falls back to its default with a warning", () => {
	const { file, paths, cleanup } = scratchFile();
	try {
		writeFileSync(
			file,
			JSON.stringify({
				budgetTokens: "big",
				coreTokens: -5,
				maxRetrievedClaims: -1,
				pendingFlagDays: 0,
				searchLimit: 5000,
				inlineConflictDialog: "yes",
				ranker: "",
				nonsense: 1,
			}),
		);
		const result = loadConfig(paths);
		assert.deepEqual(result.config, DEFAULT_CONFIG);
		assert.deepEqual(result.warnings, [
			`${file}: budgetTokens must be a whole number — using 2000`,
			`${file}: coreTokens=-5 is outside 0..20000 — using 600`,
			`${file}: maxRetrievedClaims=-1 is outside 0..200 — using 6`,
			`${file}: pendingFlagDays=0 is outside 1..3650 — using 14`,
			`${file}: searchLimit=5000 is outside 1..100 — using 12`,
			`${file}: inlineConflictDialog must be true or false — using false`,
			`${file}: ranker must be a name — using "bm25"`,
			`${file}: unknown setting "nonsense" — ignored`,
		]);
	} finally {
		cleanup();
	}
});

test("config: broken JSON means defaults, said once", () => {
	const { file, paths, cleanup } = scratchFile();
	try {
		writeFileSync(file, "{ budgetTokens: 900,");
		const result = loadConfig(paths);
		assert.deepEqual(result.config, DEFAULT_CONFIG);
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0]!, /is not valid JSON.*every default is in use/);
		writeFileSync(file, "[1,2,3]");
		assert.match(loadConfig(paths).warnings[0]!, /must hold a JSON object/);
	} finally {
		cleanup();
	}
});

test("config: sections that do not fit the budget are capped, and it is said", () => {
	const { file, paths, cleanup } = scratchFile();
	try {
		writeFileSync(file, JSON.stringify({ budgetTokens: 500, coreTokens: 400, dailyTokens: 400 }));
		const result = loadConfig(paths);
		assert.deepEqual(result.config.coreTokens, 400);
		assert.deepEqual(result.config.dailyTokens, 100);
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0]!, /coreTokens \(400\) \+ dailyTokens \(400\) exceed budgetTokens \(500\)/);
	} finally {
		cleanup();
	}
});

test("config: the recall cap is validated, and 0 means the budget is the only limit (R27.4)", () => {
	const { file, paths, cleanup } = scratchFile();
	try {
		writeFileSync(file, JSON.stringify({ maxRetrievedClaims: 0 }));
		const off = loadConfig(paths);
		assert.equal(off.config.maxRetrievedClaims, 0);
		assert.deepEqual(off.warnings, []);

		writeFileSync(file, JSON.stringify({ maxRetrievedClaims: "few" }));
		const words = loadConfig(paths);
		assert.equal(words.config.maxRetrievedClaims, DEFAULT_CONFIG.maxRetrievedClaims);
		assert.deepEqual(words.warnings, [`${file}: maxRetrievedClaims must be a whole number — using 6`]);
	} finally {
		cleanup();
	}
});

test("config: describeConfig says what a session will actually get", () => {
	assert.equal(
		describeConfig({ ...DEFAULT_CONFIG, budgetTokens: 1000, coreTokens: 300, dailyTokens: 200 }),
		"budget 1000 tokens (core 300, daily 200, retrieved 500), retrieved claims at most 6 per turn, pending flag after 14 days, inline conflict dialog off, ranker bm25",
	);
	assert.match(describeConfig({ ...DEFAULT_CONFIG, maxRetrievedClaims: 0 }), /retrieved claims at most unbounded per turn/);
});

test("config: applyConfig is usable without a file, for tests and /memory config", () => {
	const result = applyConfig({ budgetTokens: 900 }, "<inline>");
	assert.equal(result.config.budgetTokens, 900);
	assert.equal(result.config.coreTokens + result.config.dailyTokens, 900, "its sections fit the budget it was given");
	assert.match(result.warnings[0]!, /exceed budgetTokens/);
});
