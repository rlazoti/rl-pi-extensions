/**
 * Pi adapter for the memory component: tools, the `/memory` command, and the
 * per-turn injection hook. Nothing here decides anything about memory — the gate,
 * the resolver and the injector do (see gate.ts, resolver.ts, inject.ts). This
 * file translates between Pi's shapes and `service.ts`.
 *
 * Two decisions live here because they are Pi facts, not memory facts:
 *   • who can be asked (mode + dialog availability), and
 *   • whether this extension should be loaded at all next to another memory
 *     extension.
 */

import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { basename } from "node:path";

import { formatIdentity } from "./schema.js";
import type { ScopeContext } from "./resolver.js";
import { memoryPaths } from "./fs-store.js";
import { collisionReport, createService, RESOLUTIONS, type AskFn, type ResolutionChoice, type WriteOutcome } from "./service.js";
import { clip, formatContest, renderConflict } from "./pending.js";
import type { ContestSide } from "./pending.js";
import type { Resolution, WriteRequest } from "./gate.js";
import type { Candidate, DailyStatus, DoctorReport, KeyReport } from "./service.js";
import type { PendingConflict, PendingList } from "./pending.js";

const RESOLUTION_LABELS: Record<string, string> = {
	supersede: "supersede — the new claim wins, the old one becomes history",
	merge: "merge — one claim replaces both, you supply the merged text",
	withdraw: "withdraw — stop asserting either; nothing new is claimed",
	"keep-both-flagged": "keep both — contested on purpose; nothing will be injected for it",
	discard: "discard — drop the new claim, the existing one stands",
};

/**
 * No timer. A human who is not at the keyboard is not on a clock: the earlier
 * version auto-dismissed after two minutes, which discarded an answer nobody had
 * had time to give and left the turn in a half-answered state. The dialog waits.
 * Esc, or cancelling the tool call, is how to say "not now" — and the refusal is
 * already parked by then, so walking away costs nothing.
 */

/**
 * Pi's interactive UI gives extensions one dialog slot: the editor area. A second
 * `ui.select` replaces the first, and whoever asked the first question can be left
 * awaiting a dialog that is no longer on screen — a session hanging with no visible
 * reason. So this extension asks one question at a time: a second concurrent
 * conflict is parked and reported instead of asked, and answered right after the
 * first. The tool call's own abort signal is passed to every dialog, so cancelling
 * the call closes the dialog rather than stranding it.
 */
let questionInFlight = false;

const DATE = Type.String({ description: "YYYY-MM-DD — the date this claim became true. Never invented, never defaulted to today." });
const CONFLICT_ID = Type.String({ pattern: "^[0-9a-f]{8}$", description: "The conflictId from a refusal. Required with resolve." });

