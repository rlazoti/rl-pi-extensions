import assert from "node:assert/strict";
import test from "node:test";

import { buildInjection, dropNotice, formatClaim, formatPreview, selectEligible, tokensOf, headerFor } from "./inject.ts";
import { parseDaily } from "./daily.ts";
import { DEFAULT_CONFIG, type MemoryConfig } from "./config.ts";
import type { Claim } from "./grammar.ts";
import type { ScopeContext } from "./scope.ts";

const ctx: ScopeContext = { projectId: "github.com/rlazoti/rl-pi-extensions", cwd: "/repo/x", rootPath: "/repo/x" };
const TODAY = "2026-10-16";

function claim(key: string, overrides: Partial<Claim> = {}): Claim {
	return {
		key,
		kind: "rule",
		scope: "global",
		asOf: "2026-01-01",
		source: "a test",
		body: `the rule about ${key}`,
		aliases: [],
		tags: [],
		links: [],
		origin: "agent",
		state: "approved",
		...overrides,
	};
}

function daily(text: string) {
	return parseDaily(text, "daily/today.md");
}

const EMPTY_DAY = daily("# Daily log — 2026-10-16\n");

function inject(claims: Claim[], opts: { query?: string; config?: Partial<MemoryConfig>; daily?: string; ageOf?: (claim: Claim) => number } = {}) {
	return buildInjection({
		claims,
		daily: opts.daily === undefined ? EMPTY_DAY : daily(opts.daily),
		query: opts.query ?? "",
		ctx,
		config: { ...DEFAULT_CONFIG, ...opts.config },
		today: TODAY,
		ageOf: opts.ageOf,
	});
}

test("inject: an approved claim is injected (R28 row 1)", () => {
	const result = inject([claim("git.flow", { body: "Merge with --no-ff." })], { query: "git flow merge" });
	assert.equal(result.injected.length, 1);
	assert.match(result.text, /- \[rule · global · 2026-01-01\] git\.flow: Merge with --no-ff\./);
	assert.deepEqual(result.contested, []);
});

test("inject: a pending change against an approved claim never displaces it (R28 row 2)", () => {
	const result = inject([
		claim("git.flow", { body: "Merge with --no-ff." }),
		claim("git.flow", { body: "Squash instead.", state: "pending", origin: "agent", proposedAt: "2026-10-15" }),
	], { query: "merge squash" });
	assert.deepEqual(result.injected.map((entry) => entry.key), ["git.flow"]);
	assert.equal(result.text.includes("Squash instead."), false);
	assert.match(result.text, /Merge with --no-ff\./);
	assert.ok(result.excluded.some((item) => /a change is pending against an approved claim/.test(item.reason)));
});

test("inject: a new-identity agent proposal is injected, labelled, and ranked below approved claims (R28 row 3)", () => {
	const result = inject([
		claim("a.approved", { body: "approved says git flow" }),
		claim("b.proposed", { body: "proposed says git flow", state: "pending", origin: "agent", proposedAt: "2026-10-15" }),
	], { query: "git flow" });
	assert.equal(result.text.includes("[unapproved] b.proposed"), true);
	const approvedAt = result.text.indexOf("a.approved");
	const proposedAt = result.text.indexOf("b.proposed");
	assert.ok(approvedAt >= 0 && proposedAt >= 0);
	assert.ok(approvedAt < proposedAt, "the approved claim comes first");
	assert.deepEqual(result.injected.find((entry) => entry.key === "b.proposed")!.label, "[unapproved]");
});

test("inject: a proposal older than the flag window stops being injected (R28 row 4, D13)", () => {
	const old = claim("b.proposed", { body: "waiting since June", state: "pending", origin: "agent", proposedAt: "2026-06-01" });
	const flagged = inject([old], { query: "waiting june", ageOf: () => 137 });
	assert.equal(flagged.text.includes("waiting since June"), false);
	assert.ok(flagged.excluded.some((item) => /pending 137 days, past the 14-day window/.test(item.reason)));
	const fresh = inject([old], { query: "waiting june", ageOf: () => 3 });
	assert.match(fresh.text, /waiting since June/);
});

