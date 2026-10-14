import assert from "node:assert/strict";
import test from "node:test";
import { parseTopicFile, isInjectable, compareAuthority, type MemoryEntry, type TopicFile } from "./schema.ts";
import {
	buildStore,
	globMatches,
	isWellFormed,
	planInjection,
	resolveAll,
	resolveIdentity,
	resolveKey,
	scopeApplies,
	type AuthorityResolution,
	type MemoryStore,
} from "./resolver.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function storeFrom(...sources: Array<{ path: string; text: string }>): MemoryStore {
	return buildStore(sources.map((source) => parseTopicFile(source.text, source.path)));
}

function entryOf(store: MemoryStore, heading: string, scopeRaw?: string): MemoryEntry {
	const matches = store.entries.filter(
		(entry) => entry.heading === heading && (scopeRaw === undefined || entry.scope.raw === scopeRaw),
	);
	assert.equal(matches.length, 1, `exactly one entry named ${heading}${scopeRaw ? `@${scopeRaw}` : ""}, got ${matches.length}`);
	return matches[0]!;
}

/** A healthy store: one authority plus its supersede chain. */
function chainStore() {
	return storeFrom({
		path: "knowledge/ui.md",
		text: `# UI

## ui.background
- kind: preference
- scope: global
- asOf: 2026-10-02
- source: PR review
- status: active
Dark grey.

## ui.background@2026-06-14
- kind: preference
- scope: global
- asOf: 2026-06-14
- source: Slack
- status: superseded
- supersedes: ui.background@2026-05-01
Navy.

## ui.background@2026-05-01
- kind: preference
- scope: global
- asOf: 2026-05-01
- status: superseded
Black.
`,
	});
}

/** The exact failure the store must make impossible: three live claims. */
function conflictStore() {
	return storeFrom({
		path: "knowledge/ui.md",
		text: `# UI

## ui.background
- scope: global
- asOf: 2026-10-02
- status: active
Dark grey.

## ui.background@2026-06-14
- scope: global
- asOf: 2026-06-14
- status: active
Navy.

## ui.background@2026-05-01
- scope: global
- asOf: 2026-05-01
- status: active
Black.
`,
	});
}

function codes(items: { code?: string }[]): string[] {
	return items.map((item) => item.code ?? "");
}

// ─── Store construction ─────────────────────────────────────────────────────

test("buildStore groups by identity and indexes identities per assertion key", () => {
	const store = chainStore();
	assert.equal(store.entries.length, 3);
	assert.equal(store.byIdentity.size, 1, "the whole chain is one identity");
	assert.equal(store.byKey.get("ui.background")?.length, 1);
	assert.deepEqual(store.violations, []);
});

test("buildStore puts unkeyed entries aside and reports them as violations", () => {
	const store = storeFrom({
		path: "knowledge/legacy.md",
		text: `# Legacy\n\n## Branch Naming Convention\nAll branches use rl-MM-DD-slug.\n`,
	});
	assert.equal(store.unkeyed.length, 1);
	assert.equal(store.byIdentity.size, 0);
	assert.deepEqual(codes(store.violations), ["unkeyed-entry"]);
});

test("buildStore reports duplicate-identity once per active claimant", () => {
	const store = conflictStore();
	const duplicates = store.violations.filter((violation) => violation.code === "duplicate-identity");
	assert.equal(duplicates.length, 3, "all three active claims are reported");
	for (const violation of duplicates) {
		assert.equal(violation.key, "ui.background");
		assert.equal(violation.scope, "global");
	}
});

test("a malformed scope lands in unkeyed rather than being laundered into global", () => {
	const store = storeFrom({ path: "knowledge/ui.md", text: `# UI\n\n## ui.background\n- scope: host:work\n- asOf: 2026-10-01\nGrey.\n` });
	assert.deepEqual(codes(store.violations), ["unkeyed-entry"]);
	assert.equal(store.unkeyed.length, 1);
	assert.equal(store.byIdentity.size, 0, "it cannot join the identity it might have belonged to");
});

test("buildStore reports identity-bearing but error-flagged entries as invalid-entry", () => {
	const store = storeFrom({ path: "knowledge/ui.md", text: `# UI\n\n## ui.background\n- scope: global\n- asOf: last tuesday\nGrey.\n` });
	assert.deepEqual(codes(store.violations), ["invalid-entry"]);
	assert.equal(store.unkeyed.length, 0);
});

