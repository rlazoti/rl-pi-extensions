/**
 * Injection: what a turn is told, under a hard budget (R25-R31, R35).
 *
 * Three sections, in this order, with the caps from `config`:
 *
 *  1. always-on rules the human tagged `always`;
 *  2. today's open daily items (`in_progress` and `carry`);
 *  3. whatever else the ranker relates to the request.
 *
 * Budget is spent on the *rendered* text and measured with Pi's own estimator, so
 * the number the trial reports is the number that was injected, and the trial and
 * the 14-day baseline are counted with one ruler (R43, R47). The header and the
 * drop notice are part of the cost: the ceiling is the ceiling (R26).
 *
 * Nothing is cut silently. Entries are dropped whole, and the block ends with a
 * line naming how many, of which kind, and how to find them (R29).
 */

import { estimateTokens } from "@earendil-works/pi-coding-agent";

import { identityOf, isAlwaysRule, type Claim } from "./grammar.js";
import { parseScope, resolveIdentity, scopeRank, type ScopeContext } from "./scope.js";
import { BM25_RANKER, type Ranker } from "./rank.js";
import { OPEN_SECTIONS, formatItem, type DailyItem, type DailyLog } from "./daily.js";
import type { MemoryConfig } from "./config.js";

/** Pi's estimator, applied to text — the same ruler `/memory trial baseline` uses. */
export function tokensOf(text: string): number {
	return estimateTokens({ role: "user", content: text } as never);
}

export interface Candidate {
	claim: Claim;
	/** `[unapproved]` for a new-identity agent proposal the human has not seen (R28). */
	label?: string;
}

export interface ExcludedClaim {
	key: string;
	scope: string;
	reason: string;
}

export interface InjectionInput {
	claims: Claim[];
	daily: DailyLog;
	query: string;
	ctx: ScopeContext;
	config: MemoryConfig;
	today: string;
	ranker?: Ranker<Claim>;
	/** Age of a pending claim in days; the queue owns the dating rules. */
	ageOf?: (claim: Claim) => number;
}

export interface InjectionSection {
	title: string;
	text: string;
	tokens: number;
	included: number;
	dropped: number;
}

export interface InjectionResult {
	text: string;
	sections: InjectionSection[];
	tokens: { core: number; daily: number; retrieved: number; total: number };
	dropped: { rule: number; fact: number; dailyItems: number; total: number };
	/** Claims recall stopped at the count cap rather than at the budget (R27.4). */
	cappedClaims: number;
	/** Why a claim was not injected or not eligible, for `/memory preview`. */
	excluded: ExcludedClaim[];
	/** Identities with rival approved claims: nothing was asserted for them (R12). */
	contested: { key: string; scope: string }[];
	injected: { key: string; scope: string; state: Claim["state"]; label?: string }[];
	budget: number;
}

export function headerFor(project: string): string {
	return `## Memory — rules and facts for this context (project: ${project})`;
}

/**
 * The section title of the recalled claims, exported because `context.ts` reads
 * it back: "did this turn get anything back?" is the question the conversation
 * pruner asks, and a renamed section would silently change its answer (D24).
 */
export const RETRIEVED_TITLE = "Related claims";

export function formatClaim(claim: Claim, label?: string): string {
	const tag = label ? ` ${label}` : "";
	return `- [${claim.kind} · ${claim.scope} · ${claim.asOf}]${tag} ${claim.key}: ${claim.body}`;
}

/**
 * The line that reports what did not fit (R29). Reserved in the budget up front.
 *
 * Two different things can stop a claim: the token budget, and the recall cap
 * (R27.4). A reader told "for the budget" when a cap did it goes looking for the
 * wrong number to raise, so the line names both.
 */
export function dropNotice(droppedClaims: number, rules: number, facts: number, droppedItems: number, cappedClaims = 0, recallCap = 0): string {
	const parts: string[] = [];
	const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
	if (droppedClaims > 0) parts.push(`${plural(droppedClaims, "claim")} (${plural(rules, "rule")}, ${plural(facts, "fact")})`);
	if (droppedItems > 0) parts.push(`${plural(droppedItems, "open daily item")}`);
	if (cappedClaims > 0) {
		const byBudget = droppedClaims - cappedClaims;
		const why = byBudget > 0 ? `${plural(cappedClaims, "claim")} past the ${recallCap}-claim recall cap, ${byBudget} more past the token budget` : `past the ${recallCap}-claim recall cap`;
		return `Not shown: ${parts.join(", ")} — ${why} — use memory_search to find them.`;
	}
	return `Not shown for the budget: ${parts.join(", ")} — use memory_search to find them.`;
}

