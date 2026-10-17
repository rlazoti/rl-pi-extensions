import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, SETTINGS, applyConfig, configTemplate, describeConfig, describeSettings, loadConfig } from "./config.ts";
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

test("config: the settings table is the validator — the same keys and the same bounds (R48)", () => {
	assert.deepEqual(
		SETTINGS.map((setting) => setting.key).sort(),
		Object.keys(DEFAULT_CONFIG).sort(),
		"one row per setting: none missing, none invented",
	);
	assert.deepEqual(
		SETTINGS.filter((setting) => !setting.range).map((setting) => setting.key),
		["inlineConflictDialog", "ranker"],
		"only the non-numeric settings have no numeric bound",
	);

	for (const setting of SETTINGS) {
		assert.ok(setting.meaning.length > 0 && !setting.meaning.includes("\n"), `${setting.key} explains itself in one line`);
		if (!setting.range) continue;
		const { min, max } = setting.range;
		for (const accepted of [min, max]) {
			const result = applyConfig(storeAlongside(setting.key, accepted), "<inline>");
			assert.equal(result.config[setting.key], accepted, `${setting.key} accepts ${accepted}`);
			assert.deepEqual(result.warnings, [], `${setting.key}=${accepted} is inside its range, so nothing is reported`);
		}
		for (const refused of [min - 1, max + 1]) {
			const result = applyConfig(storeAlongside(setting.key, refused), "<inline>");
			assert.equal(result.config[setting.key], DEFAULT_CONFIG[setting.key], `${setting.key}=${refused} falls back`);
			assert.deepEqual(result.warnings, [`<inline>: ${setting.key}=${refused} is outside ${min}..${max} — using ${DEFAULT_CONFIG[setting.key]}`]);
		}
	}
});

/** A store that names one setting, plus the neighbours that keep the section interlock (R27) out of the way. */
function storeAlongside(key: string, value: number): Record<string, number> {
	const store: Record<string, number> = { [key]: value };
	if (key === "budgetTokens") {
		store.coreTokens = 0;
		store.dailyTokens = 0;
	}
	if (key === "coreTokens" || key === "dailyTokens") {
		store.budgetTokens = 20_000;
		store[key === "coreTokens" ? "dailyTokens" : "coreTokens"] = 0;
	}
	return store;
}

test("config: the result says which value the file set, which is a default, and which the interlock moved", () => {
	const moved = applyConfig({ maxRetrievedClaims: 2, budgetTokens: 500, coreTokens: 400, dailyTokens: 400 }, "<inline>");
	assert.deepEqual(moved.explicit, ["maxRetrievedClaims", "budgetTokens", "coreTokens", "dailyTokens"]);
	assert.deepEqual(moved.capped, ["dailyTokens"], "core kept its share; daily lost 300 tokens to fit the budget");
	assert.equal(moved.config.dailyTokens, 100);

	const refused = applyConfig({ pendingFlagDays: 0, nonsense: 1 }, "<inline>");
	assert.deepEqual(refused.explicit, [], "a refused value never reads as set");
	assert.deepEqual(refused.capped, []);
});