export default function memoryExtension(pi: ExtensionAPI): void {
	const paths = memoryPaths();

	// Two memory extensions in one session means two injectors and two sets of
	// memory_* tools: an unreproducible prompt and names competing for the same
	// call. The live bank's extension is a real directory, not a symlink, so it is
	// detectable — and standing down is the only safe response.
	const collision = collisionReport(paths);
	if (collision !== null) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(`memory: standing down — another memory extension is loaded at ${collision}. Remove it (or symlink this component) to enable this one.`, "warning");
		});
		return;
	}

	const scopeContext = (ctx: ExtensionContext): ScopeContext => ({ project: basename(ctx.cwd) || undefined });

	// The day changes without asking. A stale daily file is archived and today's is
	// started with the open work carried forward — and the carry is reported, because
	// the version of this behaviour that shipped before silently dropped every
	// heading it did not recognise.
	pi.on("session_start", (_event, ctx) => {
		const service = createService(paths);
		// Rollover first, so the archive records the file as it was written. Carrying
		// already dates the items it carries. Stamping the live file is only for the
		// case where nothing rolled over: an undated item can never be aged, so it
		// would be carried forever.
		const rollover = service.rollDaily();
		if (!rollover.performed) {
			const stamped = service.stampDaily();
			if (stamped.stamped > 0) ctx.ui.notify(`memory: dated ${stamped.stamped} open item(s) in core/dailyContext.md (${stamped.date}) so they can age in a later rollover.`, "info");
		}
		if (rollover.performed) {
			ctx.ui.notify(rollover.notice, "info");
			if (rollover.notCarried > 0) ctx.ui.notify(`memory: ${rollover.notCarried} section(s) were archived without being carried — run /memory daily to see them.`, "info");
			return;
		}
		if (rollover.reason.startsWith("archive ")) ctx.ui.notify(`memory: ${rollover.reason}`, "warning");
		else if (rollover.status.freshness.needsDate && rollover.status.exists) {
			ctx.ui.notify(`memory: core/dailyContext.md has no \`- date:\` field; assumed ${rollover.status.freshness.date?.date ?? "today"} from its modification time. Add the field so rollover is exact.`, "warning");
		}
	});

	const askFactory = (ctx: ExtensionToolContext | ExtensionContext, signal?: AbortSignal): AskFn => async (refusal, request) => {
		if (!ctx.hasUI) return null;
		// The caller has already gone away, or a question is already on screen. Do not
		// open a second dialog: `service.ts` parked this contest before calling, so
		// returning null is a clean "ask later", not a lost write.
		if (signal?.aborted === true || questionInFlight) return null;
		questionInFlight = true;
		try {
			const shown = RESOLUTIONS.map((resolution) => RESOLUTION_LABELS[resolution] ?? resolution);
			const picked = await ctx.ui.select(contestTitle(`Memory conflict — ${formatIdentity(refusal.identity)}`, refusal.incoming, refusal.candidates, refusal.explanation, refusal.conflictId, refusal.suggested), shown, { signal: signal ?? ctx.signal });
			if (picked === undefined) return null;
			const resolution = RESOLUTIONS[shown.indexOf(picked)];
			if (resolution === undefined) return null;

			let mergedBody: string | undefined;
			if (resolution === "merge") {
				const typed = await ctx.ui.input(`Merge ${refusal.incoming.key} — type the one claim that replaces both`, sidesPreview(refusal.incoming, refusal.candidates), { signal: signal ?? ctx.signal });
				if (!typed?.trim()) return null;
				mergedBody = typed.trim();
			}

			const why = await ctx.ui.input(`Why (${resolution})?`, "one line, recorded as provenance — blank to skip", { signal: signal ?? ctx.signal });
			return { resolution, ...(mergedBody ? { mergedBody } : {}), ...(why?.trim() ? { note: why.trim() } : {}) };
		} finally {
			questionInFlight = false;
		}
	};

	pi.on("before_agent_start", async (event, ctx) => {
		// Only prompt-driven runs carry a query to inject for.
		if (!("prompt" in event) || typeof event.prompt !== "string") return;

		const service = createService(paths);
		const injection = service.injection(event.prompt, scopeContext(ctx));
		const queue = service.pending();
		const daily = service.daily();
		if (injection.text === "" && queue.conflicts.length === 0 && queue.corrupt.length === 0 && !daily.freshness.stale) return;

		const parts = [injection.text];
		if (queue.conflicts.length > 0) {
			parts.push(
				`## Memory conflicts awaiting a decision\n${queue.conflicts.map(describePendingForPrompt).join("\n")}`,
			);
		}
		if (queue.corrupt.length > 0) {
			parts.push(`## Memory queue damage\n${queue.corrupt.map((problem) => `- ${problem.file}: ${problem.error}`).join("\n")}`);
		}
		if (daily.freshness.stale) {
			const when = daily.freshness.date?.date ?? "unknown";
			const why = daily.freshness.date?.source === "mtime" ? ", dated by file mtime because the file has no date field" : "";
			parts.push(`## Daily context freshness\ncore/dailyContext.md is dated ${when} (${describeAge(daily.freshness.ageDays).trim()}${why}). Unfinished items in it may no longer be true; say so rather than repeating them.`);
		}

		return { message: { customType: "memory", content: parts.filter((part) => part !== "").join("\n\n"), display: false } };
	});

	// ── Tools ────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "memory_write",
		label: "Memory Write",
		description:
			"Add or amend an entry in the memory bank's entry store (knowledge/<topic>.md). " +
			"A write that would put two live claims on one assertion key and scope is refused — nothing is written. " +
			`A refusal returns a conflictId; answer it by re-invoking with resolve (${RESOLUTIONS.join(" | ")}) and that conflictId.`,
		promptSnippet: "Add or amend a memory entry (keyed claim with scope, kind and date); rival claims are refused until resolved",
		promptGuidelines: [
			"asOf is the date the claim became true. Never invent it and never default it to today: authority between claims is decided by date, so a wrong date silently outranks a real one.",
			"scope: global only for a claim that is true everywhere. A rule for one repository belongs in project:<name>, a rule for part of a tree in path:<glob>.",
			"file is knowledge/<topic>.md. Entries live in topic files — never one file per claim, which is what makes collisions unavoidable.",
			"Writing the same heading again amends that entry. Using a different revision (key@YYYY-MM-DD) creates a second claim on the same assertion, which is a conflict.",
			"If the result is CONFLICT, do not pick a winner yourself: ask the human which claim stands, then re-invoke the same write with resolve and conflictId.",
		],
		parameters: Type.Object({
			file: Type.String({ description: 'Topic file, e.g. "knowledge/ui.md".' }),
			key: Type.String({ description: 'Assertion key, e.g. "ui.background". Lowercase dotted slug.' }),
			scope: Type.String({ description: '"global", "project:<name>", or "path:<glob>".' }),
			kind: Type.String({ description: "rule | preference | decision | fact | procedure | gotcha" }),
			body: Type.String({ description: "The claim itself, in one or two sentences." }),
			asOf: DATE,
			source: Type.Optional(Type.String({ description: "Who said it, where: PR review, Slack thread, user request." })),
			revision: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Heading suffix key@YYYY-MM-DD, for a claim with an explicit history." })),
			status: Type.Optional(Type.String({ description: "active (default) | superseded | withdrawn. Only write tombstones when replacing or retiring a claim." })),
			resolve: Type.Optional(Type.String({ description: `${RESOLUTIONS.join(" | ")} — only in the second call, answering a refusal.` })),
			conflictId: Type.Optional(CONFLICT_ID),
			mergedBody: Type.Optional(Type.String({ description: "Required with resolve: merge. The single claim that replaces both." })),
			note: Type.Optional(Type.String({ description: "One line on why this decision was made. Recorded as provenance." })),
			fields: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra fields kept verbatim; this schema does not read them." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const request: WriteRequest = {
				file: params.file,
				key: params.key,
				scope: params.scope,
				kind: params.kind,
				body: params.body,
				asOf: params.asOf,
				...(params.source ? { source: params.source } : {}),
				...(params.revision ? { revision: params.revision } : {}),
				...(params.status ? { status: params.status } : {}),
				...(params.resolve ? { resolve: params.resolve as WriteRequest["resolve"] } : {}),
				...(params.conflictId ? { conflictId: params.conflictId } : {}),
				...(params.mergedBody ? { mergedBody: params.mergedBody } : {}),
				...(params.note ? { note: params.note } : {}),
				...(params.fields ? { fields: params.fields } : {}),
			};
			const service = createService(paths, ctx.hasUI ? { ask: askFactory(ctx, signal) } : {});
			const outcome = await service.write(request);
			return toolResult(formatOutcome(outcome), outcome, outcome.kind === "rejected");
		},
	});

	pi.registerTool({
		name: "memory_show",
		label: "Memory Show",
		description: "Every claim for one assertion key — which one is authoritative in this context, which are retired, which are shadowed by a narrower scope, and whether the key is contested.",
		promptSnippet: "Show all claims for a memory key and which one currently wins",
		parameters: Type.Object({ key: Type.String({ description: 'Assertion key, e.g. "ui.background".' }) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const report = createService(paths).show(params.key, scopeContext(ctx));
			return toolResult(formatKeyReport(report), report, report.contested);
		},
	});

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: "Candidate entries for a query, ranked. Candidates only: authority is decided by the store, so a hit is not an answer and the current claim may differ.",
		promptSnippet: "Find candidate memory entries for a query (candidates, not authorities)",
		parameters: Type.Object({
			query: Type.String({ description: "Words to match against entry keys and bodies." }),
			limit: Type.Optional(Type.Number({ description: "Max candidates, default 12." })),
		}),
		async execute(_toolCallId, params) {
			const hits = createService(paths).search(params.query, params.limit ?? 12);
			return toolResult(formatCandidates(hits), hits);
		},
	});

	pi.registerTool({
		name: "memory_doctor",
		label: "Memory Doctor",
		description: "Health of the entry store: entry counts by status, malformed entries, contested identities, dangling or ambiguous supersede references, unreadable files, and the queue of unanswered conflicts.",
		promptSnippet: "Report memory store problems: contested keys, malformed entries, dangling references, pending conflicts",
		parameters: Type.Object({}),
		async execute() {
			const service = createService(paths);
			const report = service.doctor();
			const queue = service.pending();
			const unhealthy = report.violations.length + report.contested.length + report.unreadable.length + report.corruptQueue.length + report.unkeyed.length > 0;
			const daily = service.daily();
			return toolResult(`${formatDoctor(report)}\n\n${formatDaily(daily)}\n\n${formatQueue(queue)}`, { report, queue, daily }, unhealthy || daily.freshness.stale);
		},
	});

	// ── Command ──────────────────────────────────────────────────────────────

	pi.registerCommand("memory", {
		description: "Memory store: doctor | pending | resolve <id> | show <key> | files | daily",
		handler: async (args, ctx) => {
			const service = createService(paths, ctx.hasUI ? { ask: askFactory(ctx) } : {});
			const [subcommand, ...rest] = args.trim().split(/\s+/);

			switch (subcommand) {
				case undefined:
				case "help":
					return ctx.ui.notify("memory doctor | pending | resolve <id> | show <key> | files | daily", "info");
				case "doctor": {
					const report = service.doctor();
					return ctx.ui.notify(`${formatDoctor(report)}\n\n${formatQueue(service.pending())}`, report.violations.length > 0 ? "warning" : "info");
				}
				case "pending":
					return ctx.ui.notify(formatQueue(service.pending()), "info");
				case "daily": {
					const status = service.daily();
					const rollover = service.rollDaily();
					const extra = rollover.performed ? `\n\n${rollover.notice}` : rollover.reason === "the daily file is already current" ? "" : `\n\nNot rolled over: ${rollover.reason}`;
					return ctx.ui.notify(`${formatDaily(service.daily())}${extra}`, rollover.performed ? "info" : "warning");
				}
				case "files":
					return ctx.ui.notify(service.doctor().files.join("\n") || "no entry stores yet", "info");
				case "show": {
					if (!rest[0]) return ctx.ui.notify("memory show <key>", "error");
					return ctx.ui.notify(formatKeyReport(service.show(rest[0], scopeContext(ctx))), "info");
				}
				case "resolve": {
					const id = rest[0];
					if (!id) return ctx.ui.notify("memory resolve <conflictId>", "error");
					const queued = service.pending().conflicts.find((conflict) => conflict.id === id);
					if (!queued) return ctx.ui.notify(`No pending conflict ${id}.`, "error");
					const choice = ctx.hasUI ? await askNow(ctx, queued) : askByFlag(rest, queued);
					if (choice === null) {
						// No UI means no dialog, so the answer has to be spelled out here —
						// and the contest has to be readable, or the flag is a blind choice.
						const hint = ctx.hasUI
							? ""
							: `${renderConflict(queued)}\nPass --resolve=<${RESOLUTIONS.join("|")}>${queued.suggested ? ` (suggested: ${queued.suggested})` : ""}, optionally --merged=<text> and --note=<why>.`;
						return ctx.ui.notify([`Left open. ${id} is still pending — nothing was written.`, hint].filter(Boolean).join("\n\n"), "warning");
					}
					const outcome = await service.resolveQueued(id, choice);
					return ctx.ui.notify(formatOutcome(outcome), outcome.kind === "rejected" ? "error" : "info");
				}
				default:
					return ctx.ui.notify(`Unknown subcommand "${subcommand}". Try: doctor | pending | resolve <id> | show <key> | files | daily`, "error");
			}
		},
	});
}