test("buildStore reports a supersedes reference that names no sibling heading", () => {
	const store = storeFrom({
		path: "knowledge/ui.md",
		text: `# UI\n\n## ui.background\n- scope: global\n- asOf: 2026-10-02\n- supersedes: ui.background@1999-01-01\nGrey.\n`,
	});
	assert.deepEqual(codes(store.violations), ["dangling-supersedes"]);
});

test("buildStore reports a supersede cycle and does not hang", () => {
	const store = storeFrom({
		path: "knowledge/ui.md",
		text: `# UI

## ui.background@2026-06-14
- scope: global
- asOf: 2026-06-14
- status: superseded
- supersedes: ui.background@2026-05-01
Navy.

## ui.background@2026-05-01
- scope: global
- asOf: 2026-05-01
- status: superseded
- supersedes: ui.background@2026-06-14
Black.
`,
	});
	const cycles = store.violations.filter((violation) => violation.code === "supersede-cycle");
	assert.equal(cycles.length, 2, "both links of the loop are reported");
	assert.deepEqual(codes(store.violations), ["supersede-cycle", "supersede-cycle"]);
});

// ─── Gate 1: one authority per identity ─────────────────────────────────────

test("a supersede chain resolves to its newest active entry", () => {
	const store = chainStore();
	const resolution = resolveIdentity(store, store.byIdentity.keys().next().value as string)!;
	assert.equal(resolution.winner?.heading, "ui.background");
	assert.equal(resolution.winner?.body, "Dark grey.");
	assert.deepEqual(resolution.dropped.map((drop) => drop.reason), ["superseded", "superseded"]);
	assert.equal(resolution.ambiguous, false);
});

test("a broken identity fails closed: nothing is injected, the likely authority is kept for the human", () => {
	const store = conflictStore();
	const resolution = resolveAll(store)[0]!;
	assert.equal(resolution.ambiguous, true, "three live claims on one identity");
	assert.equal(resolution.winner, null, "guessing one is exactly the ambiguity this extension removes");
	assert.equal(resolution.bestCandidate?.heading, "ui.background", "newest is the suggestion, not the answer");
	assert.deepEqual(resolution.dropped.map((drop) => drop.reason), ["conflict", "conflict", "conflict"]);
});

test("a malformed claim cannot beat a valid one and does not poison its identity", () => {
	const store = storeFrom({
		path: "knowledge/ui.md",
		text: `# UI

## ui.background
- scope: global
- asOf: last tuesday
- status: active
Grey, badly dated.

## ui.background@2026-05-01
- scope: global
- asOf: 2026-05-01
- status: active
Black.
`,
	});
	const resolution = resolveAll(store)[0]!;
	assert.equal(resolution.winner?.heading, "ui.background@2026-05-01", "the well-formed claim is still the authority");
	assert.deepEqual(resolution.dropped.map((drop) => drop.reason), ["invalid"]);
	assert.equal(resolution.ambiguous, false, "a broken entry is not a competing claim");
});

test("an identity whose every claim is historical yields no winner", () => {
	const store = storeFrom({
		path: "knowledge/ui.md",
		text: `# UI

## ui.background
- scope: global
- asOf: 2026-05-01
- status: withdrawn
Black, retracted.
`,
	});
	const resolution = resolveAll(store)[0]!;
	assert.equal(resolution.winner, null);
	assert.deepEqual(resolution.dropped.map((drop) => drop.reason), ["withdrawn"]);
});

test("resolveIdentity: unknown identity is null, and resolveAll is scan-order independent", () => {
	const store = chainStore();
	assert.equal(resolveIdentity(store, "nope\u0000global"), null);

	const A = { path: "knowledge/a.md", text: `# A\n\n## aa.key\n- scope: global\n- asOf: 2026-10-02\nA.\n` };
	const B = { path: "knowledge/b.md", text: `# B\n\n## bb.key\n- scope: global\n- asOf: 2026-09-01\nB.\n` };
	const flatten = (resolutions: AuthorityResolution[]) =>
		resolutions.map((resolution) => `${resolution.identity}=>${resolution.winner?.heading ?? "none"}`);

	assert.deepEqual(flatten(resolveAll(storeFrom(A, B))), flatten(resolveAll(storeFrom(B, A))));
	assert.deepEqual(flatten(resolveAll(storeFrom(A, B))), [
		"aa.key\u0000global=>aa.key",
		"bb.key\u0000global=>bb.key",
	]);
});

