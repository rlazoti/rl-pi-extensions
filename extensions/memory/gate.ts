/**
 * The write-time gate (R14, R22-R24).
 *
 * Two refusals, both of which exist because a claim is supposed to be a rule or
 * a fact, not a status report:
 *
 *  - **Supersession prose inside a body.** "X is superseded by Y" puts two eras
 *    of one claim in one paragraph, which is how an old rule keeps injecting. A
 *    change is a new proposal for the same key; the store moves the old words to
 *    history.
 *  - **Project status.** SHAs, PR/run numbers, CI URLs and "merged 2026-10-14"
 *    are the shape of a changelog. A claim that reads like a changelog is
 *    refused and pointed at `memory_log`, which is where status lives.
 *
 * The status detector reads the body only (R23): `source` and `links` are
 * evidence, and "decided in PR #1284" is a legitimate way to say where a rule
 * came from.
 */

import { validateClaim, type Claim } from "./grammar.js";

export type StatusSignalKind = "sha" | "number" | "ci-url" | "dated-verb";

export interface StatusSignal {
	kind: StatusSignalKind;
	match: string;
}

const HEX_TOKEN = /\b[0-9a-f]{7,40}\b/g;
const NUMBERED = /\b(?:pr|pull request|issue|bug|run|build|task|ticket|job)\s*#?\d{1,6}\b|\b#\d{1,6}\b/gi;
const URL_TOKEN = /\bhttps?:\/\/[^\s)>\]"']+/gi;
const CI_URL = /(ci[.-]|jenkins|buildkite|teamcity|circleci|travis|appveyor|codecov|netlify|vercel|heroku|github\.com\/[^/]+\/[^/]+\/(actions|runs|deployments|pull|commit)\/|\/(actions|workflows|pipelines|builds|runs)\/)/i;
const MONTH = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
const DATEISH = new RegExp(`\\d{4}-\\d{2}-\\d{2}|(?:${MONTH})[a-z]*\\.?\\s+\\d{1,2}`, "gi");
const VERB = /\b(merged|pushed|deployed|published|ran|passed|failed)\b/gi;
/** R14: the phrases that mean a body is carrying its own history. */
const SUPERSESSION = [/supersed(ed|ing)/i, /historical/i, /no longer/i, /replaced by/i];

/**
 * Commit-SHA shapes, decided so an English word does not look like a hash.
 *
 * A run of 7-11 hex characters counts only when it holds a digit; 12 or more
 * always counts. The spec's rule is "7-40 hex", and an unmodified reading flags
 * words like "defaced" — a refusal the human then has to override, which spends
 * the trust the detector is supposed to earn. A real all-letters hash that short
 * is rare (about one in a thousand), and the override path exists for it (R24).
 */
function shaSignals(body: string): StatusSignal[] {
	const found: StatusSignal[] = [];
	for (const match of body.matchAll(HEX_TOKEN)) {
		const token = match[0];
		if (token.length >= 12 || /\d/.test(token)) found.push({ kind: "sha", match: token });
	}
	return found;
}

export function detectStatus(body: string): StatusSignal[] {
	const signals: StatusSignal[] = [...shaSignals(body)];
	for (const match of body.matchAll(NUMBERED)) signals.push({ kind: "number", match: match[0].trim() });
	for (const match of body.matchAll(URL_TOKEN)) {
		if (CI_URL.test(match[0])) signals.push({ kind: "ci-url", match: match[0] });
	}
	// A date beside a status verb, in either order, within a short window. This is a
	// heuristic, not a parser: "merged on 2026-10-14" is caught, and so is "since
	// 2026-05-02 every PR is merged with --no-ff". That false positive is exactly
	// what the override exists for, and every override is counted in the trial so
	// the strictness is measured rather than assumed (R24, R43).
	const dates = [...body.matchAll(DATEISH)].map((match) => ({ at: match.index ?? 0, text: match[0] }));
	const verbs = [...body.matchAll(VERB)].map((match) => ({ at: match.index ?? 0, text: match[0] }));
	for (const date of dates) {
		for (const verb of verbs) {
			if (Math.abs(verb.at - date.at) <= 40) {
				const start = Math.min(date.at, verb.at);
				const end = Math.max(date.at + date.text.length, verb.at + verb.text.length);
				signals.push({ kind: "dated-verb", match: body.slice(start, end).replace(/\s+/g, " ").trim() });
			}
		}
	}
	return signals;
}

