/**
 * Token accounting for the context viewer. Pure: no Pi, no terminal, no clock.
 *
 * ## Where the numbers come from
 *
 * Two different things get called "tokens" and mixing them is how a context
 * display ends up reading like a lie:
 *
 *   - **Measured** — `ctx.getContextUsage().tokens`, the provider's own count of
 *     the last request. This is the number compaction decisions are made from.
 *   - **Estimated** — chars / 4 over the text of each block. The same rule Pi's
 *     compaction estimator uses, restated here (see `estimateChars`) so the two
 *     agree without importing a symbol that would take the whole extension down
 *     if an older Pi did not export it. `tokens.test.ts` compares the two rules
 *     message by message and fails if they drift.
 *
 * The measured total is a single number for the whole request, so it cannot say
 * what the tokens went to. This module splits it **proportionally** across
 * categories by estimated size: the rows always add up to the measured total,
 * and the split is an estimate. That is worth being explicit about, because the
 * tempting alternative — showing raw estimates next to a measured total —
 * produces a table whose rows do not sum to the number in its own header.
 *
 * ## Fail-closed by omission
 *
 * An unrecognised role or block contributes to `other`, never to a named
 * category, and never throws: a transcript shape this file has not seen should
 * produce a boring row, not an empty overlay.
 */

/** Pi's compaction estimator divides characters by this. Keep the two equal. */
export const CHARS_PER_TOKEN = 4;

/**
 * What Pi charges an image block, in characters (so ~1,200 tokens). Pi has no
 * per-image measurement either; matching its constant keeps our total equal to
 * the total compaction reads.
 */
export const IMAGE_CHARS = 4800;

/**
 * A content block, typed loosely on purpose: session files carry shapes from
 * older versions and other providers, and this module reads them without
 * validation. Fields that are not modelled are allowed and ignored.
 */
export interface ContextBlock {
	[key: string]: unknown;
	type?: string;
	data?: string;
	mimeType?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
	input?: unknown;
	toolName?: string;
	content?: unknown;
}

/** One message of the resolved LLM context. Same looseness, same reason. */
export interface ContextMessage {
	[key: string]: unknown;
	role?: string;
	content?: string | ContextBlock[];
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } | null;
	model?: string;
	provider?: string;
	stopReason?: string;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	command?: string;
	output?: string;
	summary?: string;
	customType?: string;
	timestamp?: number;
}

export type Category =
	| "systemPrompt"
	| "toolDefinitions"
	| "user"
	| "assistant"
	| "thinking"
	| "toolCalls"
	| "toolResults"
	| "summaries"
	| "other";

/** Display order, and the label used in the table. */
export const CATEGORIES: Array<{ category: Category; label: string }> = [
	{ category: "systemPrompt", label: "System prompt" },
	{ category: "toolDefinitions", label: "Tool definitions" },
	{ category: "user", label: "Your messages" },
	{ category: "assistant", label: "Assistant text" },
	{ category: "thinking", label: "Thinking" },
	{ category: "toolCalls", label: "Tool calls" },
	{ category: "toolResults", label: "Tool results" },
	{ category: "summaries", label: "Summaries" },
	{ category: "other", label: "Other" },
];

const emptyChars = (): Record<Category, number> => ({
	systemPrompt: 0,
	toolDefinitions: 0,
	user: 0,
	assistant: 0,
	thinking: 0,
	toolCalls: 0,
	toolResults: 0,
	summaries: 0,
	other: 0,
});

function asBlocks(content: unknown): ContextBlock[] {
	if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	return content.filter((block): block is ContextBlock => typeof block === "object" && block !== null);
}

function jsonLength(value: unknown): number {
	if (value === undefined) return 0;
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		// A schema or argument object with a cycle would throw here; its cost is
		// unknown, and "unknown" must not be a reason to show nothing.
		return 0;
	}
}

/** Characters of one block, under the same rule Pi's estimator applies to it. */
export function blockChars(block: ContextBlock | null | undefined): number {
	if (!block || typeof block !== "object") return 0;
	switch (block.type) {
		case "text":
			return block.text?.length ?? 0;
		case "thinking":
			return block.thinking?.length ?? 0;
		case "toolCall":
			return (block.name?.length ?? 0) + jsonLength(block.arguments ?? block.input);
		case "image":
			return IMAGE_CHARS;
		default:
			return 0;
	}
}

/**
 * Estimated tokens for one message. `ceil(chars / 4)` over the whole message,
 * not per block: Pi rounds once per message, and rounding per block would make
 * the two disagree on every message with several blocks.
 */
