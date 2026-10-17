/**
 * The Pi adapter: tools, the `/memory` command, and the two hooks. Nothing here
 * decides anything about memory — `bank.ts` and the modules behind it do. This
 * file only translates between Pi's shapes and the bank, and owns the two things
 * that are Pi facts rather than memory facts:
 *
 *  - who can be asked (mode and dialog availability), and
 *  - which runs get an injected block (only runs a user started, R25).
 */

import { existsSync } from "node:fs";

import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createBank, type Bank, type Outcome } from "./bank.js";
import { createNoticeSink, type NoticeSink } from "./notice.js";
import { openReview, type ReviewItem } from "./review.js";
import { DAILY_SECTIONS } from "./daily.js";
import { bankExists, describePaths } from "./store.js";

const KIND = Type.String({ description: "rule | fact. A rule says how Rodrigo works; a fact says what is true." });
const SCOPE = Type.String({
	description: '"global", "project:<id>" (the id is shown by /memory status), or "path:<glob>" rooted at the repo.',
});
const ASOF = Type.String({ description: "YYYY-MM-DD — the date this became true. Never invented, never defaulted to today." });
const KEY = Type.String({ description: "Lowercase dotted slug, e.g. git.flow." });
const BODY = Type.String({ description: "The claim itself: one paragraph, at most 600 characters, no status text." });
const LIST = Type.Optional(Type.Array(Type.String(), { description: 'Values are plain words; ";" is the separator when written to the file.' }));

function toolResult(text: string, details: unknown, isError = false): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details, isError } as AgentToolResult<unknown>;
}

/**
 * Overrides recorded in this process, reported per injected turn so the trial can
 * tell whether the status detector is too strict (R24, R43).
 */
let overridesThisSession = 0;

/**
 * One notice channel per extension instance and mode, so "once per process"
 * really means once: two session_starts in one session do not repeat the notice.
 */
let sink: NoticeSink | undefined;
let sinkMode: string | undefined;

function noticeSinkFor(ctx: ExtensionContext): NoticeSink {
	if (!sink || sinkMode !== ctx.mode) {
		sink = createNoticeSink({
			isTui: ctx.mode === "tui",
			notify: (text) => ctx.ui.notify(text, "info"),
			log: (text) => console.warn(text),
		});
		sinkMode = ctx.mode;
	}
	return sink;
}

/**
 * Test seam (the repo's null-gated pattern, because Pi extensions are loaded by
 * jiti and Node has no ESM module mocking): a test hands in a `Bank` pointed at a
 * scratch bank with its own clock and git probe, so no test ever reads or writes
 * the live `~/.pi/memory`.
 */
let bankForTesting: Bank | undefined;

export function setBankForTesting(bank: Bank | null): void {
	bankForTesting = bank ?? undefined;
}