test("config: the settings listing shows every knob, its default, its range and where its value came from (R48)", () => {
	const { file, paths, cleanup } = scratchFile();
	try {
		const bare = describeSettings(loadConfig(paths), { file, present: false });
		assert.match(bare, /config\.json — not present, so every value below is a default/);
		assert.match(bare, /0 means no cap/, "a boundary value says what it means");
		for (const setting of SETTINGS) {
			const line = rowOf(bare, setting.key);
			assert.ok(line, `${setting.key} has a row`);
			assert.ok(line!.includes(String(DEFAULT_CONFIG[setting.key])), `${setting.key} shows its default`);
			assert.match(line!, /default\s/, `${setting.key} says its value in use is the default`);
			if (setting.range) assert.ok(line!.includes(`${setting.range.min}..${setting.range.max}`), `${setting.key} shows the range the validator enforces`);
		}
		const derived = rowOf(bare, "retrieved")!;
		assert.ok(derived.includes(String(DEFAULT_CONFIG.budgetTokens - DEFAULT_CONFIG.coreTokens - DEFAULT_CONFIG.dailyTokens)));
		assert.match(derived, /derived/, "the number the caps actually leave is shown as derived, not as a setting");

		writeFileSync(file, JSON.stringify({ maxRetrievedClaims: 1, budgetTokens: 2000, coreTokens: 1800, dailyTokens: 500, typo: true }));
		const edited = describeSettings(loadConfig(paths), { file, present: true });
		assert.ok(edited.includes(`config file: ${file}`), "the listing names the file it read");
		assert.match(edited, /hand-editable: the next turn reads it, no restart/);
		assert.match(rowOf(edited, "maxRetrievedClaims")!, /\bfile\s/, "a value the file set reads as set, not as a default");
		assert.equal(rowOf(edited, "maxRetrievedClaims")!.includes("0..200"), true);
		assert.equal(rowOf(edited, "dailyTokens")!.includes("200"), true, "the number in use is the capped one, not the one written");
		assert.match(rowOf(edited, "dailyTokens")!, /capped/);
		assert.match(edited, /warning: .*unknown setting "typo"/);
		assert.match(rowOf(edited, "retrieved")!, /derived/);
	} finally {
		cleanup();
	}
});

function rowOf(text: string, name: string): string | undefined {
	return text.split("\n").find((line) => line.startsWith(name));
}

test("config: the absent-file listing carries a paste-ready template, and a key left out keeps its default (R49)", () => {
	const { file, paths, cleanup } = scratchFile();
	try {
		const bare = describeSettings(loadConfig(paths), { file, present: false });
		const template = configTemplate();
		assert.ok(bare.includes(template), "the listing carries the template verbatim");
		assert.match(bare, /only the keys you want — a key you leave out keeps its default/);
		assert.match(bare, /This listing writes nothing/);
		assert.match(bare, /pins every default above as of today/);

		const parsed = JSON.parse(template) as Record<string, unknown>;
		assert.deepEqual(
			Object.keys(parsed).sort(),
			SETTINGS.map((setting) => setting.key).sort(),
			"the template names every setting and nothing else",
		);
		for (const setting of SETTINGS) {
			assert.deepEqual(parsed[setting.key], DEFAULT_CONFIG[setting.key], `${setting.key} shows the default the validator uses`);
		}

		// One key is a complete file: the rest stay defaults, with nothing reported.
		writeFileSync(file, JSON.stringify({ maxRetrievedClaims: 2 }));
		const oneKey = loadConfig(paths);
		assert.deepEqual(oneKey.warnings, []);
		assert.deepEqual(oneKey.explicit, ["maxRetrievedClaims"]);
		assert.equal(oneKey.config.budgetTokens, DEFAULT_CONFIG.budgetTokens, "an absent key is still the default");

		// The template is real config, not a commented sketch: pasted whole it loads clean.
		writeFileSync(file, `${template}\n`);
		const whole = loadConfig(paths);
		assert.deepEqual(whole.warnings, []);
		const pinned = describeSettings(whole, { file, present: true });
		assert.ok(!pinned.includes(template), "a file that exists gets no template");
		for (const setting of SETTINGS) {
			assert.match(rowOf(pinned, setting.key)!, /\bfile\s/, `${setting.key} now reads as a choice, not a default`);
		}
	} finally {
		cleanup();
	}
});

test("config: the settings listing speaks to a person, not to the spec (R49.2)", () => {
	const { file, paths, cleanup } = scratchFile();
	try {
		const listing = describeSettings(loadConfig(paths), { file, present: false });
		for (const line of listing.split("\n")) {
			assert.ok(!/\bR\d/.test(line), `no requirement ID on screen: ${line}`);
		}
		for (const setting of SETTINGS) {
			assert.match(setting.spec, /^R\d+(\.\d+)?$/, `${setting.key} still names the requirement it serves, off screen`);
			assert.ok(setting.meaning.length > 0 && !setting.meaning.includes("("), `${setting.key} explains itself without parenthetical IDs`);
		}
	} finally {
		cleanup();
	}
});
