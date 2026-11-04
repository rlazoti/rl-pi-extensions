/**
 * /context — what is in the context window right now, and what it costs.
 *
 * Three questions the status bar cannot answer: how full is the window, where did
 * the tokens go, and which specific message is the biggest one. The bar shows a
 * percentage; this shows the same total Pi's compaction code reads, split into
 * system prompt, tool definitions, tool calls, tool results, thinking and
 * conversation, plus the largest individual items by their Messages-tab index.
 *
 * ## Where the numbers come from
 *
 * A provider reports one number per request. Splitting it by category is an
 * estimate from text size (see `tokens.ts`), so the estimates are scaled to add up
 * to the measured total and the panel says so in its own footer. A breakdown that
 * quietly disagreed with the header number it was breaking down was the failure
 * this design avoids.
 *
 * ## Reading the host
 *
 * `ContextHost` is the whole surface this command touches, and it is loaded
 * lazily for two reasons: the module stays importable outside a running Pi (which
 * is what makes `buildSnapshot` and `readSources` testable), and a read that
 * fails becomes a line in the panel instead of a command that does not open.
 */

import type { CopyToClipboard, ViewerTab } from "./viewer.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildBudget, type ContextMessage } from "./tokens.js";
import {
	formatNumber,
	formatTokens,
	renderBudget,
	renderMessages,
	renderRaw,
	renderSystemPrompt,
	renderTools,
} from "./text.js";

/**
 * The running host, as this command needs it. `copy` resolves to an error message
 * on failure, because a failed copy is worth showing and not worth throwing.
 */
export interface ContextHost {
	sessionMessages(ctx: ExtensionCommandContext): Promise<ContextMessage[]>;
	copy(text: string): Promise<string | undefined>;
}

const piModule = () => import("@earendil-works/pi-coding-agent");