// ─── Glob and scope applicability ───────────────────────────────────────────

test("globMatches: ** spans segments, * and ? stay inside one, and matching is anchored", () => {
	assert.equal(globMatches("src/ui/**", "src/ui"), true, "a directory prefix matches");
	assert.equal(globMatches("src/ui/**", "src/ui/widgets/button.ts"), true);
	assert.equal(globMatches("src/ui/**", "src/api/router.ts"), false);
	assert.equal(globMatches("**/*.test.ts", "a.test.ts"), true, "** may match zero segments");
	assert.equal(globMatches("**/*.test.ts", "src/deep/nested/x.test.ts"), true);
	assert.equal(globMatches("**/*.test.ts", "src/deep/x.ts"), false);
	assert.equal(globMatches("*.ts", "a.ts"), true);
	assert.equal(globMatches("*.ts", "src/a.ts"), false, "no implicit leading **");
	assert.equal(globMatches("ui-?.ts", "ui-a.ts"), true);
	assert.equal(globMatches("ui-?.ts", "ui-ab.ts"), false);
});

test("globMatches treats regex punctuation as literal", () => {
	assert.equal(globMatches("a+b.ts", "a+b.ts"), true);
	assert.equal(globMatches("a+b.ts", "aab.ts"), false);
	assert.equal(globMatches("v1.2/*.ts", "v1x2/x.ts"), false, "dots are literal");
	assert.equal(globMatches("v1.2/*.ts", "v1.2/x.ts"), true);
});

test("scopeApplies: global always, project only when named, path only when a path matches", () => {
	const parse = (scope: string) => parseTopicFile(`# T\n\n## k\n- scope: ${scope}\n- asOf: 2026-10-01\nBody.\n`, "k.md").entries[0]!.scope;

	assert.equal(scopeApplies(parse("global"), {}), true);
	assert.equal(scopeApplies(parse("project:money-manager"), { project: "money-manager" }), true);
	assert.equal(scopeApplies(parse("project:money-manager"), { project: "rl-pi-extensions" }), false);
	assert.equal(scopeApplies(parse("project:money-manager"), {}), false, "no project context never matches a project rule");
	assert.equal(scopeApplies(parse("path:src/ui/**"), { paths: ["src/ui/button.ts"] }), true);
	assert.equal(scopeApplies(parse("path:src/ui/**"), { paths: ["src/api/router.ts"] }), false);
	assert.equal(scopeApplies(parse("path:src/ui/**"), {}), false);
	assert.equal(scopeApplies(parse("host:work"), { project: "money-manager", paths: ["src/ui/x.ts"] }), false, "malformed scope applies nowhere");
});

// ─── Gate 2: one authority per assertion key ────────────────────────────────

function scopeStore() {
	return storeFrom({
		path: "knowledge/ui.md",
		text: `# UI

## ui.background
- scope: global
- asOf: 2026-10-02
- status: active
Dark grey everywhere.

## ui.background
- scope: project:money-manager
- asOf: 2026-01-01
- status: active
Navy in this app.

## ui.background
- scope: path:src/ui/**
- asOf: 2025-01-01
- status: active
Navy in these files.
`,
	});
}

test("a project rule shadows the global default in its project — and both are kept in the trace", () => {
	const store = scopeStore();
	const plan = resolveKey(store, "ui.background", { project: "money-manager" })!;
	assert.equal(plan.winner?.body, "Navy in this app.", "specificity outranks recency");
	assert.deepEqual(
		plan.shadowed.map((item) => [item.reason, item.entry.body]),
		[["shadowed-by-scope", "Dark grey everywhere."]],
	);
	assert.deepEqual(
		plan.outOfScope.map((item) => [item.reason, item.entry.body]),
		[["out-of-scope", "Navy in these files."]],
	);
});

test("outside that project the global default is the authority again", () => {
	const store = scopeStore();
	const plan = resolveKey(store, "ui.background", { project: "rl-pi-extensions" })!;
	assert.equal(plan.winner?.body, "Dark grey everywhere.");
	assert.deepEqual(
		plan.outOfScope.map((item) => [item.reason, item.entry.body]),
		[
			["out-of-scope", "Navy in this app."],
			["out-of-scope", "Navy in these files."],
		],
	);
	assert.deepEqual(plan.shadowed, []);
});