/** Higher is narrower (R10). A scope that does not parse is treated as broadest. */
function rankOf(scope: string): number {
	const parsed = parseScope(scope);
	return parsed ? scopeRank(parsed) : 0;
}

/**
 * Decide which claims may speak (R28) and which one answers for a key (R10).
 * Approved and pending claims are resolved separately: an approved claim and a
 * proposal waiting against it are not rivals, they are the same identity at two
 * stages (R11). An identity is key + scope, so a pending claim at a *different*
 * scope is a second identity, not a change against the approved one (D25).
 */
export function selectEligible(claims: Claim[], ctx: ScopeContext, opts: { pendingFlagDays: number; ageOf: (claim: Claim) => number }): {
	candidates: Candidate[];
	excluded: ExcludedClaim[];
	contested: { key: string; scope: string }[];
} {
	const byKey = new Map<string, Claim[]>();
	for (const claim of claims) {
		const list = byKey.get(claim.key) ?? [];
		list.push(claim);
		byKey.set(claim.key, list);
	}

	const candidates: Candidate[] = [];
	const excluded: ExcludedClaim[] = [];
	const contested: { key: string; scope: string }[] = [];

	for (const [key, all] of [...byKey.entries()].sort()) {
		const approved = all.filter((claim) => claim.state === "approved");
		const pending = all.filter((claim) => claim.state === "pending");

		const approvedResolved = resolveIdentity(key, approved, ctx);
		const pendingResolved = resolveIdentity(key, pending, ctx);
		for (const claim of approvedResolved.outOfScope) excluded.push({ key: claim.key, scope: claim.scope, reason: "out of scope for this session" });
		for (const claim of pendingResolved.outOfScope) excluded.push({ key: claim.key, scope: claim.scope, reason: "out of scope for this session" });
		for (const claim of approvedResolved.shadowed) excluded.push({ key: claim.key, scope: claim.scope, reason: "shadowed by a narrower scope for the same key" });
		for (const claim of pendingResolved.shadowed) excluded.push({ key: claim.key, scope: claim.scope, reason: "shadowed by a narrower scope for the same key" });

		if (approvedResolved.contested.length > 0) {
			// R12: two approved claims for one identity. Nothing is asserted.
			const seen = new Set<string>();
			for (const claim of approvedResolved.contested) {
				if (seen.has(identityOf(claim))) continue;
				seen.add(identityOf(claim));
				contested.push({ key: claim.key, scope: claim.scope });
			}
			for (const claim of pending) excluded.push({ key: claim.key, scope: claim.scope, reason: "the identity it proposes is contested" });
			continue;
		}
		if (approvedResolved.winner) {
			candidates.push({ claim: approvedResolved.winner });
			const winnerRank = rankOf(approvedResolved.winner.scope);
			for (const claim of pending) {
				// R11: an identity is key + scope, so a pending claim at another scope is not
				// a change against the approved one — it is a second identity, and it waits for
				// review because an unreviewed claim must not be the one that shadows. Saying
				// "a change is pending against an approved claim" for it read like a bug (D25).
				const sameIdentity = claim.scope === approvedResolved.winner.scope;
				const narrower = rankOf(claim.scope) > winnerRank;
				excluded.push({
					key: claim.key,
					scope: claim.scope,
					reason: sameIdentity
						? "a change is pending against an approved claim; only the approved claim is asserted"
						: narrower
							? `a different identity (${claim.scope}): it waits for review, because an unreviewed claim at a narrower scope would shadow the approved claim for this key`
							: `a different identity (${claim.scope}): it waits for review, because an approved claim at a narrower scope already answers for this key`,
				});
			}
			continue;
		}
		if (pendingResolved.contested.length > 0) {
			for (const claim of pendingResolved.contested) excluded.push({ key: claim.key, scope: claim.scope, reason: "two pending claims for one identity: the store holds one proposal per identity (R11)" });
			continue;
		}
		const proposal = pendingResolved.winner;
		if (!proposal) continue;
		if (proposal.origin === "migration") {
			excluded.push({ key: proposal.key, scope: proposal.scope, reason: "a migrated claim is not injected until it is approved" });
			continue;
		}
		const age = opts.ageOf(proposal);
		if (age > opts.pendingFlagDays) {
			excluded.push({ key: proposal.key, scope: proposal.scope, reason: `pending ${age} days, past the ${opts.pendingFlagDays}-day window` });
			continue;
		}
		candidates.push({ claim: proposal, label: "[unapproved]" });
	}

	return { candidates, excluded, contested };
}

