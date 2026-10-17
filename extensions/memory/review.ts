/**
 * The review card: one pending claim, in full, with the decision keys.
 *
 * A selector cannot do this job. `ui.select` shows a title and one-line options,
 * so `/memory review` was reduced to a list of keys — approving a claim whose
 * text was never on screen. The card shows what the claim says, what it would
 * replace, and where it lives, and it keeps the whole queue in one dialog
 * instead of opening one dialog per claim.
 */

import { Key, matchesKey, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";

import { fit, fillRows, frameLines } from "../panel.js";

const OVERLAY_HEIGHT_PERCENT = 80;

export interface ReviewItem {
	key: string;
	scope: string;
	kind: string;
	asOf: string;
	source: string;
	origin: string;
	tags: string[];
	body: string;
	/** The approved claim this one would replace, verbatim (R18). */
	replaces?: string;
	ageDays: number;
	flagged: boolean;
	/** Bank-relative path, so the rest of the store is one `memory_read` away. */
	file?: string;
}

export interface ReviewHandlers {
	approve(item: ReviewItem): string;
	reject(item: ReviewItem): string;
	defer(item: ReviewItem): string;
}

export interface ReviewResult {
	/** Claims decided in this dialog, in the order they were decided. */
	acted: { key: string; action: "approved" | "rejected" | "deferred" }[];
	/**
	 * Set when the user asked to edit: no dialog can open inside a dialog, so the
	 * caller closes this one, opens the editor, and reopens the review here.
	 */
	edit?: ReviewItem;
	stopped: boolean;
	/** Index into the queue the dialog stopped at, so a reopen resumes there. */
	at: number;
}

export class ReviewCard implements Component, Focusable {
	focused = false;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly items: ReviewItem[];
	private readonly handlers: ReviewHandlers;
	private readonly done: (result: ReviewResult) => void;

	private index: number;
	private readonly decided = new Set<number>();
	private acted: ReviewResult["acted"] = [];
	private status = "";
	private completed = false;

	constructor(
		tui: TUI,
		theme: Theme,
		_items: KeybindingsManager,
		items: ReviewItem[],
		handlers: ReviewHandlers,
		done: (result: ReviewResult) => void,
		startAt = 0,
	) {
		this.tui = tui;
		this.theme = theme;
		this.items = items;
		this.handlers = handlers;
		this.done = done;
		this.index = Math.max(0, Math.min(startAt, items.length - 1));
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.completed) return;
		const item = this.items[this.index];
		if (item === undefined) {
			this.finish(false);
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			this.finish(true);
			return;
		}
		if (data === "n" || matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (data === "p" || matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		const action: "approved" | "rejected" | "deferred" | undefined =
			data === "a" || data === "y" ? "approved" : data === "x" || data === "r" || matchesKey(data, Key.delete) ? "rejected" : data === "d" ? "deferred" : undefined;
		if (action !== undefined) {
			this.status = this.act(this.index, action);
			this.move(1);
			this.tui.requestRender();
			return;
		}
		if (data === "e") {
			this.completed = true;
			this.done({ acted: this.acted, edit: item, stopped: true, at: this.index });
			return;
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		// The overlay is this tall, so this is the row budget. Rendering the whole
		// terminal would push the decision keys below the overlay's edge — the
		// picker sizes itself the same way.
		const rows = Math.max(1, Math.floor((this.tui.terminal.rows * OVERLAY_HEIGHT_PERCENT) / 100));
		const item = this.items[this.index];
		const inner = Math.max(1, safeWidth - 4);
		const content: string[] = [];

		if (item === undefined) {
			content.push("Nothing left in this batch.");
			return fillRows(frameLines(this.theme, content, safeWidth, 0, "memory review"), rows);
		}

		const title = `Review ${this.index + 1}/${this.items.length} — ${item.key} @ ${item.scope}`;
		content.push(this.theme.fg("accent", title));
		// The meta line is wrapped, not truncated: "older than the flag window" is
		// the difference between approving and deferring, and a panel 60 columns
		// wide would have cut it off.
		const meta = [
			item.kind,
			item.asOf ? `as of ${item.asOf}` : "no asOf",
			`${item.ageDays} day(s) pending`,
			item.origin === "migration" ? "migrated" : "proposed by the agent",
			item.flagged ? "older than the flag window" : "",
			item.tags.length > 0 ? `tags: ${item.tags.join(", ")}` : "",
		]
			.filter((part) => part !== "")
			.join(" · ");
		content.push(...wrap(meta, inner).slice(0, 2));
		content.push(`source: ${fit(item.source, inner - 9)}`);

		// What it would replace: the decision is a comparison or it is not a decision.
		const extra: string[] = [];
		if (item.replaces !== undefined && item.replaces !== "") {
			extra.push(this.theme.fg("warning", `replaces: ${item.replaces}`));
		}
		const footer = "a approve · x reject · d defer · e edit wording · n/p next, previous · Esc stop";
		const reserved = content.length + extra.length + 1 + (this.status === "" ? 0 : 1) + 2;
		const bodyRows = Math.max(1, rows - reserved);

		const wrapped = wrap(item.body, inner);
		const shown = wrapped.slice(0, bodyRows);
		const body = [this.theme.fg("text", "The claim:"), ...shown];
		if (wrapped.length > shown.length) {
			const missing = wrapped.length - shown.length;
			const hint = `… ${missing} more: memory_read ${item.file ?? "claims/"}`;
			// The pointer is the point, so it is never the thing the frame cuts off.
			body.push(this.theme.fg("warning", measure(hint) <= inner ? hint : `… ${missing} more lines — memory_list`));
		}

		const lines = [...content, ...body, ...extra];
		if (this.status !== "") lines.push(this.theme.fg("success", this.status));
		lines.push("");
		lines.push(this.theme.fg("dim", footer));
		return fillRows(frameLines(this.theme, lines, safeWidth, 0, "memory review"), rows);
	}

	private act(index: number, action: ReviewResult["acted"][number]["action"]): string {
		const item = this.items[index]!;
		const message =
			action === "approved" ? this.handlers.approve(item) : action === "rejected" ? this.handlers.reject(item) : this.handlers.defer(item);
		this.decided.add(index);
		this.acted.push({ key: item.key, action });
		return `${action}: ${message}`;
	}

	private move(delta: number): void {
		if (this.items.length === 0) return;
		let next = this.index;
		for (let step = 0; step < this.items.length; step++) {
			next = (next + delta + this.items.length) % this.items.length;
			if (!this.decided.has(next)) break;
		}
		this.index = next;
		if (this.decided.size === this.items.length) this.finish(false);
		else this.tui.requestRender();
	}

	private finish(stopped: boolean): void {
		if (this.completed) return;
		this.completed = true;
		this.done({ acted: this.acted, stopped, at: this.index });
	}
}

/** Word wrap on whole words; a word wider than the column is hard-cut, never dropped. */
export function wrap(text: string, width: number): string[] {
	const column = Math.max(1, width);
	const lines: string[] = [];
	for (const paragraph of text.split(/\n/)) {
		const words = paragraph.split(/\s+/).filter((word) => word !== "");
		if (words.length === 0) {
			lines.push("");
			continue;
		}
		let current = "";
		for (const word of words) {
			const candidate = current === "" ? word : `${current} ${word}`;
			if (measure(candidate) <= column) {
				current = candidate;
				continue;
			}
			if (current !== "") {
				lines.push(current);
				current = "";
			}
			let rest = word;
			while (measure(rest) > column) {
				let cut = 0;
				let used = 0;
				for (const char of rest) {
					if (used + charWidth(char) > column) break;
					used += charWidth(char);
					cut += char.length;
				}
				lines.push(rest.slice(0, cut));
				rest = rest.slice(cut);
			}
			current = rest;
		}
		if (current !== "") lines.push(current);
	}
	return lines;
}

function charWidth(char: string): number {
	// Wide enough for the terminal here: combining marks and ZWJ sequences count as
	// one column, which is what the panel's own truncation does too.
	return char.codePointAt(0)! > 0xffff ? 2 : 1;
}

function measure(line: string): number {
	let width = 0;
	for (const char of line) width += charWidth(char);
	return width;
}

export function openReview(
	ui: Pick<ExtensionUIContext, "custom">,
	items: ReviewItem[],
	handlers: ReviewHandlers,
	startAt = 0,
): Promise<ReviewResult> {
	return ui.custom<ReviewResult | undefined>(
		(tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: ReviewResult | undefined) => void) =>
			new ReviewCard(tui, theme, keybindings, items, handlers, done, startAt),
		{ overlay: true, overlayOptions: { width: "92%", maxHeight: `${OVERLAY_HEIGHT_PERCENT}%`, anchor: "center" } },
	).then((result: ReviewResult | undefined) => result ?? { acted: [], stopped: true, at: startAt });
}
