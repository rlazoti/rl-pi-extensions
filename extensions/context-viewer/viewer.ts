/**
 * The overlay: one framed panel, several tabs of scrollable, searchable text.
 *
 * Deliberately dumb about content — every tab is a `string[]` produced by
 * `text.ts`, which keeps rendering testable and this file about geometry and
 * keystrokes only.
 *
 * Behaviour worth knowing before changing it:
 *
 * - **The frame is paid for first.** Row budget goes to the frame, then the tab
 *   bar and footer, then the body; the subtitle and separators are dropped
 *   before the body loses its last rows, because a panel that shows two lines of
 *   content and five of chrome is not showing anything.
 * - **Scroll is clamped to the window, every time.** `pageSize` changes with the
 *   terminal, and an offset left over from a wider window would render blanks
 *   over the bottom of the panel.
 * - **Search filters nothing.** Matches are highlighted and jumped between; the
 *   rest of the text stays where it was. Removing lines would move the line
 *   numbers a user is reading and make the copy key copy something other than
 *   what they looked at.
 * - **`y` copies the tab, not the screen.** The screen is a window; the tab is
 *   the thing that was asked about.
 * - **A tab line is one logical line, and a row is one terminal row.** Content
 *   from the host is normalised on the way in (a newline inside an element would
 *   be painted as two rows while the frame counted one, which shifts every row
 *   under it and leaves the previous screen behind), and a line wider than the
 *   frame is broken across rows rather than cut — so scrolling, matches and the
 *   copy are counted in logical lines, while the window moves in rows.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { fit, frameLines, fillRows } from "../panel.js";
import { breakLine, findMatches, screenLines } from "./text.js";

export interface ViewerTab {
	/** Shown in the tab bar. */
	name: string;
	/** The whole tab. The viewer windows it; it never edits it. */
	lines: string[];
	/** One line under the tab bar: what this tab is about, in one breath. */
	hint?: string;
}

export interface ViewerState {
	/** Tab index to open on. */
	initialTab?: number;
}

const FOOTER_HINT = "↑↓ scroll  Tab switch  / search  n/N match  y copy  q close";

/** Writes the tab to the clipboard; resolves to an error message on failure. */
export type CopyToClipboard = (text: string) => Promise<string | undefined> | string | undefined;

export class ContextViewer {
	private readonly tabs: ViewerTab[];
	private readonly theme: Theme;
	private readonly tui: TUI;
	private readonly done: () => void;
	private readonly copy: CopyToClipboard | undefined;

	private activeTab: number;
	private offsets: number[] = [];
	private scrollRows = 1;
	private contentWidth: number | undefined;
	private searchMode = false;
	private searchQuery = "";
	private matchIndex = 0;
	private status: string | undefined;
	private closed = false;
	private rowCache: { key: string; rows: { text: string; line: number }[] } | undefined;

	constructor(
		tabs: ViewerTab[],
		theme: Theme,
		tui: TUI,
		done: () => void,
		state: ViewerState = {},
		copy?: CopyToClipboard,
	) {
		this.tabs = (tabs.length > 0 ? tabs : [{ name: "Empty", lines: ["(nothing to show)"] }]).map((tab) => ({
			...tab,
			// The one guarantee the terminal needs, taken back rather than trusted:
			// an element holding a newline desynchronises the whole frame.
			lines: tab.lines.flatMap((line) => (line.includes("\n") ? screenLines(line) : [line])),
		}));
		this.theme = theme;
		this.tui = tui;
		this.done = done;
		this.copy = copy;
		this.activeTab = Math.max(0, Math.min(this.tabs.length - 1, state.initialTab ?? 0));
		this.offsets = this.tabs.map(() => 0);
	}

	/** Test seam: the tabs as the viewer holds them. */
	getTab(index: number): ViewerTab | undefined {
		return this.tabs[index];
	}

	/**
	 * Nothing is cached between frames — colour and truncation are applied at
	 * render time — so a theme change needs no invalidation. Required by
	 * pi-tui's `Component`, and deliberately empty rather than a cache to clear.
	 */
	invalidate(): void {}

	get currentTab(): number {
		return this.activeTab;
	}

	/**
	 * Test seam: current search state. `active` means "the search box has the
	 * keyboard"; a filter stays applied after Enter hands the keyboard back, so the
	 * two are deliberately not one flag.
	 */
	get search(): { active: boolean; filtering: boolean; query: string; matches: number; position: number } {
		return {
			active: this.searchMode,
			filtering: this.searchQuery.length > 0,
			query: this.searchQuery,
			matches: this.currentMatches().length,
			position: this.matchIndex,
		};
	}