interface Filled {
	section: InjectionSection;
	leftOver: Candidate[];
	chosen: Candidate[];
}

/**
 * Fill a section without ever splitting an entry: add a candidate, measure the
 * rendered section, and send the candidate on to the next section if the cap is
 * reached.
 */
function fillSection(opts: { title: string; candidates: Candidate[]; cap: number; label?: boolean }): Filled {
	const title = `### ${opts.title}`;
	const lines: string[] = [];
	const chosen: Candidate[] = [];
	const leftOver: Candidate[] = [];
	for (const candidate of opts.candidates) {
		const line = formatClaim(candidate.claim, opts.label ? candidate.label : undefined);
		const withLine = tokensOf(`${title}\n${[...lines, line].join("\n")}`);
		if (withLine > opts.cap) {
			leftOver.push(candidate);
			continue;
		}
		lines.push(line);
		chosen.push(candidate);
	}
	const text = lines.length === 0 ? "" : `${title}\n${lines.join("\n")}`;
	return {
		section: { title: opts.title, text, tokens: text === "" ? 0 : tokensOf(text), included: chosen.length, dropped: leftOver.length },
		leftOver,
		chosen,
	};
}

export function buildInjection(input: InjectionInput): InjectionResult {
	const ranker = input.ranker ?? BM25_RANKER;
	const ageOf = input.ageOf ?? (() => 0);
	const selected = selectEligible(input.claims, input.ctx, { pendingFlagDays: input.config.pendingFlagDays, ageOf });

	// 1. always-on rules (R27.1, R35). Ranking only decides which of them fit when
	// there are too many: an `always` rule is meant to be there every turn, so the
	// least related ones are the ones that fall out.
	const always = selected.candidates.filter((candidate) => candidate.claim.state === "approved" && isAlwaysRule(candidate.claim));
	const rankedAlways = ranker
		.rank(input.query, always.map((candidate) => candidate.claim))
		.map((hit) => always.find((candidate) => identityOf(candidate.claim) === identityOf(hit.entry))!);
	const unrankedAlways = always.filter((candidate) => !rankedAlways.includes(candidate));
	const coreFill = fillSection({ title: "Always-on rules", candidates: [...rankedAlways, ...unrankedAlways], cap: input.config.coreTokens });

	// 2. open daily items (R27.2). Newest first when space is short, rendered
	// oldest first so the day still reads in order.
	const open = input.daily.items.filter((item: DailyItem) => OPEN_SECTIONS.includes(item.section));
	const dailyLines: string[] = [];
	let kept = 0;
	for (const item of [...open].sort((a, b) => (a.stamp === b.stamp ? 0 : a.stamp < b.stamp ? 1 : -1))) {
		const trial = [...dailyLines, formatItem(item)];
		if (tokensOf(`### Open work today\n${trial.join("\n")}`) > input.config.dailyTokens) continue;
		dailyLines.push(formatItem(item));
		kept++;
	}
	const dailyText = dailyLines.length === 0 ? "" : `### Open work today\n${dailyLines.reverse().join("\n")}`;
	const dailySection: InjectionSection = {
		title: "Open work today",
		text: dailyText,
		tokens: dailyText === "" ? 0 : tokensOf(dailyText),
		included: kept,
		dropped: open.length - kept,
	};

	// 3. retrieved claims (R27.3), with the caps of 1 and 2 flowing through.
	const coreChosen = new Set(coreFill.chosen.map((candidate) => identityOf(candidate.claim)));
	const pool = selected.candidates.filter((candidate) => !coreChosen.has(identityOf(candidate.claim)));
	const header = headerFor(input.ctx.projectId);
	// An unapproved proposal ranks below every approved claim (R28).
	const approvedPool = pool.filter((candidate) => candidate.claim.state === "approved");
	const pendingPool = pool.filter((candidate) => candidate.claim.state !== "approved");
	const rankedAll = [
		...ranker.rank(input.query, approvedPool.map((candidate) => candidate.claim)).map((hit) => approvedPool.find((candidate) => identityOf(candidate.claim) === identityOf(hit.entry))!),
		...ranker.rank(input.query, pendingPool.map((candidate) => candidate.claim)).map((hit) => pendingPool.find((candidate) => identityOf(candidate.claim) === identityOf(hit.entry))!),
	];
	// R27.4: a count cap on recall. The token budget does not bound the block on
	// its own — with a bank of dozens of claims retrieval fills whatever it is
	// given — so a turn's cost tracked the budget instead of the work in front of it.
	const recallCap = input.config.maxRetrievedClaims ?? 0;
	const ranked = recallCap > 0 ? rankedAll.slice(0, recallCap) : rankedAll;
	const cappedOut = recallCap > 0 ? rankedAll.slice(recallCap) : [];
	const reserve = tokensOf(header) + tokensOf(dropNotice(pool.length, 0, 0, open.length, recallCap > 0 ? Math.max(0, pool.length - recallCap) : 0, recallCap));
	const retrievedCap = Math.max(0, input.config.budgetTokens - coreFill.section.tokens - dailySection.tokens - reserve);
	const retrievedFill = fillSection({ title: RETRIEVED_TITLE, candidates: ranked, cap: retrievedCap, label: true });

	// What did not fit, whole (R29): stopped by the count cap, or by the tokens.
	const droppedCandidates = [...coreFill.leftOver, ...retrievedFill.leftOver, ...cappedOut];
	const droppedByKind = { rule: 0, fact: 0 };
	for (const candidate of droppedCandidates) droppedByKind[candidate.claim.kind] += 1;
	const notice: string[] = [];
	if (droppedCandidates.length > 0 || dailySection.dropped > 0) {
		notice.push(dropNotice(droppedCandidates.length, droppedByKind.rule, droppedByKind.fact, dailySection.dropped, cappedOut.length, recallCap));
	}

	const blocks = [coreFill.section, dailySection, retrievedFill.section].filter((section) => section.text !== "");
	const text = blocks.length === 0 ? "" : [header, ...blocks.map((section) => section.text), ...notice].join("\n\n");

	return {
		text,
		sections: blocks,
		tokens: {
			core: coreFill.section.tokens,
			daily: dailySection.tokens,
			retrieved: retrievedFill.section.tokens,
			total: text === "" ? 0 : tokensOf(text),
		},
		dropped: { rule: droppedByKind.rule, fact: droppedByKind.fact, dailyItems: dailySection.dropped, total: droppedCandidates.length + dailySection.dropped },
		cappedClaims: cappedOut.length,
		excluded: selected.excluded,
		contested: selected.contested,
		injected: [
			...coreFill.chosen.map((candidate) => ({ key: candidate.claim.key, scope: candidate.claim.scope, state: candidate.claim.state, label: candidate.label })),
			...retrievedFill.chosen.map((candidate) => ({ key: candidate.claim.key, scope: candidate.claim.scope, state: candidate.claim.state, label: candidate.label })),
		],
		budget: input.config.budgetTokens,
	};
}