export function estimateMessage(message: ContextMessage | null | undefined): number {
	if (!message || typeof message !== "object") return 0;
	let chars = 0;
	switch (message.role) {
		case "user":
		case "custom":
		case "toolResult":
			chars = contentChars(message.content);
			break;
		case "assistant":
			// A tool call's `id` and the message's model name are not in the
			// provider's count either; skipping them keeps the per-message number
			// comparable with Pi's.
			chars = asBlocks(message.content).reduce((sum, block) => sum + blockChars(block), 0);
			break;
		case "bashExecution":
			chars = (message.command?.length ?? 0) + (message.output?.length ?? 0);
			break;
		case "branchSummary":
		case "compactionSummary":
			chars = message.summary?.length ?? 0;
			break;
		default:
			chars = 0;
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	return asBlocks(content).reduce((sum, block) => sum + blockChars(block), 0);
}

/** Which category a message's characters belong to, block by block. */
function attributeMessage(message: ContextMessage): Partial<Record<Category, number>> {
	const out: Partial<Record<Category, number>> = {};
	const add = (category: Category, chars: number) => {
		if (chars > 0) out[category] = (out[category] ?? 0) + chars;
	};

	switch (message.role) {
		case "user":
			add("user", contentChars(message.content));
			break;
		case "custom":
			// Injected by an extension; it reads as a user turn and costs like one.
			add("other", contentChars(message.content));
			break;
		case "assistant":
			for (const block of asBlocks(message.content)) {
				if (block.type === "text") add("assistant", block.text?.length ?? 0);
				else if (block.type === "thinking") add("thinking", block.thinking?.length ?? 0);
				else if (block.type === "toolCall") add("toolCalls", blockChars(block));
				else add("other", blockChars(block));
			}
			break;
		case "toolResult":
			add("toolResults", contentChars(message.content));
			break;
		case "bashExecution":
			add("toolCalls", message.command?.length ?? 0);
			add("toolResults", message.output?.length ?? 0);
			break;
		case "branchSummary":
		case "compactionSummary":
			add("summaries", message.summary?.length ?? 0);
			break;
		default:
			add("other", contentChars(message.content));
	}
	return out;
}

export interface LargestItem {
	/** Index in the message list, 0-based, for the Messages tab to jump to. */
	index: number;
	label: string;
	tokens: number;
}

export interface BudgetRow {
	category: Category;
	label: string;
	/** Share of the total, after proportional scaling. Rows sum to `total`. */
	tokens: number;
	/** Raw chars/4 estimate before scaling; 0 rows are genuinely empty. */
	estimated: number;
	/** Share of `total`, 0-100. */
	percent: number;
}

export interface ContextBudget {
	/** The number in the header: measured when the provider reported one. */
	total: number;
	contextWindow: number;
	/** False when the provider has not reported usage for this context yet. */
	measured: boolean;
	percent: number | null;
	free: number;
	/** Tokens left before compaction triggers (`window - reserve - total`), if it can be computed. */
	untilCompaction: number | null;
	reserveTokens: number | null;
	rows: BudgetRow[];
	estimatedTotal: number;
	messages: number;
	images: number;
	largest: LargestItem[];
}

function labelFor(input: ContextMessage | null | undefined, index: number): string {
	const message = input ?? { role: "unknown" };
	const firstLine = (value: string): string => {
		const line = value.replace(/\s+/g, " ").trim();
		return line.length > 48 ? `${line.slice(0, 47)}…` : line;
	};
	const textOf = (): string => {
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) return "";
		return message.content.map((block) => block?.text ?? "").join(" ");
	};
	/**
	 * A message with no text still occupied the window, and "you:" with nothing
	 * after it reads like a bug in the panel. Say what is in it instead.
	 */
	const describeBlocks = (): string => {
		const blocks = Array.isArray(message.content) ? message.content : [];
		const kinds = new Set(blocks.map((block) => block?.type).filter((kind): kind is string => Boolean(kind)));
		if (kinds.size === 0) return "";
		return `[${[...kinds].join(", ")}]`;
	};
	const preview = (): string => {
		const text = firstLine(textOf());
		return text.length > 0 ? text : describeBlocks();
	};

	switch (message.role) {
		case "user":
			return `you: ${preview()}`;
		case "assistant": {
			const calls = asBlocks(message.content).filter((block) => block.type === "toolCall");
			if (calls.length > 0) return `call ${calls.map((block) => block.name ?? "?").join(", ")}`;
			const thinking = asBlocks(message.content).find((block) => block.type === "thinking");
			if (thinking?.thinking) return `thinking: ${firstLine(thinking.thinking)}`;
			return `assistant: ${preview()}`;
		}
		case "toolResult":
			return `result ${message.toolName ?? "?"}${message.isError ? " (error)" : ""}: ${preview()}`;
		case "bashExecution":
			return `bash: ${firstLine(message.command ?? "")}`;
		case "custom":
			return `injected ${message.customType ?? "?"}`;
		case "branchSummary":
			return "branch summary";
		case "compactionSummary":
			return "compaction summary";
		default:
			return `#${index} ${message.role ?? "unrecognised"} message`;
	}
}