const liveHost: ContextHost = {
	async sessionMessages(ctx) {
		const { buildSessionContext } = (await piModule()) as unknown as {
			buildSessionContext: (entries: unknown[], leafId?: string | null) => { messages: unknown[] };
		};
		const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
		return context.messages as ContextMessage[];
	},
	async copy(text) {
		try {
			const { copyToClipboard } = (await piModule()) as unknown as {
				copyToClipboard: (text: string) => Promise<void>;
			};
			await copyToClipboard(text);
			return undefined;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	},
};

let host: ContextHost = liveHost;

/** Test seam: nothing in a test run may read the real session or the real clipboard. */
export function setHostForTesting(next: Partial<ContextHost> | null): void {
	host = next ? { ...liveHost, ...next } : liveHost;
}

/** The reads this command needs, every one of them optional. */
export interface ContextSources {
	systemPrompt?: string;
	tools?: Array<{ name?: string; description?: string; parameters?: unknown; promptGuidelines?: string[] }>;
	messages?: ContextMessage[];
	usage?: { tokens: number | null; contextWindow: number; percent: number | null } | null;
	model?: string;
	reserveTokens?: number | null;
	/** What could not be read, as the host reported it. Shown in the panel. */
	problems?: string[];
}

export interface Snapshot {
	overview: string;
	tabs: ViewerTab[];
	problems: string[];
}

/**
 * Build the tabs from host reads. Pure and synchronous, so the entire output of
 * the command can be asserted without a terminal, a session file, or a model.
 */
export function buildSnapshot(sources: ContextSources): Snapshot {
	const problems = [...(sources.problems ?? [])];
	const messages = Array.isArray(sources.messages) ? sources.messages : [];
	const tools = Array.isArray(sources.tools) ? sources.tools : [];
	const systemPrompt = typeof sources.systemPrompt === "string" ? sources.systemPrompt : undefined;
	if (systemPrompt === undefined) problems.push("no system prompt reported by the host");

	const usage = sources.usage ?? null;
	if (!usage) problems.push("no token usage reported by the host yet");

	const budget = buildBudget({
		systemPrompt,
		tools,
		messages,
		usageTokens: usage?.tokens ?? null,
		contextWindow: usage?.contextWindow ?? 0,
		reserveTokens: sources.reserveTokens ?? null,
	});

	const biggest = [...budget.rows].filter((row) => row.tokens > 0).sort((a, b) => b.tokens - a.tokens);
	const overview = [
		`${formatNumber(budget.total)} tokens`,
		budget.contextWindow > 0 ? `${formatPercentOf(budget.percent)} of window` : "",
		biggest.length > 0 ? biggest.map((row) => `${row.label} ${formatTokens(row.tokens)}`).join(", ") : "",
		`${budget.messages} message(s)`,
	]
		.filter(Boolean)
		.join(" · ");

	const tabs: ViewerTab[] = [
		{
			name: "Overview",
			hint: overview,
			lines: renderBudget(budget, { model: sources.model, problems }),
		},
		{
			name: "System",
			hint: `${formatNumber(systemPrompt?.length ?? 0)} characters of system prompt, ~${formatTokens(Math.ceil((systemPrompt?.length ?? 0) / 4))} tokens`,
			lines: renderSystemPrompt(systemPrompt),
		},
		{
			name: "Tools",
			hint: `${tools.length} tool(s) declared to the model`,
			lines: renderTools(tools),
		},
		{
			name: "Messages",
			hint: `${budget.messages} message(s) Pi would send${budget.images > 0 ? `, including ${budget.images} image block(s)` : ""}`,
			lines: renderMessages(messages),
		},
		{
			name: "Raw",
			hint: "JSON, one document per line: system prompt, tools, usage, then every message",
			lines: renderRaw({ systemPrompt, tools, messages, usage }),
		},
	];

	return { overview, tabs, problems };
}

function formatPercentOf(percent: number | null): string {
	return percent === null ? "window unknown" : `${percent.toFixed(1)}%`;
}

/** Tab index for `/context tools`; anything unknown opens the overview. */
export function tabForArgument(argument: string | undefined, tabNames: string[]): { index: number; unknown: boolean } {
	const aliases: Record<string, string> = {
		overview: "overview",
		where: "overview",
		stats: "overview",
		usage: "overview",
		budget: "overview",
		system: "system",
		prompt: "system",
		systemprompt: "system",
		tools: "tools",
		tool: "tools",
		messages: "messages",
		message: "messages",
		msgs: "messages",
		conversation: "messages",
		raw: "raw",
		json: "raw",
	};
	const arg = (argument ?? "").trim().toLowerCase();
	if (arg === "") return { index: 0, unknown: false };
	const target = aliases[arg];
	if (!target) return { index: 0, unknown: true };
	const index = tabNames.findIndex((name) => name.toLowerCase() === target);
	return index >= 0 ? { index, unknown: false } : { index: 0, unknown: true };
}

/**
 * Read the host. Every read is individually guarded: a host that cannot answer
 * one question still gets an answer to the rest, with the failure listed in
 * `problems`.
 */
export async function readSources(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<ContextSources> {
	const sources: ContextSources = { problems: [] };
	const note = (what: string, error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		sources.problems?.push(`could not read ${what}: ${message}`);
	};

	try {
		sources.systemPrompt = ctx.getSystemPrompt();
	} catch (error) {
		note("the system prompt", error);
	}

	try {
		const active = new Set(pi.getActiveTools());
		sources.tools = pi
			.getAllTools()
			.filter((tool) => active.has(tool.name))
			.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				promptGuidelines: tool.promptGuidelines,
			}));
	} catch (error) {
		note("the tool definitions", error);
	}

	try {
		sources.messages = await host.sessionMessages(ctx);
	} catch (error) {
		note("the session", error);
	}

	try {
		sources.usage = ctx.getContextUsage() ?? null;
	} catch (error) {
		note("the token usage", error);
	}

	try {
		const model = ctx.model as unknown as { id?: string; provider?: string; name?: string; contextWindow?: number } | undefined;
		if (model) {
			sources.model = [model.provider, model.id ?? model.name].filter(Boolean).join("/") || undefined;
			// A model that names a window beats a provider that has not filled one in
			// yet (a session that has not sent a request, a proxy that drops the field,
			// a zero that means "unknown"). A real reported window always wins.
			if (!sources.usage?.contextWindow && model.contextWindow) {
				sources.usage = { tokens: sources.usage?.tokens ?? null, contextWindow: model.contextWindow, percent: null };
			}
		}
	} catch (error) {
		note("the model", error);
	}

	try {
		const settings = pi.getSettings() as unknown as { compaction?: { reserveTokens?: number } } | undefined;
		const reserve = settings?.compaction?.reserveTokens;
		sources.reserveTokens = typeof reserve === "number" && Number.isFinite(reserve) ? reserve : null;
	} catch {
		// The default reserve is the host's business; not having it only hides one line.
		sources.reserveTokens = null;
	}

	return sources;
}

export default function contextViewerExtension(pi: ExtensionAPI): void {
	pi.registerCommand("context", {
		description: "Show what fills the context window and what each part costs",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			let snapshot: Snapshot;
			try {
				snapshot = buildSnapshot(await readSources(ctx, pi));
			} catch (error) {
				// buildSnapshot and readSources are individually guarded; this is the
				// "the host moved under us" case, and the command still reports it.
				ctx.ui.notify(`/context could not read the session: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			// An interactive terminal gets the panel; anything else (print mode, a
			// piped `pi -p`) gets the same numbers on one line.
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify(snapshot.overview, "info");
				return;
			}

			const requested = tabForArgument(args, snapshot.tabs.map((tab) => tab.name));
			if (requested.unknown) {
				ctx.ui.notify(
					`/context: no such tab "${args?.trim()}" — opening Overview. Tabs: ${snapshot.tabs.map((tab) => tab.name.toLowerCase()).join(", ")}`,
					"warning",
				);
			}

			try {
				await showViewer(ctx, snapshot, requested.index);
			} catch (error) {
				ctx.ui.notify(
					`/context could not open: ${error instanceof Error ? error.message : String(error)} — ${snapshot.overview}`,
					"error",
				);
			}
		},
	});
}

/** Opens the overlay and resolves once it has been closed. */
async function showViewer(ctx: ExtensionCommandContext, snapshot: Snapshot, initialTab: number): Promise<void> {
	const { ContextViewer } = await import("./viewer.js");
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new ContextViewer(snapshot.tabs, theme, tui, done, { initialTab }, (text) => host.copy(text)),
		{
			overlay: true,
			overlayOptions: { width: "92%", maxHeight: "92%", anchor: "center" },
		},
	);
}