// ─── Asking, in the two ways Pi allows it ───────────────────────────────────

async function askNow(ctx: ExtensionContext, conflict: PendingConflict, signal?: AbortSignal): Promise<ResolutionChoice | null> {
	if (questionInFlight || signal?.aborted === true) return null;
	questionInFlight = true;
	try {
		const shown = RESOLUTIONS.map((resolution) => RESOLUTION_LABELS[resolution] ?? resolution);
		const picked = await ctx.ui.select(contestTitle(`Resolve ${conflict.id} — ${formatIdentity(conflict.identity)}`, conflict.incoming, conflict.candidates, conflict.explanation, conflict.id, conflict.suggested), shown, { signal: signal ?? ctx.signal });
		if (picked === undefined) return null;
		const resolution = RESOLUTIONS[shown.indexOf(picked)];
		if (resolution === undefined) return null;

		let mergedBody: string | undefined;
		if (resolution === "merge") {
			const typed = await ctx.ui.input(`Merge ${conflict.request.key} — type the one claim that replaces both`, sidesPreview(conflict.incoming, conflict.candidates), { signal: signal ?? ctx.signal });
			if (!typed?.trim()) return null;
			mergedBody = typed.trim();
		}
		const why = await ctx.ui.input(`Why (${resolution})?`, "one line, recorded as provenance — blank to skip", { signal: signal ?? ctx.signal });
		return { resolution, ...(mergedBody ? { mergedBody } : {}), ...(why?.trim() ? { note: why.trim() } : {}) };
	} finally {
		questionInFlight = false;
	}
}