/**
 * Build the budget table.
 *
 * `usageTokens` is the measured total or `null` when nothing has been reported
 * (fresh session, or right after a compaction): the rows then stay raw estimates
 * and `measured` says so, because a scaled-to-zero table reads as an empty
 * context rather than an unknown one.
 */
export function buildBudget(input: {
	systemPrompt?: string;
	/** The tools declared to the model, as the provider would receive them. */
	tools?: unknown[];
	messages?: ContextMessage[];
	usageTokens?: number | null;
	contextWindow?: number | null;
	reserveTokens?: number | null;
	largestCount?: number;
}): ContextBudget {
	const chars = emptyChars();
	chars.systemPrompt = input.systemPrompt?.length ?? 0;
	chars.toolDefinitions = (input.tools ?? []).reduce<number>((sum, tool) => sum + jsonLength(tool), 0);

	const messages = Array.isArray(input.messages) ? input.messages : [];
	let images = 0;
	const perMessage: number[] = [];
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		for (const [category, value] of Object.entries(attributeMessage(message))) {
			chars[category as Category] += value ?? 0;
		}
		images += asBlocks(message.content).filter((block) => block.type === "image").length;
		perMessage.push(estimateMessage(message));
	}

	const estimatedTotal = CATEGORIES.reduce((sum, { category }) => sum + Math.ceil(chars[category] / CHARS_PER_TOKEN), 0);
	const measured = typeof input.usageTokens === "number" && Number.isFinite(input.usageTokens) && input.usageTokens >= 0;
	const total = measured ? (input.usageTokens as number) : estimatedTotal;
	const contextWindow = typeof input.contextWindow === "number" && input.contextWindow > 0 ? input.contextWindow : 0;
	const ratio = measured && estimatedTotal > 0 ? total / estimatedTotal : 1;

	const rows: BudgetRow[] = [];
	for (const { category, label } of CATEGORIES) {
		const estimated = Math.ceil(chars[category] / CHARS_PER_TOKEN);
		if (estimated === 0) continue;
		rows.push({
			category,
			label,
			estimated,
			tokens: Math.round(estimated * ratio),
			percent: 0,
		});
	}

	// Rounding each row independently can leave the column a few tokens off the
	// header number; the largest row absorbs it so the table adds up.
	const scaledSum = rows.reduce((sum, row) => sum + row.tokens, 0);
	const residual = total - scaledSum;
	if (rows.length > 0 && residual !== 0) {
		const biggest = rows.reduce((best, row) => (row.tokens > best.tokens ? row : best), rows[0]);
		biggest.tokens = Math.max(0, biggest.tokens + residual);
	}
	for (const row of rows) {
		row.percent = total > 0 ? (row.tokens / total) * 100 : 0;
	}

	const reserve = typeof input.reserveTokens === "number" && input.reserveTokens >= 0 ? input.reserveTokens : null;
	const largest: LargestItem[] = perMessage
		.map((tokens, index) => ({ index, tokens, label: labelFor(messages[index], index) }))
		.filter((item) => item.tokens > 0)
		// Ties break on position, not on whatever the sort's internals did with two
		// equal-size messages, so the same session lists the same items twice.
		.sort((a, b) => b.tokens - a.tokens || a.index - b.index)
		.slice(0, input.largestCount ?? 8);

	return {
		total,
		contextWindow,
		measured,
		percent: contextWindow > 0 ? (total / contextWindow) * 100 : null,
		free: contextWindow > 0 ? Math.max(0, contextWindow - total) : 0,
		untilCompaction: contextWindow > 0 && reserve !== null ? Math.max(0, contextWindow - reserve - total) : null,
		reserveTokens: reserve,
		rows,
		estimatedTotal,
		messages: messages.length,
		images,
		largest,
	};
}