/** The exact block a turn would receive, with tokens per section (R31). */
export function formatPreview(result: InjectionResult): string {
	const lines = [`Injection — ${result.tokens.total} of ${result.budget} tokens`];
	if (result.sections.length === 0) lines.push("  nothing would be injected");
	for (const section of result.sections) {
		lines.push(`  ${section.title}: ${section.tokens} tokens, ${section.included} shown, ${section.dropped} dropped`);
	}
	lines.push(`  core ${result.tokens.core} + daily ${result.tokens.daily} + retrieved ${result.tokens.retrieved} = ${result.tokens.total}`);
	if (result.dropped.total > 0) lines.push(`  dropped: ${result.dropped.rule} rules, ${result.dropped.fact} facts, ${result.dropped.dailyItems} daily items`);
	if (result.cappedClaims > 0) lines.push(`  recall cap: ${result.cappedClaims} claim(s) stopped by the per-turn count cap, not by the token budget`);
	if (result.contested.length > 0) lines.push(`  contested: ${result.contested.map((entry) => `${entry.key} @ ${entry.scope}`).join(", ")}`);
	if (result.excluded.length > 0) {
		lines.push("  not injected:");
		for (const item of result.excluded.slice(0, 20)) lines.push(`    ${item.key} @ ${item.scope}: ${item.reason}`);
		if (result.excluded.length > 20) lines.push(`    …and ${result.excluded.length - 20} more`);
	}
	lines.push("", "--- the block a turn would receive ---", result.text === "" ? "(nothing to inject)" : result.text);
	return lines.join("\n");
}
