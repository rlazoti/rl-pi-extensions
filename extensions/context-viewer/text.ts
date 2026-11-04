/**
 * Plain-text rendering for the context viewer tabs. Pure: no colour, no Pi, no
 * terminal — the viewer owns colour and truncation, these functions own layout.
 *
 * Two rules hold throughout:
 *
 * - **Nothing is dropped for being awkward.** A parameter schema this file does
 *   not understand is printed as JSON; an unknown content block prints its type.
 *   A viewer that silently omits a line teaches the reader that the tab is a
 *   summary, and then it is not evidence for "what is in my context".
 * - **What is estimated says so.** Costs are char/4 estimates; the measured
 *   total comes from the provider and the Stats tab prints which is which.
 */

import { CATEGORIES, estimateMessage, type ContextBudget, type ContextMessage } from "./tokens.js";

/** 940 / 1.2k / 42.3k / 1.5M — narrow enough for a table column. */
export function formatTokens(value: number | null | undefined): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "—";
	const abs = Math.abs(value);
	if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
	if (abs >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return String(Math.round(value));
}

/** Hard cut, for a line that must fit a fixed number of columns. */
function clip(text: string, width: number): string {
	return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
}

/** Single-line a label that may carry the newlines of pasted content. */
function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** What a terminal calls a control character: never painted, always counted. */
const ESCAPES = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZc-nstu~]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Text from the host, as screen lines: one element per terminal row.
 *
 * The overlay budgets a row per element, so an element that still holds a
 * newline is painted as two rows by the terminal while the frame counts one —
 * every row under it shifts, the tab strip and the keys line land in the middle
 * of the body, and the previous screen is left unpainted underneath. Message
 * content is multi-line by nature, so nothing that comes from a message, a tool
 * definition or a schema may skip this.
 *
 * Tabs and escapes go too: a tab is one character to the width maths and up to
 * eight columns to a terminal, and an escape from pasted tool output steals both
 * columns and colour from the frame.
 */
export function screenLines(text: unknown, indent = ""): string[] {
	const flat = String(text ?? "")
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "  ")
		.replace(ESCAPES, "");
	// A blank line stays blank rather than becoming trailing whitespace, which
	// some terminals paint through and some render as a stray block.
	return flat.split("\n").map((line) => (line.length > 0 && indent ? indent + line : line));
}