export default function memoryExtension(pi: ExtensionAPI): void {
	const bank: Bank = bankForTesting ?? createBank();
	let warnedAbout = "";

	const warnOnce = (ctx: ExtensionContext, message: string): void => {
		if (warnedAbout === message) return;
		warnedAbout = message;
		ctx.ui.notify(message, "warning");
	};

	const bankDamage = (): string[] => {
		const damage: string[] = [];
		if (!bankExists(bank.paths)) damage.push(`no memory bank yet at ${bank.paths.root}`);
		return damage;
	};

	// ── Hooks ────────────────────────────────────────────────────────────────

	pi.on("session_start", async (event, ctx) => {
		// A resumed session has been told already; a reload is not a new session.
		if (event.reason !== "new" && event.reason !== "startup" && event.reason !== "fork") return;
		if (!existsSync(bank.paths.root)) return;
		const rolled = bank.rollover();
		if (rolled.archivedTo && ctx.mode === "tui") ctx.ui.notify(`memory: yesterday's log is archived (${rolled.archivedTo}), ${rolled.carried} open item(s) carried`, "info");
		const notice = await bank.notice(ctx.cwd, { bankDamage: bankDamage() });
		if (notice.text === "") return;
		noticeSinkFor(ctx).deliver(notice.text);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// Only a user-started run carries a prompt to answer (R25). A run started
		// by an extension message gets no injection: it is not a question.
		if (event.messageType !== "user") return;
		try {
			bank.rollover();
			const { result, warnings } = await bank.injection(event.prompt, ctx.cwd, ctx.sessionManager.getSessionId(), {
				overridesRecorded: overridesThisSession,
			});
			for (const warning of warnings) warnOnce(ctx, `memory: ${warning}`);
			if (result.contested.length > 0) warnOnce(ctx, `memory: ${result.contested.length} contested identity(ies) — nothing is asserted for them; /memory review`);
			if (result.text === "") return;
			return {
				message: { customType: "memory", content: result.text, display: false },
			};
		} catch (error) {
			// Fail open (R30): one visible warning, and the turn proceeds without memory.
			warnOnce(ctx, `memory: injection skipped — ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
	});

	// ── Read tools (names unchanged, R41) ────────────────────────────────────

	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description:
			"Read a file inside the memory bank by bank-relative path — claims/, history/, daily/, archive/, metrics/. " +
			"History and archives are searchable and readable but never injected.",
		promptSnippet: "Read a memory-bank file by path (claims, history, daily archive, migration archive)",
		parameters: Type.Object({
			path: Type.String({ description: 'Bank-relative path, e.g. "claims/rules/git.md" or "history/git.flow.md".' }),
			maxBytes: Type.Optional(Type.Number({ description: "Cut-off in characters, default 20000. A cut is reported, never silent." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const outcome = bank.read(params.path, { maxBytes: params.maxBytes });
			return toolResult(outcome.text, outcome, !outcome.ok);
		},
	});

	pi.registerTool({
		name: "memory_list",
		label: "Memory List",
		description: "List what is in the memory bank: claim stores, history, daily archive, migration archive, metrics.",
		promptSnippet: "List the memory bank's files",
		parameters: Type.Object({ dir: Type.Optional(Type.String({ description: 'Bank-relative directory, default the bank root ("").' })) }),
		async execute(_id, params) {
			const outcome = bank.list(params.dir ?? "");
			return toolResult(outcome.text, outcome, !outcome.ok);
		},
	});

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Rank matches over approved claims, pending claims (including the migration backlog), history, the daily archive and the migration archive. " +
			"Each hit is labelled with where it came from. A candidate list: authority is decided by the store, so a hit is not an answer.",
		promptSnippet: "Find memory entries by words across claims, history and archives (candidates, not authorities)",
		parameters: Type.Object({
			query: Type.String({ description: "Words to match against keys, aliases, tags and bodies." }),
			limit: Type.Optional(Type.Number({ description: "Max hits, default from config (12)." })),
		}),
		async execute(_id, params) {
			const outcome = bank.search(params.query, params.limit ?? 0);
			return toolResult(outcome.text, outcome, !outcome.ok);
		},
	});

	// ── Write tools (the only two write names, R41) ─────────────────────────

	pi.registerTool({
		name: "memory_log",
		label: "Memory Log",
		description:
			"Append one item to today's daily log — the only place project status belongs. " +
			"The extension stamps the date and time; the agent cannot set them.",
		promptSnippet: "Log one daily item (completed | in_progress | carry | decision | note); the date is stamped for you",
		promptGuidelines: [
			"Commit SHAs, PR/issue/run numbers, CI links and dated status verbs belong in memory_log, never in a claim body.",
			"Sections: completed, in_progress, carry, decision, note. carry is work that follows the day over.",
		],
		parameters: Type.Object({
			section: Type.String({ description: DAILY_SECTIONS.join(" | ") }),
			text: Type.String({ description: "One item, plain prose." }),
		}),
		async execute(_id, params) {
			const outcome = bank.log({ section: params.section, text: params.text });
			return toolResult(outcome.text, outcome, !outcome.ok);
		},
	});

	pi.registerTool({
		name: "memory_propose",
		label: "Memory Propose",
		description:
			"Propose a rule or a fact. It lands as a PENDING claim: the agent can never write an approved claim. " +
			"A proposal against an existing claim waits in the queue beside it, and only the approved claim injects until Rodrigo reviews.",
		promptSnippet: "Propose a rule or fact (pending; a human approves it)",
		promptGuidelines: [
			"asOf is the date the claim became true. Never invent it and never default it to today — a wrong date silently outranks a real one.",
			"scope: global only for a claim true everywhere; project:<id> for one repository (the id is in /memory status); path:<glob> for part of a tree.",
			"One claim per call. A change to an existing key is a new proposal for that same key: never write 'superseded' or 'no longer' in a body.",
			"A body that reads as status (SHAs, PR numbers, CI URLs, dated verbs) is refused and pointed at memory_log; overrideStatusCheck needs a reason.",
			"Tag a rule 'always' only when it must be injected every turn; every other rule is injected when the request relates to it.",
		],
		parameters: Type.Object({
			key: KEY,
			kind: KIND,
			scope: SCOPE,
			asOf: ASOF,
			source: Type.String({ description: "Where this came from: a person, a thread, a decision. Never filled in for you." }),
			body: BODY,
			aliases: LIST,
			tags: LIST,
			links: LIST,
			origin: Type.Optional(Type.String({ description: "agent (default) | migration. Migration claims are never injected until approved." })),
			overrideStatusCheck: Type.Optional(Type.Boolean({ description: "Insist the body is a rule or a fact after a status refusal." })),
			overrideReason: Type.Optional(Type.String({ description: "Required with overrideStatusCheck; stored on the claim and shown in review." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const outcome = bank.proposeClaim(params as Parameters<Bank["proposeClaim"]>[0]);
			if (params.overrideStatusCheck && outcome.ok) overridesThisSession++;
			const against = outcome.data?.against;
			if (outcome.ok && against !== undefined && bank.config().config.inlineConflictDialog && ctx.mode === "tui" && ctx.hasUI) {
				// R19: one dialog, right away, beside the claim it would replace. It is
				// awaited inside the tool call, so cancelling the call cancels the ask.
				const decision = await decideNow(ctx, String(params.key), String(params.scope), against.body, String(params.body));
				return toolResult(`${outcome.text}\n${decision}`, outcome, false);
			}
			return toolResult(outcome.text, outcome, !outcome.ok);
		},
	});

	pi.registerTool({
		name: "memory_archive",
		label: "Memory Archive",
		description:
			"Move text that is neither a claim nor a daily item — leftover status prose from migration — into the read-only archive. " +
			"Nothing is deleted: archives stay, are searchable, and are never injected.",
		promptSnippet: "Archive leftover prose as read-only (searchable, never injected)",
		parameters: Type.Object({
			name: Type.String({ description: 'File name for the archive entry, e.g. "status-2026-W42".' }),
			text: Type.String({ description: "The prose, as it was written." }),
		}),
		async execute(_id, params) {
			const outcome = bank.archive(params.name, params.text);
			return toolResult(outcome.text, outcome, !outcome.ok);
		},
	});

	// ── The /memory command ──────────────────────────────────────────────────

	pi.registerCommand("memory", {
		description: paletteDescription(),
		getArgumentCompletions: completeSubcommands,
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter((part) => part !== "");
			const sub = parts[0] ?? "status";
			const rest = parts.slice(1);
			const outcome = await dispatch(sub, rest, ctx);
			if (outcome.text !== "") ctx.ui.notify(outcome.text.split("\n").slice(0, 40).join("\n"), outcome.ok ? "info" : "warning");
		},
	});

	async function dispatch(sub: string, rest: string[], ctx: ExtensionCommandContext): Promise<Outcome> {
		const listed = MEMORY_SUBCOMMANDS.some((command) => command.name === sub || command.also?.includes(sub));
		switch (sub) {
			case "status":
				return bank.status(ctx.cwd);
			case "help":
				return { ok: true, text: HELP };
			case "preview":
				return bank.preview(rest.join(" "), ctx.cwd);
			case "review":
				return review(rest, ctx);
			case "approve":
			case "reject":
			case "defer":
			case "edit":
				return reviewAction(sub, rest);
			case "doctor":
				return bank.doctor();
			case "settings":
			case "config":
				return bank.settings();
			case "flag":
				return bank.flag(rest[0] ?? "", (rest[1] ?? "stale") as "stale" | "rival", ctx.sessionManager.getSessionId());
			case "flags":
				return bank.flagsList();
			case "trial":
				return trial(rest);
			case "migrate":
				return await migrate(rest);
			case "paths":
				return { ok: true, text: describePaths(bank.paths) };
			default:
				// A name the table lists but this switch does not handle is our bug, and calling it
				// "unknown subcommand" would send the reader looking for a typo they did not make.
				return listed
					? { ok: false, text: `memory: "/memory ${sub}" is listed in /memory help but nothing handles it — report it` }
					: { ok: false, text: `unknown /memory subcommand "${sub}" — try /memory help` };
		}
	}

	async function review(rest: string[], ctx: ExtensionCommandContext): Promise<Outcome> {
		const wave = rest[0] === "--wave" ? (rest[1] as "agent" | "migration") : undefined;
		const scope = wave === "agent" || wave === "migration" ? { wave } : {};
		const listed = bank.reviewList(scope);
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			return { ok: true, text: `${listed.text}\n\nNo dialog UI here: act with /memory approve|reject|defer <key> [scope], or --wave ${wave ?? "agent|migration"} for the batch.` };
		}
		if (listed.pending.length === 0) return { ok: true, text: listed.text };

		// One dialog for the whole batch, showing each claim's text. A selector
		// cannot carry the content, and a review that shows only the key is not a
		// review. Edit leaves the dialog, because no dialog opens inside a dialog.
		const summary: string[] = [];
		for (let pass = 0; pass <= listed.pending.length; pass++) {
			const items = reviewItems();
			if (items.length === 0) break;
			const result = await openReview(ctx.ui, items, {
				approve: (item) => bank.review("approve", item.key, item.scope).text,
				reject: (item) => bank.review("reject", item.key, item.scope).text,
				defer: (item) => bank.review("defer", item.key, item.scope).text,
			});
			for (const act of result.acted) summary.push(`${act.key}: ${act.action}`);
			if (result.edit === undefined) break;
			const edited = await ctx.ui.editor(`Edit ${result.edit.key} @ ${result.edit.scope} — the text as it stands now`, result.edit.body);
			if (edited === undefined || edited.trim() === result.edit.body.trim()) break;
			summary.push(bank.review("edit", result.edit.key, result.edit.scope, edited).text);
		}
		const counts = bank.queueCounts();
		return { ok: true, text: summary.length > 0 ? `${summary.join("\n")}\n\n${counts.total} claim(s) still await review.` : listed.text };

		function reviewItems(): ReviewItem[] {
			return bank.reviewList(scope).pending.map((entry) => ({
				key: entry.claim.key,
				scope: entry.claim.scope,
				kind: entry.claim.kind,
				asOf: entry.claim.asOf,
				source: entry.claim.source,
				origin: entry.claim.origin,
				tags: entry.claim.tags,
				body: entry.claim.body,
				replaces: entry.approved?.body,
				ageDays: entry.ageDays,
				flagged: entry.flagged,
				file: entry.file.startsWith(bank.paths.root) ? entry.file.slice(bank.paths.root.length + 1) : entry.file,
			}));
		}
	}

	function reviewAction(action: "approve" | "reject" | "defer" | "edit", rest: string[]): Outcome {
		const wave = flagValue(rest, "--wave");
		if (wave !== undefined && action !== "edit") return bank.reviewWave(action, wave === "agent" ? "agent" : "migration");
		if (wave !== undefined) return { ok: false, text: "edit is per claim: /memory edit <key> [scope] <new body>" };
		const key = rest[0] ?? "";
		if (key === "") return { ok: false, text: "usage: /memory approve|reject|defer|edit <key> [scope]" };
		const scope = rest[1] ?? "";
		if (action === "edit") {
			const body = rest.slice(2).join(" ");
			if (body === "") return { ok: false, text: "usage: /memory edit <key> [scope] <new body>" };
			return bank.review("edit", key, scope, body);
		}
		return bank.review(action, key, scope);
	}

	/**
	 * R19. Reached only when `inlineConflictDialog` is on and an approved claim would be
	 * replaced. Anything but an explicit choice leaves the claim pending: the safe
	 * answer is to defer to /memory review.
	 */
	async function decideNow(ctx: Pick<ExtensionToolContext, "ui" | "mode" | "hasUI">, key: string, scope: string, approved: string, proposed: string): Promise<string> {
		const clip = (text: string): string => (text.length > 70 ? `${text.slice(0, 67)}…` : text);
		const choice = await ctx.ui.select?.(
			`memory: ${key} @ ${scope} — replace the approved claim?`,
			[`keep: ${clip(approved)}`, `replace with: ${clip(proposed)}`, "decide later in /memory review"],
		);
		if (choice === undefined || choice === "decide later in /memory review") return "left pending: it will show in /memory review";
		const selected = choice.startsWith("keep") ? bank.review("reject", key, scope) : bank.review("approve", key, scope);
		return `decided now: ${selected.text}`;
	}
	function trial(rest: string[]): Outcome {
		const what = rest[0] ?? "report";
		if (what === "baseline") {
			const days = flagValue(rest, "--days");
			const marker = flagValue(rest, "--marker");
			const sessionsDir = flagValue(rest, "--sessions-dir");
			return bank.baseline({ days: days === undefined ? undefined : Number(days), marker, sessionsDir });
		}
		const days = rest[0] === "report" ? flagValue(rest, "--days") : rest[0];
		return bank.reportTrial(days === undefined ? undefined : Number(days));
	}

	async function migrate(rest: string[]): Promise<Outcome> {
		const step = rest[0] ?? "status";
		switch (step) {
			case "backup":
				// Awaited: the command is not finished until the tarball exists and has
				// been listed back, because every other migration step refuses until then.
				return await bank.migrateBackup();
			case "plan":
				return bank.migratePlan();
			case "status":
				return bank.migrateStatus();
			case "draft": {
				const positional = rest[1] !== undefined && !rest[1].startsWith("--") ? rest[1] : undefined;
				const batch = flagValue(rest, "--batch");
				return bank.migrateDraft({
					wave: flagValue(rest, "--wave") ?? positional,
					file: flagValue(rest, "--file"),
					batch: batch === undefined ? undefined : Number(batch),
				});
			}
			case "apply":
				return bank.migrateApply({
					wave: flagValue(rest, "--wave") ?? (rest[1] !== undefined && !rest[1].startsWith("--") ? rest[1] : undefined),
					all: rest.includes("--all"),
				});
			case "daily":
				return bank.migrateDaily();
			case "next":
				// Alias for a single-file draft brief.
				return bank.migrateDraft({ wave: rest[1] });
			case "drafted":
				return bank.migrateDrafted(rest[1] ?? "", Number(rest[2] ?? 0));
			case "cutover":
				return bank.migrateCutover();
			default:
				return { ok: false, text: `unknown /memory migrate step "${step}" — backup | plan | status | draft [--wave w] [--file f] [--batch n] | drafted <file> <n> | cutover` };
		}
	}
}

function flagValue(parts: string[], name: string): string | undefined {
	const at = parts.indexOf(name);
	return at >= 0 ? parts[at + 1] : undefined;
}

/**
 * Every subcommand in one table (R50). It renders `/memory help`, the line Pi
 * shows in its command list, and the argument completions, and `dispatch` calls a
 * name listed here but not handled our bug rather than the reader's typo. A
 * hand-written list drifted — it lost `settings` the day `settings` was added — so
 * the list a user reads and the code that answers it now share one source.
 */
export interface MemorySubcommand {
	name: string;
	/** What the caller types after the name. */
	args?: string;
	/** One line in the reader's words: no requirement IDs on screen (R49.2). */
	summary: string;
	/** Continuation lines for a command with forms of its own. */
	forms?: string[];
	/** Names that answer the same way, listed so help and completions both show them. */
	also?: string[];
}

export const MEMORY_SUBCOMMANDS: readonly MemorySubcommand[] = [
	{ name: "status", summary: "the bank, this project, the counts, and how fresh the daily log is" },
	{ name: "preview", args: "[prompt]", summary: "the exact block a turn would get, with tokens per section" },
	{ name: "review", summary: "walk the pending claims — a card in the TUI, a listing elsewhere", forms: ["[--wave agent | --wave migration] walks one wave of the queue"] },
	{ name: "approve", args: "<key> [scope]", summary: "take the proposed claim; the words it replaces go to history", forms: ["--wave agent|migration decides a whole batch at once"] },
	{ name: "reject", args: "<key> [scope]", summary: "refuse the proposal; what the store holds stays" },
	{ name: "defer", args: "<key> [scope]", summary: "leave the proposal pending for another day" },
	{ name: "edit", args: "<key> [scope] <body>", summary: "rewrite a pending claim's text" },
	{ name: "doctor", summary: "what is wrong with the bank, if anything" },
	{ name: "settings", summary: "every setting: the value in use, its default, its range, and where the file is", also: ["config"] },
	{ name: "paths", summary: "where the bank's files live" },
	{ name: "flag", args: "<key> stale|rival", summary: "mark an injected claim as stale or rival (input to the trial)" },
	{ name: "flags", summary: "every flag recorded" },
	{ name: "trial", args: "[days] | baseline", summary: "the week's numbers against the baseline, and the go/no-go", forms: ["baseline [--days n] [--marker text] [--sessions-dir path]"] },
	{ name: "migrate", summary: "move an old bank in, under a backup gate", forms: ["backup | plan | status | draft [--wave w] [--file f | --batch n] | drafted <file> <n>", "apply [--wave w | --all] | daily | cutover"] },
	{ name: "help", summary: "this list" },
];

const HELP_COLUMN = 34;

function helpText(): string {
	const lines: string[] = [];
	for (const command of MEMORY_SUBCOMMANDS) {
		const head = command.args ? `${command.name} ${command.args}` : command.name;
		const also = command.also?.length ? ` (also: ${command.also.join(", ")})` : "";
		if (head.length > HELP_COLUMN) {
			lines.push(`  ${head}`, `  ${"".padEnd(HELP_COLUMN)}${command.summary}${also}`);
		} else {
			lines.push(`  ${head.padEnd(HELP_COLUMN)}${command.summary}${also}`);
		}
		for (const form of command.forms ?? []) lines.push(`  ${"".padEnd(HELP_COLUMN)}${form}`);
	}
	return [
		"memory:",
		...lines,
		"",
		"Writes are memory_log (the daily log) and memory_propose (a pending claim).",
		"memory_read, memory_search and memory_list keep their old names.",
	].join("\n");
}

const HELP = helpText();

/**
 * The line Pi lists for the command: every name it answers, and an ellipsis when
 * they do not fit, so a short line says it is short instead of looking complete.
 */
export function paletteDescription(limit = 140): string {
	let text = "memory: status";
	for (const command of MEMORY_SUBCOMMANDS) {
		if (command.name === "status" || command.name === "help") continue;
		if (text.length + command.name.length + 3 > limit) return `${text} · … — /memory help`;
		text += ` · ${command.name}`;
	}
	return `${text} — /memory help`;
}

/**
 * Pi asks for completions of what was typed after `/memory`. Only the first word
 * is a subcommand; after it the words are keys, scopes and claim bodies, which are
 * the bank's business and not a fixed list (R50).
 */
function completeSubcommands(argumentPrefix: string): { value: string; label: string; description?: string }[] | null {
	if (/\s/.test(argumentPrefix)) return null;
	const items: { value: string; label: string; description?: string }[] = [];
	for (const command of MEMORY_SUBCOMMANDS) {
		for (const name of [command.name, ...(command.also ?? [])]) {
			if (name.startsWith(argumentPrefix)) items.push({ value: name, label: name, description: command.summary });
		}
	}
	return items;
}

export { HELP as MEMORY_HELP };
