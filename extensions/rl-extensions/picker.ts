import {
	Key,
	matchesKey,
	type Theme,
	type TUI,
	type KeybindingsManager,
	type Focusable,
	type Component,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

import {
	getAvailableExtensions,
	getEnabledExtensions,
	isExtensionEnabled,
	toggleExtension,
	type ExtensionDescriptor,
} from "../symlink-manager.js";

export interface ExtensionPickerOptions {
	readonly signal?: AbortSignal;
}

export type ExtensionPickerResult = Readonly<{ kind: "cancel" }> | Readonly<{ kind: "apply"; enabledCount: number }>;

const PICKER_HEIGHT_PERCENT = 60;

function fit(line: string, width: number): string {
	return truncateToWidth(line, Math.max(1, width), "", true);
}

function panelLine(theme: Theme, line: string, width: number): string {
	const background = theme.getBgAnsi("customMessageBg");
	const padded = fit(line, width);
	const restored = padded.replace(/\u001b\[(?:0|49)?m/g, (reset) => reset + background);
	return theme.bg("customMessageBg", restored);
}

function frameLines(theme: Theme, content: readonly string[], width: number, paddingY: number): string[] {
	const inner = width - 4;
	const border = (text: string) => theme.fg("accent", text);
	const title = truncateToWidth(" Extensions ", width - 2, "");
	const top = border(`╔${title}${"═".repeat(Math.max(0, width - 2 - visibleWidth(title)))}╗`);
	const bottom = border(`╚${"═".repeat(width - 2)}╝`);
	const blank = border("║") + " ".repeat(width - 2) + border("║");
	const body = content.map((line) => border("║") + " " + fit(line, inner) + " " + border("║"));
	return [top, ...Array<string>(paddingY).fill(blank), ...body, ...Array<string>(paddingY).fill(blank), bottom].map(
		(line) => panelLine(theme, line, width),
	);
}

function fillRows(lines: readonly string[], rows: number): string[] {
	return Array.from({ length: rows }, (_, index) => lines[index] ?? "");
}

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
			this.selectedIndex = 0;
			this.changed();
			return;
		}

		const filtered = this.filteredExtensions();

		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(filtered.length - 1, this.selectedIndex + 1);
		} else if (matchesKey(data, "/")) {
			this.searchFocused = true;
			this.changed();
			return;
		} else if (matchesKey(data, Key.space)) {
			const ext = filtered[this.selectedIndex];
			if (ext) toggleExtension(ext.name, ext.path);
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
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

		// Search input line
		const searchPrefix = this.searchFocused
			? this.theme.fg("accent", "Search › ")
			: "Search   ";
		const searchInput = this.searchFocused ? this.searchQuery : SEARCH_PLACEHOLDER;
		const searchColor = this.searchFocused ? "accent" : "muted";
		lines.push(fit(this.theme.fg(searchColor, searchPrefix + searchInput), contentWidth));

		// Extension list
		for (let i = 0; i < Math.min(visible.length, contentRows - 1); i++) {
			const ext = visible[i];
			const isSelected = i === this.selectedIndex;
			const enabled = isExtensionEnabled(ext.name);
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

		// Status line
		const enabledCount = EXTENSIONS.filter((e) => isExtensionEnabled(e.name)).length;
		lines.push(fit(this.theme.fg("dim", `${enabledCount}/${EXTENSIONS.length} enabled`), contentWidth));

		// Footer
		lines.push(
			fit(
				this.theme.fg("dim", "↑↓ navigate • Space toggle • / search • Enter apply • Esc cancel"),
				contentWidth,
			),
		);

		const content = fillRows(lines, contentRows);
		return framed
			? frameLines(this.theme, content, safeWidth, paddingY)
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
		return EXTENSIONS.filter((ext) => isExtensionEnabled(ext.name)).length;
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
	ui: Pick<import("@earendil-works/pi-coding-agent").ExtensionUIContext, "custom">,
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