	handleInput(data: string): void {
		if (this.closed) return;

		// Tab switches tabs from anywhere, including mid-search: a query that has
		// to be Escaped out of first is a query that hides which key did what.
		if (matchesKey(data, Key.tab)) {
			this.cycle(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.cycle(-1);
			return;
		}

		if (this.searchMode) {
			if (matchesKey(data, Key.escape)) {
				// Escape leaves search first; a second Escape closes the viewer.
				if (this.searchQuery) this.searchQuery = "";
				else this.searchMode = false;
				this.matchIndex = 0;
			} else if (matchesKey(data, Key.enter)) {
				this.searchMode = false;
			} else if (matchesKey(data, Key.backspace)) {
				this.searchQuery = this.searchQuery.slice(0, -1);
				this.matchIndex = 0;
			} else if (data === " ") {
				// Bracketed paste and readlines hand a space through as "space".
				this.searchQuery += " ";
				this.matchIndex = 0;
			} else if (data.length === 1 && !data.startsWith("\x1b")) {
				this.searchQuery += data;
				this.matchIndex = 0;
			}
			// The match you just typed is the one you want to see, even when it was
			// scrolled off-screen before the query existed.
			const matches = this.currentMatches();
			if (matches.length > 0) this.scrollTo(matches[0]!);
			this.changed();
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) {
			this.close();
			return;
		}

		if (matchesKey(data, "/")) {
			this.searchMode = true;
			this.searchQuery = "";
			this.matchIndex = 0;
			this.changed();
			return;
		}

		if (data === "n") {
			this.stepMatch(1);
			return;
		}
		if (data === "N") {
			this.stepMatch(-1);
			return;
		}

		if (data === "y") {
			void this.copyActiveTab();
			return;
		}

		const rows = this.activeRows(this.frameWidth());
		const total = rows.length;
		const offset = this.offsets[this.activeTab] ?? 0;
		const page = Math.max(1, this.scrollRows - 1);

		if (matchesKey(data, Key.up) || data === "k") this.setOffset(offset - 1, total);
		else if (matchesKey(data, Key.down) || data === "j") this.setOffset(offset + 1, total);
		else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) this.setOffset(offset - page, total);
		else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f"))) this.setOffset(offset + page, total);
		else if (matchesKey(data, Key.ctrl("u"))) this.setOffset(offset - Math.ceil(page / 2), total);
		else if (matchesKey(data, Key.ctrl("d"))) this.setOffset(offset + Math.ceil(page / 2), total);
		else if (matchesKey(data, Key.home) || data === "g") this.setOffset(0, total);
		else if (matchesKey(data, Key.end) || data === "G") this.setOffset(total, total);
		else return;
		this.changed();
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.done();
	}

	private cycle(step: number): void {
		this.activeTab = (this.activeTab + step + this.tabs.length) % this.tabs.length;
		this.searchQuery = "";
		this.searchMode = false;
		this.matchIndex = 0;
		this.status = undefined;
		this.changed();
	}

	private setOffset(value: number, total: number): void {
		const max = Math.max(0, total - this.scrollRows);
		this.offsets[this.activeTab] = Math.max(0, Math.min(value, max));
	}

	/**
	 * The body width the rows were broken for. Keystrokes arrive between renders,
	 * so the geometry of the last frame is what scrolling has to work against;
	 * before the first frame, the terminal's own width stands in.
	 */
	private frameWidth(): number {
		return this.contentWidth ?? Math.max(8, (this.tui.terminal.columns ?? 84) - 4);
	}

	private activeLines(): string[] {
		return this.tabs[this.activeTab]?.lines ?? [];
	}

	/**
	 * The active tab as terminal rows: every logical line broken to fit the frame.
	 * Cached per tab and width — otherwise every keystroke re-wraps the tab — and
	 * never invalidated by scrolling. Measured on a 7,895-message transcript (4 MB of
	 * content, ~177k logical lines → ~269k rows): the first wrap costs ~40 ms, so a
	 * session nobody keeps open pays it once on first paint and again per resize, not
	 * per key.
	 */
	private activeRows(width: number): { text: string; line: number }[] {
		const lines = this.activeLines();
		const key = `${this.activeTab}:${width}:${lines.length}`;
		if (this.rowCache?.key === key) return this.rowCache.rows;
		const rows: { text: string; line: number }[] = [];
		for (let index = 0; index < lines.length; index++) {
			for (const piece of breakLine(lines[index]!, width)) rows.push({ text: piece, line: index });
		}
		this.rowCache = { key, rows };
		return rows;
	}

	/** The row a logical line starts on, to scroll a match into view. */
	private rowOfLine(rows: { text: string; line: number }[], line: number): number {
		const at = rows.findIndex((row) => row.line === line);
		return at < 0 ? 0 : at;
	}

	private currentMatches(): number[] {
		return findMatches(this.activeLines(), this.searchQuery);
	}

	private stepMatch(step: number): void {
		const matches = this.currentMatches();
		if (matches.length === 0) {
			this.status = this.searchQuery ? `no match for ${this.searchQuery}` : "press / to search";
			this.changed();
			return;
		}
		this.matchIndex = (this.matchIndex + step + matches.length) % matches.length;
		this.scrollTo(matches[this.matchIndex]);
		this.changed();
	}