test("inject: a migrated claim is not injected until it is approved (R28 row 5, D9)", () => {
	const result = inject([claim("m.one", { body: "migrated text", state: "pending", origin: "migration", proposedAt: "2026-10-14" })], { query: "migrated text" });
	assert.equal(result.text.includes("migrated text"), false);
	assert.ok(result.excluded.some((item) => /migrated claim is not injected until it is approved/.test(item.reason)));
});

test("inject: two approved claims on one identity assert nothing, and say so (R12, R28 row 6)", () => {
	const result = inject([claim("z.contest", { body: "first says git" }), claim("z.contest", { body: "second says git" })], { query: "git" });
	assert.equal(result.text.includes("first says git"), false);
	assert.equal(result.text.includes("second says git"), false);
	assert.deepEqual(result.contested, [{ key: "z.contest", scope: "global" }], "one identity, named once");
});

test("inject: out-of-scope claims and shadowed ones are never injected (R9, R10)", () => {
	const result = inject([
		claim("a.b", { body: "global answer about git" }),
		claim("a.b", { body: "path answer about git", scope: "path:extensions/**" }),
		claim("c.d", { body: "another project about git", scope: "project:someone/else" }),
	], { query: "git" });
	assert.match(result.text, /path answer about git/);
	assert.equal(result.text.includes("global answer"), false);
	assert.equal(result.text.includes("another project"), false);
	assert.ok(result.excluded.some((item) => item.reason === "shadowed by a narrower scope for the same key"));
	assert.ok(result.excluded.some((item) => item.reason === "out of scope for this session"));
});