test("with no context at all, scoped rules are out of scope rather than guessed", () => {
	const store = scopeStore();
	const plan = resolveKey(store, "ui.background", {})!;
	assert.equal(plan.applicable.length, 1);
	assert.equal(plan.winner?.body, "Dark grey everywhere.");
	assert.equal(plan.outOfScope.length, 2);
});

test("a path rule applies only when a path in play matches it", () => {
	const store = scopeStore();
	const plan = resolveKey(store, "ui.background", { paths: ["src/ui/button.ts"] })!;
	assert.equal(plan.winner?.body, "Navy in these files.", "path outranks global");
	assert.deepEqual(plan.shadowed.map((item) => item.reason), ["shadowed-by-scope"]);
});

test("resolveKey: unknown keys and keys with no authority return null", () => {
	assert.equal(resolveKey(chainStore(), "does.not.exist", {}), null);
	const retired = storeFrom({
		path: "knowledge/ui.md",
		text: `# UI\n\n## ui.background\n- scope: global\n- asOf: 2026-05-01\n- status: withdrawn\nBlack.\n`,
	});
	assert.equal(resolveKey(retired, "ui.background", {}), null);
});

test("two scopes for one key are not a conflict, and both stay injectable in their own context", () => {
	const store = scopeStore();
	for (const resolution of resolveAll(store)) {
		assert.equal(resolution.ambiguous, false);
		for (const entry of store.entries) assert.equal(isInjectable(entry), true);
	}
	assert.equal(store.byIdentity.size, 3, "three identities, one per scope");
});

// ─── The injection plan ─────────────────────────────────────────────────────

test("a hit on the authority injects it directly", () => {
	const store = chainStore();
	const authority = entryOf(store, "ui.background");
	const plan = planInjection(store, [authority]);
	assert.deepEqual(plan.inject.map((hit) => hit.entry.body), ["Dark grey."]);
	assert.equal(plan.inject[0]!.redirectedFrom, undefined);
	assert.deepEqual(plan.suppressed, []);
});

test("a hit on a superseded claim answers with the claim that replaced it", () => {
	const store = chainStore();
	const stale = entryOf(store, "ui.background@2026-06-14");
	const plan = planInjection(store, [stale]);
	assert.deepEqual(plan.inject.map((hit) => hit.entry.body), ["Dark grey."], "the dead rule is never quoted");
	assert.equal(plan.inject[0]!.redirectedFrom?.heading, "ui.background@2026-06-14");
	assert.deepEqual(plan.suppressed, [], "the user still got an answer, so nothing was suppressed");
});

test("a hit on an identity with no authority is suppressed with its real reason", () => {
	const store = storeFrom({
		path: "knowledge/ui.md",
		text: `# UI\n\n## ui.background\n- scope: global\n- asOf: 2026-05-01\n- status: withdrawn\nBlack.\n`,
	});
	const plan = planInjection(store, store.entries);
	assert.deepEqual(plan.inject, []);
	assert.deepEqual(plan.suppressed.map((item) => item.reason), ["withdrawn"]);
});

test("a hit on an unkeyed entry is suppressed as unkeyed", () => {
	const store = storeFrom({ path: "knowledge/legacy.md", text: `# Legacy\n\n## Prose Heading\nBody.\n` });
	const plan = planInjection(store, store.entries);
	assert.deepEqual(plan.inject, []);
	assert.deepEqual(plan.suppressed.map((item) => item.reason), ["unkeyed"]);
});

test("candidate duplicates collapse to one injection; the first candidate for an identity names it", () => {
	const store = chainStore();
	const authority = entryOf(store, "ui.background");
	const oldest = entryOf(store, "ui.background@2026-05-01");

	const direct = planInjection(store, [authority, oldest, authority]);
	assert.equal(direct.inject.length, 1, "one identity, one injection");
	assert.equal(direct.inject[0]!.redirectedFrom, undefined, "the authority was hit first");

	const redirected = planInjection(store, [oldest, authority]);
	assert.equal(redirected.inject.length, 1);
	assert.equal(redirected.inject[0]!.entry, authority);
	assert.equal(redirected.inject[0]!.redirectedFrom, oldest, "retrieval order decides what the hit is reported as");
});