/** R14 phrases found in a body. */
export function detectSupersession(body: string): string[] {
	const found: string[] = [];
	for (const pattern of SUPERSESSION) {
		const match = pattern.exec(body);
		if (match) found.push(match[0]);
	}
	return found;
}

export interface GateRequest {
	claim: Claim;
	/** R24: insist the body is a rule or fact after all. */
	overrideStatusCheck?: boolean;
	/** Required with the override, stored on the claim and shown in review. */
	overrideReason?: string;
}

export type GateOutcome = { ok: true; claim: Claim } | { ok: false; problems: string[]; signals: StatusSignal[]; redirect?: string };

function refuse(problems: string[], signals: StatusSignal[] = [], redirect?: string): GateOutcome {
	return { ok: false, problems, signals, redirect };
}

/**
 * Decide one `memory_propose` write. The claim that comes back out is the claim
 * to store — including the override reason when one was used.
 */
export function gatePropose(request: GateRequest): GateOutcome {
	const claim: Claim = { ...request.claim, body: claimBody(request.claim) };
	const grammar = validateClaim(claim);
	if (grammar.length > 0) return refuse(grammar);

	// The one inconsistency the store cannot repair later: the wave semantics
	// (D9 — migrated claims never inject until approved) hang off `origin`, and a
	// migrated source recorded with `origin: agent` injects as [unapproved] and is
	// reviewed in the wrong batch.
	if (/^migrated\s+from\b/i.test(claim.source.trim()) && claim.origin !== "migration") {
		return refuse([
			`the source says this was migrated, but origin is "${claim.origin ?? "agent"}": pass origin: "migration" — migrated claims are reviewed as their own batch and never inject until approved`,
		]);
	}

	const superseded = detectSupersession(claim.body);
	if (superseded.length > 0) {
		return refuse([
			`the body carries its own history (${superseded.map((phrase) => `"${phrase}"`).join(", ")}). One claim states one thing as of one date: propose the new claim for "${claim.key}" @ ${claim.scope} instead, and the old one moves to history by itself.`,
		]);
	}

	const signals = detectStatus(claim.body);
	if (signals.length > 0) {
		if (!request.overrideStatusCheck) {
			return refuse(
				[
					`the body reads as project status, not as a rule or fact: ${signals.map((signal) => `${signal.kind} "${signal.match}"`).join("; ")}. Status belongs in the daily log — use memory_log with section completed, in_progress, decision, carry or note. If this body really is a rule or a fact, resubmit with overrideStatusCheck: true and a reason.`,
				],
				signals,
				"memory_log",
			);
		}
		const reason = (request.overrideReason ?? "").trim();
		if (reason === "") return refuse(["an override needs a reason: say why this body is a rule or a fact, in one line"], signals, "memory_log");
		return { ok: true, claim: { ...claim, statusOverride: reason } };
	}
	if (request.overrideStatusCheck) return refuse(["overrideStatusCheck was set but the body carries no status signals — it is not needed"], []);
	return { ok: true, claim };
}

function claimBody(claim: Claim): string {
	return claim.body.replace(/\s+/g, " ").trim();
}

/** What a daily-log write must look like (R15): the date and time are never the agent's. */
export function gateDaily(input: { section: unknown; text: unknown }): { ok: true; section: string; text: string } | { ok: false; problems: string[] } {
	const problems: string[] = [];
	const section = typeof input.section === "string" ? input.section.trim() : "";
	const text = typeof input.text === "string" ? input.text.trim() : "";
	if (section === "") problems.push("section is required");
	if (text === "") problems.push("text is required");
	return problems.length > 0 ? { ok: false, problems } : { ok: true, section, text };
}

export function formatSignals(signals: StatusSignal[]): string {
	return signals.map((signal) => `${signal.kind} "${signal.match}"`).join("; ");
}