/** The same, for a label that has to stay on one row. */
function oneLine(text: unknown): string {
	return screenLines(text)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Grouped integer, locale-independent so tests and terminals agree. */
export function formatNumber(value: number | null | undefined): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "—";
	return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Right-aligned in a cell of `width`. */
export function numberCell(value: string, width: number): string {
	return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

export function formatPercent(value: number | null | undefined): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "—";
	return `${value.toFixed(1)}%`;
}

/** Blocks of an eighth, from empty to full. */
const GAUGE_STEPS = ["░", "▏", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * A usage bar of `width` cells, drawing eighths. A bar that reads "empty"
 * anywhere under 1.5% and "full" anywhere over 99% hides both ends, and those
 * ends are exactly where a reader is looking — an almost-full window is the
 * reason anyone opens a context viewer.
 */
export function renderGauge(percent: number | null, width: number): string {
	const cells = Math.max(1, Math.floor(width));
	if (percent === null || !Number.isFinite(percent)) return "·".repeat(cells);
	const filled = Math.max(0, Math.min(100, Math.max(0, percent))) / 100;
	return Array.from({ length: cells }, (_, index) => {
		const share = Math.max(0, Math.min(1, filled * cells - index));
		return GAUGE_STEPS[Math.max(0, Math.min(GAUGE_STEPS.length - 1, Math.round(share * 8)))];
	}).join("");
}
/** The Overview tab: header figures, the cost table, the largest items, caveats. */
export function renderBudget(
	budget: ContextBudget,
	options: { width?: number; model?: string; problems?: string[] } = {},
): string[] {
	const width = Math.max(40, Math.floor(options.width ?? 100));
	const lines: string[] = [];

	// Labelled header. "Usage" is the number the status bar shows, so it is
	// spelled with the same words: what the last request reported, not a guess.
	// Label width, then the value cut to what is left: a model id longer than
	// the panel must not push the frame's right border out into the terminal.
	if (options.model) lines.push(clip(`Model             ${collapse(options.model)}`, width));
	lines.push(
		`Usage             ${formatNumber(budget.total)} tokens${budget.measured ? "" : "  — not measured, estimated from text"}`,
	);
	if (budget.contextWindow > 0) {
		lines.push(`Context size      ${formatNumber(budget.contextWindow)} tokens`);
		// The bar takes whatever the label and the sentence behind it leave over.
		// A narrow panel loses the "left" clause before it loses the bar, and the
		// bar is never wide enough for the line to need cutting.
		const percent = formatPercent(budget.percent);
		const roomy = ` ${percent} of window, ${formatNumber(budget.free)} left`;
		const tight = ` ${percent} of window`;
		const tail = 18 + 6 + roomy.length <= width ? roomy : tight;
		const cells = Math.max(4, Math.min(46, width - 18 - tail.length));
		lines.push(clip(`${" ".repeat(18)}${renderGauge(budget.percent, cells)}${tail}`, width));
		if (budget.untilCompaction !== null && budget.reserveTokens !== null) {
			lines.push(
				clip(
					`Compaction        at ${formatNumber(budget.contextWindow - budget.reserveTokens)} tokens (reserve ${formatNumber(budget.reserveTokens)}) — ${formatNumber(budget.untilCompaction)} to go`,
					width,
				),
			);
		}
	} else {
		lines.push("Context size      unknown for this model");
	}

	lines.push("");
	lines.push("Where the tokens went");
	// Long enough for the longest label, short enough that the three number
	// columns still fit the panel: a long label loses characters, the panel does
	// not lose its right-hand column.
	const labelWidth = Math.min(
		Math.max(12, ...budget.rows.map((row) => row.label.length)),
		Math.max(12, width - 28),
	);
	const rule = Math.min(width, labelWidth + 27);
	lines.push(`${" ".repeat(labelWidth)}${numberCell("tokens", 10)}${numberCell("share", 8)}${numberCell("~est", 9)}`);
	lines.push("─".repeat(rule));
	for (const row of budget.rows) {
		lines.push(
			`${clip(row.label, labelWidth).padEnd(labelWidth)}${numberCell(formatTokens(row.tokens), 10)}${numberCell(formatPercent(row.percent), 8)}${numberCell(formatTokens(row.estimated), 9)}`,
		);
	}
	if (budget.rows.length === 0) lines.push("nothing to count yet — no request has been made in this session");

	if (budget.largest.length > 0) {
		lines.push("");
		lines.push(width >= 46 ? "Biggest items (indices match the Messages tab)" : "Biggest items");
		for (const item of budget.largest) {
			const share = budget.total > 0 ? `${((item.tokens / budget.total) * 100).toFixed(1)}%` : "";
			const label = collapse(item.label);
			const head = `#${String(item.index).padStart(3)} ${formatTokens(item.tokens).padStart(7)} ${share.padStart(6)}  `;
			lines.push(clip(head + label, width));
		}
	}

	const notes: string[] = [];
	if (!budget.measured) {
		notes.push("Every number above is an estimate from text size (chars / 4); this session has not sent a request yet.");
	} else if (budget.rows.length > 0) {
		notes.push(
			`The ${formatNumber(budget.total)} tokens are what the provider reported. The split is estimated from text size and scaled to add up to it.`,
		);
	}
	if (budget.images > 0) {
		notes.push(`${budget.images} image block(s) counted at ~1.2k tokens each, the allowance compaction uses.`);
	}
	notes.push(...(options.problems ?? []));
	if (notes.length > 0) {
		lines.push("");
		// Wrapped, because a note that runs past the frame is a note the panel
		// cuts off mid-sentence — and these are the lines explaining the numbers.
		for (const note of notes) lines.push(...wrapText(note, "· ", width));
	}
	return lines;
}

/** The System tab: the prompt verbatim, since its exact shape is the question. */
export function renderSystemPrompt(systemPrompt: string | undefined): string[] {
	if (!systemPrompt) return ["(no system prompt reported)"];
	return screenLines(systemPrompt);
}

export interface ToolInfoLike {
	name?: string;
	description?: string;
	parameters?: unknown;
	promptGuidelines?: string[];
}

interface SchemaNode {
	type?: string;
	description?: string;
	enum?: unknown[];
	anyOf?: unknown[];
	oneOf?: unknown[];
	items?: unknown;
	properties?: Record<string, unknown>;
	required?: unknown[];
	additionalProperties?: unknown;
}

function typeOf(node: SchemaNode): string {
	const union = node.anyOf ?? node.oneOf;
	if (Array.isArray(union)) {
		return union
			.map((option) => (option && typeof option === "object" ? String((option as SchemaNode).type ?? "?") : String(option)))
			.join(" | ");
	}
	if (typeof node.type === "string") return node.type;
	if (Array.isArray(node.enum)) return "enum";
	if (node.properties) return "object";
	if (node.items) return "array";
	return "any";
}

/** A `required` list, keeping only the entries that are actually strings. */
function stringSet(list: unknown): Set<string> {
	return new Set<string>(Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
}

/**
 * A parameter schema as `name: type — description` lines, nested under its
 * parent. Depth is capped at 3 and length at 200 lines: schemas are small, and
 * the cap exists so one pathological definition cannot make a tab unscrollable.
 */
export function describeSchema(schema: unknown, maxDepth = 3): string[] {
	const out: string[] = [];
	const walk = (properties: Record<string, unknown>, depth: number, required: Set<string>): void => {
		if (out.length >= 200) return;
		const indent = "  ".repeat(depth);
		for (const [key, raw] of Object.entries(properties)) {
			if (out.length >= 200) return;
			const node = (raw ?? {}) as SchemaNode;
			const enumText = Array.isArray(node.enum) ? ` ${node.enum.map((v) => JSON.stringify(v)).join("|")}` : "";
			const detail = typeof node.description === "string" ? ` — ${collapse(node.description)}` : "";
			const optional = required.has(key) ? "" : "?";
			// One row per parameter, so the flattened line is what gets pushed.
			out.push(oneLine(`${indent}${key}${optional}: ${typeOf(node)}${enumText}${detail}`).slice(0, 400));

			const children = node.properties ?? (node.items && typeof node.items === "object" ? (node.items as SchemaNode).properties : undefined);
			if (children && depth + 1 < maxDepth) {
				// An array's own items carry the required list; a nested object's does not.
				const items = node.items && typeof node.items === "object" ? (node.items as SchemaNode) : undefined;
				walk(children, depth + 1, stringSet(items?.required ?? node.required));
			}
		}
	};

	if (schema === undefined || schema === null) return ["(no schema)"];
	if (typeof schema !== "object") return [JSON.stringify(schema) ?? String(schema)];

	const node = schema as SchemaNode;
	if (!node.properties || Object.keys(node.properties).length === 0) {
		// Anything without a property list (a free-form object, a union at the
		// top level) is printed exactly as the model receives it.
		return [JSON.stringify(schema).slice(0, 400)];
	}
	walk(node.properties, 0, stringSet(node.required));
	return out;
}

/**
 * Split one line into rows of at most `width` columns, breaking at a space
 * where one is available and through a word when nothing is. Used to paint a
 * line the frame is too narrow for: cutting it there would lose the tail of a
 * message, which is the one thing this viewer is for.
 */
export function breakLine(text: string, width: number): string[] {
	const limit = Math.max(1, Math.floor(width));
	if (text.length <= limit) return [text];
	const out: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		let cut = limit;
		const space = rest.lastIndexOf(" ", limit);
		// Only break at a space that has done some work: wrapping one column at a
		// time because a word is long would be worse than cutting through it.
		if (space > limit / 2) cut = space;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut === space ? cut + 1 : cut);
	}
	if (rest.length > 0 || out.length === 0) out.push(rest);
	return out;
}

/** Word wrap that keeps continuation lines indented. */
export function wrapText(text: string, indent: string, width: number): string[] {
	const out: string[] = [];
	for (const paragraph of screenLines(text)) {
		let line = indent;
		for (const word of paragraph.split(/\s+/)) {
			if (!word) continue;
			if (line.length + word.length + 1 > width && line !== indent) {
				out.push(line);
				line = indent;
			}
			line += (line === indent ? "" : " ") + word;
		}
		out.push(line);
	}
	return out;
}

/** The Tools tab: each declared tool with its parameters and prompt guidelines. */
export function renderTools(tools: ToolInfoLike[] | undefined): string[] {
	if (!tools || tools.length === 0) return ["(no tools declared to the model)"];
	const lines: string[] = [`${tools.length} tool(s) declared to the model.  "?" marks an optional parameter.`, ""];
	for (const tool of tools) {
		lines.push(oneLine(`── ${tool.name ?? "(unnamed)"}`));
		if (tool.description) lines.push(...wrapText(tool.description, "  ", 100));
		const params = describeSchema(tool.parameters);
		if (params.length > 0 && params[0] !== "(no schema)") {
			lines.push("  parameters:");
			for (const line of params) lines.push(`    ${line}`);
		}
		for (const guideline of tool.promptGuidelines ?? []) lines.push(...wrapText(guideline, "  · ", 100));
		lines.push("");
	}
	return lines;
}

/** Extra identification for a message header, by role. */
function messageMeta(message: ContextMessage): string {
	const parts: string[] = [];
	if (message.role === "assistant") {
		if (message.model) parts.push(message.model);
		else if (message.provider) parts.push(message.provider);
		if (message.stopReason) parts.push(message.stopReason);
	}
	if (message.role === "toolResult") {
		parts.push(message.toolName ?? "unknown tool");
		if (message.isError) parts.push("error");
	}
	if (message.role === "custom" && message.customType) parts.push(message.customType);
	return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

type BlockLike = { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown; mimeType?: string };

function blocksOf(content: ContextMessage["content"]): BlockLike[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	return content.filter((block): block is BlockLike => typeof block === "object" && block !== null);
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return "[arguments that do not serialize]";
	}
}

/**
 * The Messages tab: a header per message (index, role, estimated cost) and its
 * full content beneath. Content is never truncated — the question this tab
 * answers is what the model actually got.
 */
/** Every line of one message, header first. Split out so `renderMessages` stays a loop. */
function messageLines(message: ContextMessage, index: number): string[] {
	const lines: string[] = [];
	const costs = usageOf(message);
	lines.push(oneLine(`━━ #${index} ${message.role ?? "unknown"}${messageMeta(message)} · ~${formatTokens(estimateMessage(message))}${costs.length > 0 ? ` · ${costs.join(" ")}` : ""}`));

	if (message.role === "bashExecution") {
		// A command is shown as the model wrote it, newlines and all — that is what
		// ran — which means it is several rows, not one.
		if (message.command) lines.push(...screenLines(message.command, "  $ "));
		if (message.output) lines.push(...screenLines(message.output, "  "));
		return lines;
	}
	if (message.role === "branchSummary" || message.role === "compactionSummary") {
		lines.push(...screenLines(message.summary ?? "", "  "));
		return lines;
	}
	for (const block of blocksOf(message.content)) {
		switch (block.type) {
			case "text":
				lines.push(...screenLines(block.text ?? "", "  "));
				break;
			case "thinking":
				lines.push(`  [thinking ${block.thinking?.length ?? 0} chars]`);
				lines.push(...screenLines(block.thinking ?? "", "  "));
				break;
			case "toolCall":
				lines.push(oneLine(`  [tool call ${block.name ?? "?"}]`));
				lines.push(...screenLines(safeJson(block.arguments), "  "));
				break;
			case "image":
				lines.push(oneLine(`  [image ${block.mimeType ?? "unknown type"}]`));
				break;
			default:
				lines.push(oneLine(`  [${block.type ?? "block"}]`));
		}
	}
	return lines;
}

/** The per-request token counts a provider reported on an assistant message. */
function usageOf(message: ContextMessage): string[] {
	if (!message.usage) return [];
	return [
		typeof message.usage.input === "number" ? `in ${formatTokens(message.usage.input)}` : "",
		typeof message.usage.output === "number" ? `out ${formatTokens(message.usage.output)}` : "",
	].filter(Boolean);
}

export function renderMessages(messages: ContextMessage[] | undefined): string[] {
	if (!messages || messages.length === 0) return ["(no messages in context)"];
	const lines: string[] = [];
	for (let index = 0; index < messages.length; index++) {
		if (index > 0) lines.push("");
		lines.push(...messageLines(messages[index], index));
	}
	return lines;
}

/**
 * The Raw tab: one JSON document per line. One per message keeps the tab useful
 * to search (a match names the whole message) and to copy into a file.
 */
export function renderRaw(input: {
	systemPrompt?: string;
	tools?: ToolInfoLike[];
	messages?: ContextMessage[];
	usage?: unknown;
}): string[] {
	const lines: string[] = [];
	lines.push("# system prompt");
	lines.push(JSON.stringify({ characters: input.systemPrompt?.length ?? 0, text: input.systemPrompt ?? "" }));
	lines.push("# tools declared to the model");
	lines.push(JSON.stringify((input.tools ?? []).map((tool) => ({ name: tool.name, parameters: tool.parameters }))));
	lines.push("# usage reported by the provider");
	lines.push(JSON.stringify(input.usage ?? null));
	lines.push(`# messages (${input.messages?.length ?? 0})`);
	(input.messages ?? []).forEach((message, index) => lines.push(JSON.stringify({ index, ...message })));
	return lines;
}

/** Line indices whose text contains the query, case-insensitively. */
export function findMatches(lines: string[], query: string): number[] {
	if (query.length === 0) return [];
	const needle = query.toLowerCase();
	const out: number[] = [];
	for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(needle)) out.push(i);
	return out;
}

/** Table order, exported so a test can pin that the drawer and the model agree. */
export const CATEGORY_ORDER = CATEGORIES.map((entry) => entry.category);