test("retrieval order survives the two gates", () => {
	const store = storeFrom(
		{ path: "knowledge/a.md", text: `# A\n\n## aa.key\n- scope: global\n- asOf: 2026-10-01\nA.\n` },
		{ path: "knowledge/b.md", text: `# B\n\n## bb.key\n- scope: global\n- asOf: 2026-10-01\nB.\n` },
		{ path: "knowledge/c.md", text: `# C\n\n## cc.key\n- scope: global\n- asOf: 2026-10-01\nC.\n` },
	);
	const [a, b, c] = ["aa.key", "bb.key", "cc.key"].map((heading) => entryOf(store, heading));
	assert.deepEqual(planInjection(store, [c, a, b]).inject.map((hit) => hit.entry.body), ["C.", "A.", "B."]);
	assert.deepEqual(planInjection(store, [a, b, c]).inject.map((hit) => hit.entry.body), ["A.", "B.", "C."]);
});

test("two scopes for one key never both reach the model", () => {
	const store = scopeStore();
	const candidates = store.entries;
	const inProject = planInjection(store, candidates, { project: "money-manager" });
	assert.equal(inProject.inject.length, 1);
	assert.equal(inProject.inject[0]!.entry.body, "Navy in this app.");
	assert.deepEqual(inProject.shadowed.map((item) => [item.reason, item.entry.body]), [
		["shadowed-by-scope", "Dark grey everywhere."],
		["out-of-scope", "Navy in these files."],
	]);

	const elsewhere = planInjection(store, candidates, { project: "rl-pi-extensions" });
	assert.equal(elsewhere.inject.length, 1);
	assert.equal(elsewhere.inject[0]!.entry.body, "Dark grey everywhere.");
	assert.deepEqual(elsewhere.shadowed.map((item) => item.reason), ["out-of-scope", "out-of-scope"]);
});

test("a broken store injects nothing for that key and hands the conflict to a human", () => {
	const store = conflictStore();
	const plan = planInjection(store, store.entries, { project: "rl-pi-extensions" });
	assert.deepEqual(plan.inject, [], "no claim wins, so none is quoted");
	assert.deepEqual(plan.suppressed.map((item) => item.reason), ["conflict", "conflict", "conflict"]);
	assert.equal(plan.conflicts.length, 1);
	assert.equal(plan.conflicts[0]!.ambiguous, true);
	assert.equal(plan.conflicts[0]!.bestCandidate?.body, "Dark grey.", "the suggestion travels with the conflict");
});

test("a broken identity is absent from key-level resolution too", () => {
	assert.equal(resolveKey(conflictStore(), "ui.background", {}), null);
});

test("an empty candidate list produces an empty plan", () => {
	const plan = planInjection(chainStore(), []);
	assert.deepEqual(plan, { inject: [], suppressed: [], shadowed: [], conflicts: [] });
});

// ─── Invariants over generated stores ───────────────────────────────────────

function lcg(seed: number): () => number {
	let state = seed % 2147483647;
	if (state <= 0) state += 2147483646;
	return () => {
		state = (state * 16807) % 2147483647;
		return (state - 1) / 2147483646;
	};
}

const KEYS = ["ui.background", "ui.foreground", "git.branches"];
const SCOPES = ["global", "project:money-manager", "path:src/ui/**", "host:work"];
const DATES = ["2026-10-02", "2026-06-14", "2025-01-01", "2024-07-07", "sometime"];

const STATUSES = ["active", "active", "active", "superseded", "withdrawn", "current"];

function randomStore(seed: number): MemoryStore {
	const next = lcg(seed);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
	const lines: string[] = ["# Generated", ""];
	const count = 2 + Math.floor(next() * 8);
	for (let index = 0; index < count; index++) {
		const key = pick(KEYS);
		const date = pick(DATES);
		// Half the entries are dated revisions of their key, half are plain keys,
		// so generated stores contain a mix of identities and supersede candidates.
		const heading = next() < 0.5 && DATE_LIKE.includes(date) ? `${key}@${date}` : key;
		lines.push(`## ${heading}`);
		lines.push(`- scope: ${pick(SCOPES)}`);
		lines.push(`- asOf: ${date}`);
		lines.push(`- status: ${pick(STATUSES)}`);
		lines.push(`body ${index}`, "");
	}
	return storeFrom({ path: "knowledge/generated.md", text: lines.join("\n") });
}

const DATE_LIKE = ["2026-10-02", "2026-06-14", "2025-01-01", "2024-07-07"];