test("inject: only always-tagged rules sit in the core section, other rules come by rank (R27.1, R35)", () => {
	const result = inject([
		claim("r.always", { body: "always-on rule about git", tags: ["always"] }),
		claim("r.conditional", { body: "conditional rule about git" }),
	], { query: "git" });
	assert.match(result.text, /### Always-on rules\n- \[rule · global · 2026-01-01\] r\.always: always-on rule about git/);
	assert.match(result.text, /### Related claims/);
	assert.equal(result.sections[0]!.title, "Always-on rules");
	assert.equal(result.sections[0]!.text.includes("r.conditional"), false);
	// With no related query, the conditional rule does not appear at all.
	const quiet = inject([claim("r.conditional", { body: "conditional rule about git" })], { query: "totually unrelated topic" });
	assert.equal(quiet.text.includes("conditional rule"), false);
});

test("inject: nothing is injected when there is nothing to say", () => {
	const result = inject([]);
	assert.equal(result.text, "");
	assert.deepEqual(result.sections, []);
	assert.deepEqual(result.tokens, { core: 0, daily: 0, retrieved: 0, total: 0 });
});

test("inject: the daily section carries open items and nothing else (R27.2)", () => {
	const result = inject([], {
		daily: `# Daily log — ${TODAY}

## completed
- (${TODAY} 09:00) finished work, not injected

## in_progress
- (${TODAY} 10:00) wire the injector

## carry
- (2026-10-15 17:30) inbox gc

## decision
- (${TODAY} 11:00) a decision, not open work
`,
	});
	assert.match(result.text, /### Open work today\n- \(2026-10-15 17:30\) inbox gc\n- \(\d{4}-\d{2}-\d{2} 10:00\) wire the injector/);
	assert.equal(result.text.includes("finished work"), false);
	assert.equal(result.text.includes("a decision, not open work"), false);
});

test("inject: the total never passes the budget, and the caps hold (R26, R27)", () => {
	const claims: Claim[] = [];
	for (let i = 0; i < 60; i++) {
		claims.push(claim(`topic${i}.rule`, { body: `git flow rule number ${i} with some padding words to make it cost tokens`, tags: i % 2 === 0 ? ["always"] : [] }));
	}
	const config = { budgetTokens: 600, coreTokens: 200, dailyTokens: 100 };
	const result = inject(claims, { query: "git flow rule", config });
	assert.ok(result.tokens.total <= 600, `total ${result.tokens.total} exceeded the budget`);
	assert.ok(result.tokens.core <= 200, `core ${result.tokens.core} exceeded its cap`);
	assert.ok(result.tokens.daily <= 100, `daily ${result.tokens.daily} exceeded its cap`);
	assert.ok(result.tokens.core + result.tokens.daily + result.tokens.retrieved <= 600);
	assert.ok(result.text.includes("use memory_search to find them"), "the drop notice is part of the block (R29)");
});

test("inject: unused core and daily budget flows to retrieval (R27)", () => {
	const claims: Claim[] = [];
	for (let i = 0; i < 12; i++) claims.push(claim(`always.rule${i}`, { body: `an always rule about git flow number ${i} with padding`, tags: ["always"] }));
	for (let i = 0; i < 12; i++) claims.push(claim(`other.rule${i}`, { body: `another related rule about git flow ${i}` }));
	// The count cap is off here: this test is about tokens moving between sections.
	const fullCore = inject(claims, { query: "git flow", config: { budgetTokens: 500, coreTokens: 400, dailyTokens: 0, maxRetrievedClaims: 0 } });
	const smallCore = inject(claims, { query: "git flow", config: { budgetTokens: 500, coreTokens: 80, dailyTokens: 0, maxRetrievedClaims: 0 } });
	assert.ok(fullCore.tokens.core > smallCore.tokens.core, "the core section really is bigger");
	assert.ok(smallCore.tokens.retrieved > fullCore.tokens.retrieved, "what the core section did not spend is spent on retrieval");
	assert.ok(fullCore.tokens.total <= 500 && smallCore.tokens.total <= 500);
});

test("inject: an entry is never cut in half (R29)", () => {
	const long = claim("a.long", { body: `git flow policy ${"padding ".repeat(120)}` });
	const short = claim("b.short", { body: "git flow policy is short" });
	const result = inject([long, short], { query: "git flow policy", config: { budgetTokens: 200, coreTokens: 0, dailyTokens: 0 } });
	for (const entry of result.injected) {
		const body = result.text.match(new RegExp(`\\] ${entry.key}: (.*)$`, "m"))?.[1];
		assert.ok(body !== undefined, `${entry.key} appears in the block with its body on one line`);
		const original = [long, short].find((c) => c.key === entry.key)!.body;
		assert.equal(body, original, "the body shown is the whole body");
	}
});

test("inject: the drop notice counts by kind and names memory_search (R29)", () => {
	assert.equal(dropNotice(3, 2, 1, 4), "Not shown for the budget: 3 claims (2 rules, 1 fact), 4 open daily items — use memory_search to find them.");
	const claims: Claim[] = [];
	for (let i = 0; i < 30; i++) claims.push(claim(`t${i}.rule`, { kind: i % 3 === 0 ? "fact" : "rule", body: `git flow thing ${i}` }));
	const result = inject(claims, { query: "git flow", config: { budgetTokens: 300, coreTokens: 0, dailyTokens: 0, maxRetrievedClaims: 0 } });
	assert.equal(result.cappedClaims, 0, "no count cap: every drop came from the budget");
	assert.ok(result.dropped.rule + result.dropped.fact > 0);
	assert.equal(result.dropped.rule + result.dropped.fact, 30 - result.injected.length);
	assert.match(result.text, new RegExp(`Not shown for the budget: ${result.dropped.rule + result.dropped.fact} claims \\(${result.dropped.rule} rules, ${result.dropped.fact} facts\\)`));
});

test("inject: the recall cap bounds how many claims one turn gets, whatever the budget leaves (R27.4)", () => {
	const claims: Claim[] = [];
	for (let i = 0; i < 12; i++) claims.push(claim(`git.t${i}`, { body: `git flow rule number ${i}` }));
	const result = inject(claims, { query: "git flow", config: { coreTokens: 0, dailyTokens: 0, maxRetrievedClaims: 3 } });
	assert.equal(result.injected.length, 3, "three retrieved claims, and the rest of the budget goes unused");
	assert.equal(result.cappedClaims, 9);
	assert.equal(result.dropped.rule + result.dropped.fact, 9);
	assert.ok(result.tokens.total < result.budget, "the budget is a ceiling, not a quota");
	assert.match(result.text, /Not shown: 9 claims \(9 rules, 0 facts\) — past the 3-claim recall cap — use memory_search to find them\./);
});

test("inject: a cap of 0 leaves the token budget as the only limit", () => {
	const claims: Claim[] = [];
	for (let i = 0; i < 12; i++) claims.push(claim(`git.t${i}`, { body: `git flow rule number ${i}` }));
	const capped = inject(claims, { query: "git flow", config: { coreTokens: 0, dailyTokens: 0, maxRetrievedClaims: 0 } });
	const limited = inject(claims, { query: "git flow", config: { coreTokens: 0, dailyTokens: 0, maxRetrievedClaims: 3 } });
	assert.ok(capped.injected.length > limited.injected.length, "uncapped recall keeps filling while the budget has room");
	assert.equal(capped.cappedClaims, 0);
});

test("inject: the cap counts dropped claims and says which limit stopped them (R29)", () => {
	const claims: Claim[] = [];
	for (let i = 0; i < 20; i++) claims.push(claim(`git.t${i}`, { kind: i % 2 === 0 ? "rule" : "fact", body: `git flow rule number ${i}` }));
	// A cap tighter than the budget: the cap did the dropping, and the notice says so.
	const byCap = inject(claims, { query: "git flow", config: { coreTokens: 0, dailyTokens: 0, maxRetrievedClaims: 2 } });
	assert.match(byCap.text, /Not shown: 18 claims \(9 rules, 9 facts\) — past the 2-claim recall cap — use memory_search to find them\./);
	// A budget tighter than the cap: the notice stays honest about the budget.
	const byBudget = inject(claims, { query: "git flow", config: { budgetTokens: 320, coreTokens: 0, dailyTokens: 0, maxRetrievedClaims: 0 } });
	assert.match(byBudget.text, /Not shown for the budget: \d+ claims/);
	const preview = formatPreview(byCap);
	assert.match(preview, /recall cap: 18 claim\(s\) stopped by the per-turn count cap, not by the token budget/);
});

test("inject: the recall cap does not touch the always-on core section (R27.1 vs R27.4)", () => {
	const core = ["a", "b", "c", "d", "e", "f", "g", "h"].map((name) => claim(`core.${name}`, { tags: ["always"], body: `always-on rule ${name}` }));
	const rest = [1, 2, 3, 4, 5].map((n) => claim(`other.${n}`, { body: `matching rule ${n}` }));
	const result = inject([...core, ...rest], { query: "matching rule", config: { maxRetrievedClaims: 2 } });
	assert.equal(core.filter((entry) => result.injected.some((shown) => shown.key === entry.key)).length, 8, "every always-on rule is still injected");
	assert.equal(result.injected.filter((shown) => shown.key.startsWith("other.")).length, 2);
});

test("inject: dropNotice names the cap and the budget separately", () => {
	assert.equal(dropNotice(9, 5, 4, 0, 9, 3), "Not shown: 9 claims (5 rules, 4 facts) — past the 3-claim recall cap — use memory_search to find them.");
	assert.equal(dropNotice(9, 5, 4, 0, 4, 3), "Not shown: 9 claims (5 rules, 4 facts) — 4 claims past the 3-claim recall cap, 5 more past the token budget — use memory_search to find them.");
});

test("inject: daily items are dropped whole and counted (R29)", () => {
	const many = ["09:00", "09:10", "09:20", "09:30", "09:40"].map((time) => `- (${TODAY} ${time}) an open item with a handful of words in it`).join("\n");
	const result = inject([], { daily: `# Daily log — ${TODAY}\n\n## in_progress\n${many}\n`, config: { budgetTokens: 400, coreTokens: 0, dailyTokens: 80 } });
	assert.ok(result.dropped.dailyItems > 0);
	assert.equal(result.sections.find((section) => section.title === "Open work today")!.dropped, result.dropped.dailyItems);
	assert.match(result.text, /1 open daily item — use memory_search/);
});

test("inject: invariant sweep — 200 generated banks never break the budget", () => {
	const kinds: Claim["kind"][] = ["rule", "fact"];
	const scopes = ["global", "project:github.com/rlazoti/rl-pi-extensions", "path:extensions/**", "path:somewhere/else/**"];
	let seed = 20261016;
	const next = (limit: number): number => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed % limit;
	};
	for (let store = 0; store < 200; store++) {
		const claims: Claim[] = [];
		const count = next(25);
		for (let i = 0; i < count; i++) {
			const state = next(4) === 0 ? "pending" : "approved";
			claims.push(
				claim(`k${i}.topic`, {
					kind: kinds[next(2)]!,
					scope: scopes[next(scopes.length)]!,
					state,
					origin: next(3) === 0 ? "migration" : "agent",
					proposedAt: state === "pending" ? "2026-09-01" : undefined,
					tags: next(3) === 0 ? ["always"] : [],
					body: `${"word ".repeat(next(40))}git flow topic ${i}`.trim() || `git flow topic ${i}`,
				}),
			);
		}
		const config: MemoryConfig = { ...DEFAULT_CONFIG, budgetTokens: 200 + next(1800), coreTokens: next(400), dailyTokens: next(300) };
		const ageOf = () => next(60);
		const result = inject(claims, { query: "git flow topic", config, ageOf, daily: `# Daily log — ${TODAY}\n\n## in_progress\n- (${TODAY} 10:00) open item number one\n- (${TODAY} 11:00) open item number two\n` });
		assert.ok(result.tokens.total <= config.budgetTokens, `store ${store}: ${result.tokens.total} > ${config.budgetTokens}`);
		assert.ok(result.tokens.core <= config.coreTokens, `store ${store}: core ${result.tokens.core} > ${config.coreTokens}`);
		assert.ok(result.tokens.daily <= config.dailyTokens, `store ${store}: daily ${result.tokens.daily} > ${config.dailyTokens}`);
		// No half entries: every injected key appears with a complete line.
		for (const entry of result.injected) {
			const line = result.text.split("\n").find((candidate) => candidate.includes(`] ${entry.key}: `) || candidate.includes(`] [unapproved] ${entry.key}: `));
			assert.ok(line !== undefined, `store ${store}: ${entry.key} is in the block without a whole line`);
			const body = line!.slice(line!.indexOf(`${entry.key}: `) + entry.key.length + 2);
			const source = claims.find((candidate) => candidate.key === entry.key && candidate.scope === entry.scope)!;
			assert.equal(body, source.body, `store ${store}: ${entry.key} was cut`);
		}
		// Nothing out of scope is ever in the block.
		for (const line of result.text.split("\n")) {
			const scope = /- \[(?:rule|fact) · (\S+) ·/.exec(line)?.[1];
			if (scope === undefined) continue;
			if (scope.startsWith("project:")) assert.equal(scope, `project:${ctx.projectId}`, `store ${store}: ${scope} injected in the wrong project`);
			if (scope === "path:somewhere/else/**") assert.fail(`store ${store}: an out-of-scope path claim was injected`);
		}
	}
});

test("inject: preview shows the block and the tokens per section (R31)", () => {
	const result = inject([claim("r.always", { body: "an always rule about git", tags: ["always"] }), claim("a.b", { body: "git-related fact", kind: "fact" })], { query: "git" });
	const preview = formatPreview(result);
	assert.match(preview, /^Injection — \d+ of 2000 tokens/);
	assert.match(preview, /Always-on rules: \d+ tokens, 1 shown, 0 dropped/);
	assert.match(preview, /core \d+ \+ daily \d+ \+ retrieved \d+ = \d+/);
	assert.match(preview, /--- the block a turn would receive ---/);
	assert.ok(preview.includes(result.text));
	const empty = formatPreview(inject([]));
	assert.match(empty, /nothing would be injected/);
	assert.match(empty, /\(nothing to inject\)/);
});

test("inject: the header names the project and the estimator is Pi's", () => {
	assert.equal(headerFor("github.com/rlazoti/rl-pi-extensions"), "## Memory — rules and facts for this context (project: github.com/rlazoti/rl-pi-extensions)");
	// Pi's estimator is chars/4 rounded up, which is also what the baseline uses.
	assert.equal(tokensOf("abcd"), 1);
	assert.equal(tokensOf("abcde"), 2);
	assert.equal(tokensOf(""), 0);
	assert.equal(formatClaim(claim("a.b", { body: "x" })), "- [rule · global · 2026-01-01] a.b: x");
});

test("inject: selectEligible keeps one answer per key and reports the rest", () => {
	const selected = selectEligible(
		[claim("a.b", { body: "approved" }), claim("a.b", { body: "pending", state: "pending", proposedAt: "2026-10-15" }), claim("c.d", { body: "two pendings", state: "pending", proposedAt: "2026-10-15" }), claim("c.d", { body: "two pendings too", state: "pending", proposedAt: "2026-10-15" })],
		ctx,
		{ pendingFlagDays: 14, ageOf: () => 1 },
	);
	assert.deepEqual(selected.candidates.map((candidate) => candidate.claim.body), ["approved"]);
	assert.ok(selected.excluded.some((item) => /two pending claims for one identity/.test(item.reason)));
});