/** No-UI path: the decision has to arrive on the command line. */
function askByFlag(rest: string[], conflict: PendingConflict): ResolutionChoice | null {
	const index = rest.findIndex((token) => token.startsWith("--resolve="));
	// Nothing is guessed: `suggested` is a hint, not an answer.
	if (index === -1) return null;
	const resolution = RESOLUTIONS.find((candidate) => candidate === rest[index]!.slice("--resolve=".length));
	if (resolution === undefined) return null;
	const merged = rest.find((token) => token.startsWith("--merged="));
	const note = rest.find((token) => token.startsWith("--note="));
	return { resolution, ...(merged ? { mergedBody: merged.slice("--merged=".length) } : {}), ...(note ? { note: note.slice("--note=".length) } : {}) };
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/** What an unanswered contest looks like in the per-turn notice: both claims, in the
 *  space a prompt can spare. One line of "there is a conflict" is not enough for the
 *  human to decide, and the agent relaying it needs something to relay. */
function describePendingForPrompt(conflict: PendingConflict): string {
	const others = conflict.candidates.length > 1 ? ` (+${conflict.candidates.length - 1} more)` : "";
	return [
		`- ${conflict.id}: ${formatIdentity(conflict.identity)} in ${conflict.file} (asked ${conflict.createdAt})`,
		`  the bank says: ${conflict.candidates[0] ? clip(conflict.candidates[0].body, 200) : "(no live claim)"}${others}`,
		`  being written: ${clip(conflict.incoming.body, 200)}`,
		`  why: ${clip(conflict.explanation.split(" Re-invoke with resolve:")[0] ?? conflict.explanation, 120)}`,
		`  full text: memory_show ${conflict.request.key}. Decide with /memory resolve ${conflict.id}, or memory_write + resolve + conflictId — and do not pick a winner yourself.`,
	].join("\n");
}

function describeAge(ageDays: number | null): string {
	if (ageDays === null) return "unknown age";
	if (ageDays < 0) return `dated ${-ageDays} day(s) in the future — check its \`- date:\` field or the clock`;
	return ageDays === 0 ? "today" : `${ageDays} day(s) old`;
}

	// The two sides, the rule that refused the write, and how to defer: what a person
	// needs in order to choose. Options alone are not a decision they can make.

/** The two sides, the rule that refused the write, and how to defer: what a person
 *  needs in order to choose. Options alone are not a decision they can make. */
function contestTitle(headline: string, incoming: ContestSide, candidates: ContestSide[], explanation: string, conflictId: string, suggested?: Resolution): string {
	const contest = formatContest({ incoming, candidates, explanation }, { truncate: 300 });
	// A hint, not an answer: shown so the human knows what the dates alone would have
	// decided, and ignorable just as legitimately.
	return [headline, "", contest, "", `Esc leaves it queued — /memory resolve ${conflictId}. Nothing is written until you choose.${suggested ? ` (the dates alone would suggest: ${suggested})` : ""}`].join("\n");
}

/** The two claims, one line each: what a merge has to reconcile, in view while typing. */
function sidesPreview(incoming: ContestSide, candidates: ContestSide[]): string {
	const one = (side: ContestSide) => side.body.replace(/\s+/g, " ").slice(0, 120);
	return [`bank: ${one(candidates[0] ?? { heading: "", body: "(none)" })}`, `new:   ${one(incoming)}`].join("\n");
}


/** `details` is the structured outcome: logs and renderers get the real shape
 *  instead of a re-derivation from the text the model reads. */
function toolResult<T>(text: string, details: T, isError = false): AgentToolResult<T> {
	return { content: [{ type: "text", text }], details, isError };
}

function formatOutcome(outcome: WriteOutcome): string {
	const lines = [outcome.summary];
	if (outcome.contest) lines.push("", outcome.contest);
	if (outcome.instructions) lines.push("", outcome.instructions);
	if (outcome.warnings?.length) lines.push("", ...outcome.warnings.map((warning) => `warning: ${warning}`));
	if (outcome.issues?.length) lines.push("", ...outcome.issues.map((issue) => `${issue.severity} [${issue.code}] ${issue.message}`));
	return lines.join("\n");
}

function formatKeyReport(report: KeyReport): string {
	if (report.claims.length === 0) return `No claims for "${report.key}".`;

	const lines = [report.contested ? `CONTESTED: "${report.key}" has no authority — the store holds more than one live claim.` : `Authority for "${report.key}": ${report.authority ? `${report.authority.path}#${report.authority.heading}` : "none injectable"}`];
	lines.push("", "Claims:");
	for (const entry of report.claims) {
		lines.push(`- ${entry.path}#${entry.heading} [${entry.status}] ${entry.kind} · ${entry.scope.level}${entry.asOf ? ` · ${entry.asOf}` : ""}${entry.supersededBy ? ` → superseded by ${entry.supersededBy}` : ""}`);
		lines.push(`    ${entry.body.replace(/\s+/g, " ")}`);
	}
	if (report.plan && report.plan.shadowed.length > 0) {
		lines.push("", "Shadowed for this context:");
		for (const shadow of report.plan.shadowed) lines.push(`- ${shadow.entry.path}#${shadow.entry.heading}: ${shadow.reason}${shadow.by ? ` (by ${shadow.by.path}#${shadow.by.heading})` : ""}`);
	}
	if (report.plan && report.plan.outOfScope.length > 0) {
		lines.push("", "Out of scope here:");
		for (const shadow of report.plan.outOfScope) lines.push(`- ${shadow.entry.path}#${shadow.entry.heading}: ${shadow.reason}`);
	}
	return lines.join("\n");
}

function formatCandidates(hits: Candidate[]): string {
	if (hits.length === 0) return "No candidate entries matched.";
	return [
		`${hits.length} candidate(s). Candidates are not answers — check the authority with memory_show.`,
		...hits.map((hit) => `- ${hit.entry.path}#${hit.entry.heading} [${hit.entry.status}] ${hit.entry.kind} · ${hit.entry.scope.level}${hit.entry.asOf ? ` · ${hit.entry.asOf}` : ""} — matched: ${hit.matched.join(", ")}`),
	].join("\n");
}

function formatDoctor(report: DoctorReport): string {
	const lines = [
		`Bank: ${report.bankRoot}`,
		`Entry stores: ${report.files.length}; entries: ${report.entries} (active ${report.byStatus.active}, superseded ${report.byStatus.superseded}, withdrawn ${report.byStatus.withdrawn})`,
	];
	if (report.contested.length > 0) lines.push("", "Contested identities:", ...report.contested.map((entry) => `- ${entry.identity}: ${entry.candidates.join(", ")}`));
	if (report.violations.length > 0) lines.push("", "Violations:", ...report.violations.map((violation) => `- ${violation.code} ${violation.path}#${violation.key ?? ""}: ${violation.message}`));
	if (report.unkeyed.length > 0) lines.push("", "Headings that are not assertion keys:", ...report.unkeyed.map((entry) => `- ${entry}`));
	if (report.unreadable.length > 0) lines.push("", "Unreadable files:", ...report.unreadable.map((problem) => `- ${problem.path}: ${problem.error}`));
	if (report.emptyFiles.length > 0) lines.push("", "Stores with no entries:", ...report.emptyFiles.map((file) => `- ${file}`));
	if (report.contested.length === 0 && report.violations.length === 0 && report.unkeyed.length === 0 && report.unreadable.length === 0) lines.push("", "No structural problems found.");
	return lines.join("\n");
}

function formatDaily(status: DailyStatus): string {
	if (!status.exists) return "Daily context: no core/dailyContext.md yet.";
	const { date, ageDays, stale, needsDate } = status.freshness;
	const when = date === null ? "undated" : `${date.date}${date.source === "mtime" ? " (dated by file mtime)" : ""}`;
	const age = ageDays === null ? "" : ` (${describeAge(ageDays)})`;
	return `Daily context: ${when}${age}${stale ? " — stale; it will be archived and carried at the next session start" : ""}${needsDate ? " — add a `- date: YYYY-MM-DD` line so rollover does not have to guess" : ""}.`;
}

function formatQueue(queue: PendingList): string {
	if (queue.conflicts.length === 0 && queue.corrupt.length === 0) return "Pending conflicts: none.";
	const lines = [`Pending conflicts: ${queue.conflicts.length}`];
	for (const conflict of queue.conflicts) {
		lines.push("", `${conflict.id} — ${formatIdentity(conflict.identity)} (asked ${conflict.createdAt}, aimed at ${conflict.file})`, `Incoming: ${conflict.incoming.body.replace(/\s+/g, " ")}`);
		for (const candidate of conflict.candidates) lines.push(`Live: ${candidate.path}#${candidate.heading}${candidate.asOf ? ` (${candidate.asOf})` : ""}: ${candidate.body.replace(/\s+/g, " ")}`);
		lines.push(`Suggested: ${conflict.suggested}. Answer with memory_write + resolve + conflictId, or /memory resolve ${conflict.id}.`);
	}
	if (queue.corrupt.length > 0) lines.push("", "Unreadable queue files:", ...queue.corrupt.map((problem) => `- ${problem.file}: ${problem.error}`));
	return lines.join("\n");
}