function shuffled<T>(items: T[], seed: number): T[] {
	const next = lcg(seed);
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[copy[i], copy[j]] = [copy[j]!, copy[i]!];
	}
	return copy;
}

const CONTEXTS = [{}, { project: "money-manager" }, { project: "other" }, { paths: ["src/ui/button.ts"] }];

test("invariant: every identity resolves to at most one injectable authority, for every generated store", () => {
	for (let seed = 1; seed <= 200; seed++) {
		const store = randomStore(seed);
		for (const resolution of resolveAll(store)) {
			const winner = resolution.winner;
			const group = store.byIdentity.get(resolution.identity)!;
			const activeValid = group.filter((entry) => entry.status === "active" && isWellFormed(entry));
			if (activeValid.length >= 2) {
				assert.equal(winner, null, `seed ${seed}: a contested identity must fail closed`);
				assert.equal(resolution.ambiguous, true, `seed ${seed}: contested identity is reported`);
				assert.equal(resolution.bestCandidate, [...activeValid].sort(compareAuthority)[0], `seed ${seed}: suggestion is the top-ranked claim`);
			} else if (activeValid.length === 1) {
				assert.equal(winner, activeValid[0], `seed ${seed}: the lone well-formed active claim is the authority`);
				assert.equal(isInjectable(winner!), true, `seed ${seed}: winner must be injectable`);
				assert.equal(resolution.ambiguous, false, `seed ${seed}: unopposed claim is not a conflict`);
			} else {
				assert.equal(winner, null, `seed ${seed}: nothing valid and active, so no authority`);
			}
			// Everything that was not chosen is accounted for exactly once.
			assert.equal(resolution.dropped.length + (winner ? 1 : 0), group.length, `seed ${seed}: every entry accounted for`);
		}
	}
});

test("invariant: injection never contains a non-authority, and never two entries for one key", () => {
	for (let seed = 1; seed <= 200; seed++) {
		const store = randomStore(seed);
		for (const context of CONTEXTS) {
			const plan = planInjection(store, shuffled(store.entries, seed), context);
			const keys = new Set<string>();
			for (const hit of plan.inject) {
				assert.equal(isInjectable(hit.entry), true, `seed ${seed}: injected entry must be injectable`);
				assert.equal(hit.entry.status, "active", `seed ${seed}: only active entries are injected`);
				if (hit.redirectedFrom) {
					assert.notEqual(hit.redirectedFrom, hit.entry, "a redirect names a different entry");
					assert.ok(store.entries.includes(hit.redirectedFrom!), `seed ${seed}: redirect names a real entry`);
				}
				assert.equal(keys.has(hit.entry.key), false, `seed ${seed}: key ${hit.entry.key} injected twice`);
				keys.add(hit.entry.key);
			}
			for (const item of plan.shadowed) assert.ok(store.entries.includes(item.entry), `seed ${seed}: shadow names a real entry`);
			for (const item of plan.suppressed) assert.ok(store.entries.includes(item.entry), `seed ${seed}: suppressed names a real entry`);
		}
	}
});

test("invariant: candidate order changes presentation order but never the injected set", () => {
	for (let seed = 1; seed <= 120; seed++) {
		const store = randomStore(seed);
		for (const context of CONTEXTS) {
			const a = planInjection(store, store.entries, context);
			const b = planInjection(store, shuffled(store.entries, seed + 999), context);
			const headings = (plan: typeof a) => plan.inject.map((hit) => `${hit.entry.heading}@${hit.entry.scope.raw}`).sort();
			assert.deepEqual(headings(b), headings(a), `seed ${seed}: injected set depends on order`);
			assert.deepEqual(
				planInjection(store, store.entries, context).conflicts.map((resolution) => resolution.identity),
				a.conflicts.map((resolution) => resolution.identity),
			);
		}
	}
});

// ─── Store type sanity (TopicFile wiring used by every test above) ──────────

test("the store keeps parsed path information on entries for diagnostics", () => {
	const files: TopicFile[] = [parseTopicFile(`# UI\n\n## ui.background\n- scope: global\n- asOf: 2026-10-02\nGrey.\n`, "knowledge/ui.md")];
	const store = buildStore(files);
	assert.equal(store.entries[0]!.path, "knowledge/ui.md");
	assert.equal(resolveAll(store)[0]!.path, "knowledge/ui.md");
});