	/** Scroll until a logical line is inside the window; counts in rows. */
	private scrollTo(line: number): void {
		const rows = this.activeRows(this.frameWidth());
		const row = this.rowOfLine(rows, line);
		const offset = this.offsets[this.activeTab] ?? 0;
		const height = Math.max(1, this.scrollRows);
		if (row < offset) this.setOffset(row, rows.length);
		else if (row >= offset + height) this.setOffset(row - height + 1, rows.length);
	}

	private async copyActiveTab(): Promise<void> {
		const text = this.activeLines().join("\n");
		if (!this.copy) {
			this.status = "clipboard unavailable here";
			this.changed();
			return;
		}
		try {
			const error = await this.copy(text);
			this.status = error ? `copy failed: ${error}` : `copied ${this.tabs[this.activeTab]?.name ?? "tab"} (${text.length} characters)`;
		} catch (error) {
			this.status = `copy failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.changed();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(8, Math.floor(width));
		const availableRows = Math.max(3, Math.floor((this.tui.terminal.rows * 92) / 100));
		const paddingY = availableRows >= 14 ? 1 : 0;
		const contentWidth = safeWidth - 4;
		const contentRows = availableRows - 2 - paddingY * 2;
		this.contentWidth = contentWidth;

		// Row budget: the tab bar and footer are structural, the subtitle and the
		// two separators are not. Drop the optional rows before the body starves.
		const rows = this.activeRows(contentWidth);
		const showSeparators = contentRows >= 8;
		const subtitleText = this.headerText();
		const showSubtitle = Boolean(subtitleText) && contentRows >= (showSeparators ? 7 : 6);
		const reserved = 1 + (showSubtitle ? 1 : 0) + (showSeparators ? 2 : 0) + 1;
		this.scrollRows = Math.max(1, contentRows - reserved);

		const body: string[] = [];
		body.push(this.tabBarLine(contentWidth));
		if (showSubtitle) body.push(fit(this.theme.fg("dim", truncateToWidth(subtitleText ?? "", contentWidth)), contentWidth));
		if (showSeparators) body.push(fit(this.theme.fg("dim", "─".repeat(contentWidth)), contentWidth));

		const offset = Math.min(this.offsets[this.activeTab] ?? 0, Math.max(0, rows.length - this.scrollRows));
		this.offsets[this.activeTab] = Math.max(0, offset);
		// Matches are counted in logical lines — the footer says how many messages
		// matched and `y` copies messages — but the window moves in rows, so a jump
		// goes to the row a matching line starts on.
		const matches = this.currentMatches();
		const matchRow = matches.length > 0 ? this.rowOfLine(rows, matches[this.matchIndex] ?? -1) : -1;
		for (let row = 0; row < this.scrollRows; row++) {
			const index = offset + row;
			const cell = rows[index];
			if (cell === undefined) {
				body.push("");
				continue;
			}
			body.push(this.renderContentLine(cell.text, index === matchRow, contentWidth));
		}

		if (showSeparators) body.push(fit(this.theme.fg("dim", "─".repeat(contentWidth)), contentWidth));
		body.push(this.footerLine(contentWidth));

		const framed = frameLines(this.theme, fillRows(body, contentRows), safeWidth, paddingY, this.titleText());
		return framed;
	}

	private titleText(): string {
		return " Context ";
	}

	private headerText(): string {
		if (this.status) return this.status;
		const hint = this.tabs[this.activeTab]?.hint;
		if (hint) return hint;
		return `${this.activeLines().length} lines`;
	}

	private tabBarLine(width: number): string {
		// Brackets rather than colour alone: the active tab has to survive a
		// monochrome terminal and a theme that maps accent to the default colour.
		const parts = this.tabs.map((tab, index) =>
			index === this.activeTab
				? this.theme.fg("accent", `[ ${tab.name} ]`)
				: this.theme.fg("dim", `  ${tab.name}  `),
		);
		return fit(parts.join(""), width);
	}

	private renderContentLine(line: string, isMatch: boolean, width: number): string {
		const query = this.searchQuery;
		if (query.length === 0) return fit(line, width);
		const lowerLine = line.toLowerCase();
		const needle = query.toLowerCase();
		const out: string[] = [];
		let from = 0;
		for (;;) {
			const at = lowerLine.indexOf(needle, from);
			if (at < 0) break;
			out.push(line.slice(from, at));
			out.push(this.theme.fg("accent", line.slice(at, at + query.length)));
			from = at + query.length;
		}
		out.push(line.slice(from));
		const marked = out.join("");
		// A marker in column zero, because the matched text itself is already
		// coloured and a second colour on the same word reads as a different match.
		return fit(isMatch ? `${this.theme.fg("accent", "›")}${marked}` : marked, width);
	}

	private footerLine(width: number): string {
		const searchState = this.searchMode || this.searchQuery.length > 0;
		const matches = this.currentMatches();
		const search = searchState
			? this.theme.fg("accent", `/${this.searchQuery}`) +
				` ${matches.length > 0 ? `${this.matchIndex + 1}/${matches.length}` : "0/0"}  `
			: "";
		return fit(`${search}${this.theme.fg("dim", FOOTER_HINT)}`, width);
	}

	private changed(): void {
		this.tui.requestRender();
	}
}
