import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	type TUI,
	type KeybindingsManager,
	type Focusable,
	type Component,
} from "@earendil-works/pi-tui";

import { fit, fillRows, frameLines, panelLine } from "../panel.js";

import {
	getAvailableExtensions,
	isExtensionEnabled,
	enableExtension,
	disableExtension,
	type ExtensionDescriptor,
} from "../symlink-manager.js";

export interface ExtensionPickerOptions {
	readonly signal?: AbortSignal;
}

export type ExtensionPickerResult = Readonly<{ kind: "cancel" }> | Readonly<{ kind: "apply"; enabledCount: number }>;

const PICKER_HEIGHT_PERCENT = 60;

const EXTENSIONS: ExtensionDescriptor[] = getAvailableExtensions(process.cwd());

const SEARCH_PLACEHOLDER = "name or description";

export class ExtensionPicker implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (result: ExtensionPickerResult) => void;
	private readonly options: ExtensionPickerOptions;

	private selectedIndex = 0;
	private searchQuery = "";
	private searchFocused = false;
	private pendingChanges = new Map<string, boolean>();
	private completed = false;
	private isFocused = false;
	private abortListener: (() => void) | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: ExtensionPickerResult) => void,
		options: ExtensionPickerOptions = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.options = options;
		if (this.options.signal) {
			this.abortListener = () => this.complete({ kind: "cancel" });
			this.options.signal.addEventListener("abort", this.abortListener, { once: true });
		}
	}

	dispose(): void {
		this.removeAbortListener();
	}

	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		this.isFocused = value;
	}

	get focusTarget(): string {
		return this.searchFocused ? "search" : "list";
	}

	private getVisibleList(): ExtensionDescriptor[] {
		const filtered = this.filteredExtensions();
		return filtered.length > 0 ? filtered : EXTENSIONS;
	}

	private clampIndex(index: number): number {
		const visible = this.getVisibleList();
		return Math.max(0, Math.min(visible.length - 1, index));
	}

	handleInput(data: string): void {
		if (this.completed) return;

		if (this.searchFocused) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab)) {
				this.searchFocused = false;
				this.changed();
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				this.searchQuery = this.searchQuery.slice(0, -1);
			} else if (data.length === 1) {
				this.searchQuery += data;
			}
			// A keystroke may shrink the visible list; clamp instead of resetting
			// so the selection never points out of range (and rarely jumps).
			this.selectedIndex = this.clampIndex(this.selectedIndex);
			this.changed();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex = this.clampIndex(this.selectedIndex - 1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = this.clampIndex(this.selectedIndex + 1);
		} else if (matchesKey(data, "/")) {
			this.searchFocused = true;
			this.changed();
			return;
		} else if (matchesKey(data, Key.space)) {
			const visible = this.getVisibleList();
			const ext = visible[this.selectedIndex];
			if (ext) {
				// Flip the EFFECTIVE state (pending ?? disk). The disk only changes
				// on apply, so toggling from isExtensionEnabled() alone made
				// toggle-off-then-toggle-on a no-op (v1.1.0 bug): the marker never
				// returned, and Enter would leave the extension disabled even
				// though the user had re-selected it.
				const pending = this.pendingChanges.get(ext.name);
				const effective = pending !== undefined ? pending : isExtensionEnabled(ext.name);
				this.pendingChanges.set(ext.name, !effective);
				this.changed();
				return;
			}
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			// Apply all pending changes
			for (const [name, enabled] of this.pendingChanges) {
				if (enabled) {
					enableExtension(name, EXTENSIONS.find((e) => e.name === name)?.path ?? "");
				} else {
					disableExtension(name);
				}
			}
			this.pendingChanges.clear();
			this.complete({ kind: "apply", enabledCount: this.enabledCount() });
			return;
		} else if (matchesKey(data, Key.escape)) {
			this.complete({ kind: "cancel" });
			return;
		} else {
			return;
		}
		this.changed();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const availableRows = Math.max(1, Math.floor((this.tui.terminal.rows * PICKER_HEIGHT_PERCENT) / 100));
		const framed = safeWidth >= 8 && availableRows >= 5;
		const paddingY = framed && availableRows >= 9 ? 1 : 0;
		const contentWidth = framed ? safeWidth - 4 : safeWidth;
		const contentRows = availableRows - (framed ? 2 + 2 * paddingY : 0);
		const lines: string[] = [];

		const filtered = this.filteredExtensions();
		const visible = filtered.length > 0 ? filtered : EXTENSIONS;

		// Reserve rows: search + separator + status + button + footer
		const reservedRows = 5;
		const listRows = Math.max(0, contentRows - reservedRows);

		// Search input line
		const searchPrefix = this.searchFocused
			? this.theme.fg("accent", "Search › ")
			: "Search   ";
		const searchInput = this.searchFocused ? this.searchQuery : SEARCH_PLACEHOLDER;
		const searchColor = this.searchFocused ? "accent" : "muted";
		lines.push(fit(this.theme.fg(searchColor, searchPrefix + searchInput), contentWidth));

		// Separator
		lines.push("");

		// Extension list
		for (let i = 0; i < Math.min(visible.length, listRows); i++) {
			const ext = visible[i];
			const isSelected = i === this.selectedIndex;
			const pendingEnabled = this.pendingChanges.get(ext.name);
			const enabled = pendingEnabled !== undefined ? pendingEnabled : isExtensionEnabled(ext.name);
			const marker = enabled ? this.theme.fg("success", "●") : this.theme.fg("dim", "○");
			const prefix = isSelected ? this.theme.fg("accent", "› ") : "  ";
			const nameStyle = isSelected ? "accent" : enabled ? "text" : "muted";
			const name = this.theme.fg(nameStyle, ext.label);
			const desc = this.theme.fg("muted", ext.description);
			lines.push(fit(`${prefix}${marker} ${name} — ${desc}`, contentWidth));
		}

		// Empty state
		if (filtered.length === 0 && this.searchQuery.length > 0) {
			lines.push(fit(this.theme.fg("warning", "No matching extensions"), contentWidth));
		}

		// Separator before status
		lines.push("");

		// Status line — pending-aware, matching the list markers above
		const enabledCount = this.enabledCount();
		const pendingNote = this.pendingChanges.size > 0 ? ` • ${this.pendingChanges.size} pending` : "";
		lines.push(fit(this.theme.fg("dim", `${enabledCount}/${EXTENSIONS.length} enabled${pendingNote}`), contentWidth));

		// Separator after status
		lines.push("");

		// Footer
		lines.push(
			fit(
				this.theme.fg("dim", "↑↓ navigate • Space toggle • / search • Enter apply • Esc cancel"),
				contentWidth,
			),
		);

		const content = fillRows(lines, contentRows);
		return framed
			? frameLines(this.theme, content, safeWidth, paddingY, " Extensions ")
			: content.map((line) => panelLine(this.theme, line, safeWidth));
	}

	invalidate(): void {}

	private filteredExtensions(): ExtensionDescriptor[] {
		if (this.searchQuery.length === 0) return [];
		const query = this.searchQuery.toLowerCase();
		return EXTENSIONS.filter(
			(ext) =>
				ext.name.toLowerCase().includes(query) || ext.description.toLowerCase().includes(query),
		);
	}

	private enabledCount(): number {
		return EXTENSIONS.filter((e) => {
			const pending = this.pendingChanges.get(e.name);
			return pending !== undefined ? pending : isExtensionEnabled(e.name);
		}).length;
	}

	private complete(result: ExtensionPickerResult): void {
		if (this.completed) return;
		this.completed = true;
		this.removeAbortListener();
		this.done(result);
	}

	private removeAbortListener(): void {
		if (!this.abortListener) return;
		this.options.signal?.removeEventListener("abort", this.abortListener);
		this.abortListener = undefined;
	}

	private changed(): void {
		this.tui.requestRender();
	}
}

export async function openExtensionPicker(
	ui: Pick<ExtensionUIContext, "custom">,
	options: ExtensionPickerOptions = {},
): Promise<ExtensionPickerResult> {
	if (options.signal?.aborted) return { kind: "cancel" };
	const result = await ui.custom<ExtensionPickerResult | undefined>(
		(tui, theme, keybindings, done) => new ExtensionPicker(tui, theme, keybindings, done, options),
		{
			overlay: true,
			overlayOptions: { width: "80%", maxHeight: `${PICKER_HEIGHT_PERCENT}%`, anchor: "center" },
		},
	);
	return result ?? { kind: "cancel" };
}
