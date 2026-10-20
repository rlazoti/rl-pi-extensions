/**
 * What one conversation carries (R25.1, D24).
 *
 * A block returned by `before_agent_start` is stored in the session, and Pi sends
 * the whole conversation to the model on every call. So the always-on rules repeat
 * once per turn: measured in this project's own session files, a nine-turn session
 * carried 10,255 tokens of memory blocks on every model call, where the newest
 * block alone was 1,085.
 *
 * A `context` handler is the honest place to bound that. It changes only what the
 * model is sent; the session file keeps every block, so the history stays what
 * happened and only the live request shrinks.
 */

import { RETRIEVED_TITLE, tokensOf } from "./inject.js";

/** What the carried block says about itself, so the model knows whose turn it is. */
export const CARRY_MARKER = "[memory: carried from an earlier turn — the newest block has no related claims for this request]";

/**
 * A message as the `context` event shows it. Pi's own union is wider; this is the
 * part this module reads, and the handler casts at the boundary.
 */
export interface ContextMessageLike {
	role: string;
	customType?: string;
	content?: unknown;
	timestamp?: number;
}

/** What one model call would cost in memory blocks, before and after pruning. */
export interface ContextSample {
	/** Memory blocks in the conversation. */
	blocks: number;
	keptBlocks: number;
	droppedBlocks: number;
	keptTokens: number;
	droppedTokens: number;
	/** True when an older block was kept because the newest retrieved nothing. */
	carried: boolean;
	/** Timestamp of the newest block; the caller samples once per block. */
	newest: number;
}

export interface Pruned<T> {
	messages: T[];
	sample: ContextSample;
}

function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
			.join("");
	}
	return "";
}

function isMemory(message: ContextMessageLike): boolean {
	// `customType` is the identity Pi gives this extension's blocks. The heading
	// inside them is theirs to change, so it decides nothing here.
	return message.role === "custom" && message.customType === "memory";
}

/**
 * Keep one block, at most two.
 *
 * The newest block always goes: it has the always-on rules and today's open items.
 * When it retrieved nothing — the follow-up that says "yes" — the newest block that
 * did retrieve comes along too, marked as carried, because the claims it named were
 * the answer to the question still being worked on. Two blocks, roughly one
 * conversation's worth of memory, instead of one per turn (D24).
 *
 * The input is never modified: Pi hands a clone, and the session file keeps the
 * originals either way.
 */
export function pruneMemoryBlocks<T extends ContextMessageLike>(messages: T[]): Pruned<T> {
	const found: { index: number; text: string; tokens: number; retrieved: boolean }[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (!isMemory(message)) continue;
		const text = blockText(message.content);
		found.push({ index, text, tokens: tokensOf(text), retrieved: text.includes(`### ${RETRIEVED_TITLE}`) });
	}
	if (found.length === 0) {
		return { messages, sample: { blocks: 0, keptBlocks: 0, droppedBlocks: 0, keptTokens: 0, droppedTokens: 0, carried: false, newest: 0 } };
	}

	const newest = found.at(-1)!;
	const keep = new Set<number>([newest.index]);
	let carriedFrom: (typeof found)[number] | undefined;
	if (!newest.retrieved) {
		const withClaims = [...found].reverse().find((block) => block.retrieved && block.index !== newest.index);
		if (withClaims) {
			carriedFrom = withClaims;
			keep.add(withClaims.index);
		}
	}

	const keptTokens = found.filter((block) => keep.has(block.index)).reduce((sum, block) => sum + block.tokens, 0);
	const dropped = found.filter((block) => !keep.has(block.index));
	const sample: ContextSample = {
		blocks: found.length,
		keptBlocks: keep.size,
		droppedBlocks: dropped.length,
		keptTokens,
		droppedTokens: dropped.reduce((sum, block) => sum + block.tokens, 0),
		carried: carriedFrom !== undefined,
		newest: Number(messages[newest.index]!.timestamp ?? 0),
	};
	// Nothing to remove and nothing to mark: hand back the same list, so the caller
	// can tell Pi that nothing changed.
	if (dropped.length === 0 && carriedFrom === undefined) return { messages, sample };

	const out = messages.filter((_, index) => !dropped.some((block) => block.index === index));
	// Only a string block is marked. A block whose content is a block array is left
	// byte for byte, because this module cannot reproduce one from joined text — the
	// rule a writer may rewrite only what it can reproduce, applied to a message.
	if (carriedFrom !== undefined && typeof messages[carriedFrom.index]!.content === "string") {
		const original = messages[carriedFrom.index]!;
		const marked = { ...original, content: `${CARRY_MARKER}\n${carriedFrom.text}` } as T;
		const position = out.findIndex((message) => message === original);
		if (position >= 0) out[position] = marked;
	}
	return { messages: out, sample };
}
