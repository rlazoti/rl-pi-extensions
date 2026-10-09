import { type ExtensionUIContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	Input,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
	type EditorTheme,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";

import type { SnippetCatalog } from "./catalog.ts";
import { displaySafe } from "./display-safe.ts";
import { PickerState } from "./picker-state.ts";

export type SnippetPickerResult = Readonly<{ kind: "cancel" }> | Readonly<{ kind: "insert"; text: string }>;

export interface SnippetPickerOptions {
	readonly onSelectedCountChange?: (count: number) => void;
	readonly signal?: AbortSignal;
}

type BrowseFocus = "search" | "list" | "preview";
type FormFocus = Readonly<
	{ kind: "field"; filename: string; fieldName: string } | { kind: "preview" } | { kind: "back" } | { kind: "insert" }
>;

interface FieldEditorEntry {
	readonly filename: string;
	readonly fieldName: string;
	readonly editor: Editor;
}

const BROWSE_FOCUS: readonly BrowseFocus[] = ["search", "list", "preview"];
const PICKER_HEIGHT_PERCENT = 70;

function fit(line: string, width: number): string {
	return truncateToWidth(line, Math.max(1, width), "", true);
}

function renderText(text: string, width: number): string[] {
	return new Text(text.length === 0 ? "(empty)" : text, 0, 0).render(Math.max(1, width));
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
	const title = truncateToWidth(" Snippets ", width - 2, "");
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

function editorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("border", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}

function sameFormFocus(left: FormFocus, right: FormFocus): boolean {
	return (
		left.kind === right.kind &&
		(left.kind !== "field" ||
			(right.kind === "field" && left.filename === right.filename && left.fieldName === right.fieldName))
	);
}

export class SnippetPicker implements Component, Focusable {
	readonly state: PickerState;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (result: SnippetPickerResult) => void;
	private readonly options: SnippetPickerOptions;
	private readonly searchInput = new Input({ prompt: "", placeholder: "name, description, or filename" });
	private readonly fieldEditors = new Map<string, FieldEditorEntry>();
	private browseFocusIndex = 1;
	private formFocusIndex = 0;
	private previewOffset = 0;
	private previewRows = 1;
	private formOffset = 0;
	private completed = false;
	private isFocused = false;
	private abortListener: (() => void) | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		catalog: SnippetCatalog,
		done: (result: SnippetPickerResult) => void,
		options: SnippetPickerOptions = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.options = options;
		this.state = new PickerState(catalog);
		this.options.onSelectedCountChange?.(0);
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
		this.syncChildFocus();
	}

	get focusTarget(): string {
		if (this.state.stage === "browse") return BROWSE_FOCUS[this.browseFocusIndex]!;
		const focus = this.formFocuses()[this.formFocusIndex] ?? { kind: "insert" as const };
		return focus.kind === "field" ? `field:${focus.filename}:${focus.fieldName}` : focus.kind;
	}

	get previewScroll(): number {
		return this.previewOffset;
	}

	getFieldEditor(filename: string, fieldName: string): Editor | undefined {
		return this.fieldEditors.get(this.fieldKey(filename, fieldName))?.editor;
	}

	handleInput(data: string): void {
		if (this.completed) return;
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.moveFocus(matchesKey(data, Key.shift("tab")) ? -1 : 1);
			this.changed();
			return;
		}

		if (this.state.stage === "browse") this.handleBrowseInput(data);
		else this.handleFormInput(data);
		this.changed();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const availableRows = Math.max(1, Math.floor((this.tui.terminal.rows * PICKER_HEIGHT_PERCENT) / 100));
		const framed = safeWidth >= 8 && availableRows >= 5;
		const paddingY = framed && availableRows >= 9 ? 1 : 0;
		const contentWidth = framed ? safeWidth - 4 : safeWidth;
		const contentRows = availableRows - (framed ? 2 + 2 * paddingY : 0);
		const expanded = framed || contentRows >= 4;
		const standaloneTitle = !framed && expanded;
		const showSummary = expanded;
		const showFooter = expanded || contentRows >= 2;
		const reservedRows = Number(standaloneTitle) + Number(showSummary) + Number(showFooter);
		const diagnosticLimit = expanded ? Math.max(0, contentRows - reservedRows - 1) : 0;
		const diagnostics = this.diagnosticLines(contentWidth).slice(0, diagnosticLimit);
		const bodyRows = Math.max(1, contentRows - reservedRows - diagnostics.length);
		const lines: string[] = [];

		if (standaloneTitle) lines.push(fit(this.theme.fg("accent", this.theme.bold("Snippets")), contentWidth));
		if (this.state.stage === "browse") {
			if (showSummary) lines.push(this.renderSearch(contentWidth));
			lines.push(...fillRows(this.renderBrowseBody(contentWidth, bodyRows), bodyRows));
			lines.push(...diagnostics);
			if (showFooter) {
				lines.push(
					fit(
						this.theme.fg("dim", "↑↓ navigate • Space toggle • / search • Tab focus • Enter continue • Esc cancel"),
						contentWidth,
					),
				);
			}
		} else {
			if (showSummary) {
				lines.push(fit(this.theme.fg("muted", `${this.state.selectedFilenames.length} selected`), contentWidth));
			}
			lines.push(...fillRows(this.renderFormBody(contentWidth, bodyRows), bodyRows));
			lines.push(...diagnostics);
			if (showFooter) {
				lines.push(
					fit(
						this.theme.fg("dim", "Esc back • Enter choose action • Tab/Shift+Tab focus • Shift+Enter/Ctrl+J newline"),
						contentWidth,
					),
				);
			}
		}

		this.syncChildFocus();
		const content = fillRows(lines, contentRows);
		return framed
			? frameLines(this.theme, content, safeWidth, paddingY)
			: content.map((line) => panelLine(this.theme, line, safeWidth));
	}

	invalidate(): void {
		this.searchInput.invalidate();
		for (const { editor } of this.fieldEditors.values()) editor.invalidate();
	}

	private handleBrowseInput(data: string): void {
		const focus = BROWSE_FOCUS[this.browseFocusIndex]!;
		if (focus === "search") {
			if (matchesKey(data, Key.escape) || this.keybindings.matches(data, "tui.select.confirm")) {
				this.browseFocusIndex = 1;
				return;
			}
			this.searchInput.handleInput(data);
			this.state.setQuery(this.searchInput.getValue());
			this.previewOffset = 0;
			return;
		}

		if (focus === "preview") {
			if (matchesKey(data, Key.escape)) {
				this.browseFocusIndex = 1;
				return;
			}
			if (this.previewKey(data)) return;
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.complete({ kind: "cancel" });
			return;
		}
		if (matchesKey(data, "/")) {
			this.browseFocusIndex = 0;
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.state.moveFocus(-1);
			this.previewOffset = 0;
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.state.moveFocus(1);
			this.previewOffset = 0;
			return;
		}
		if (matchesKey(data, Key.space)) {
			this.changeSelection(() => this.state.toggleFocused());
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) this.advance();
	}

	private handleFormInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.syncEditorValues();
			this.state.back();
			this.browseFocusIndex = 1;
			this.previewOffset = 0;
			return;
		}

		const focus = this.formFocuses()[this.formFocusIndex];
		if (focus === undefined) return;
		if (focus.kind === "preview") {
			this.previewKey(data);
			return;
		}
		if (focus.kind === "back") {
			if (this.keybindings.matches(data, "tui.select.confirm")) {
				this.syncEditorValues();
				this.state.back();
				this.browseFocusIndex = 1;
			}
			return;
		}
		if (focus.kind === "insert") {
			if (this.keybindings.matches(data, "tui.select.confirm")) this.advance();
			return;
		}

		if (this.keybindings.matches(data, "tui.input.submit") && !this.keybindings.matches(data, "tui.input.newLine")) {
			this.formFocusIndex = this.formFocuses().findIndex(({ kind }) => kind === "insert");
			return;
		}
		const editor = this.getFieldEditor(focus.filename, focus.fieldName);
		if (editor === undefined) return;
		editor.handleInput(data);
		this.state.setFieldValue(focus.filename, focus.fieldName, editor.getExpandedText());
		this.clampPreview(this.previewContent(), this.previewRows);
	}

	private advance(): void {
		this.syncEditorValues();
		const before = this.state.selectedFilenames.length;
		const result = this.state.advance();
		this.emitCountIfChanged(before);
		if (result.kind === "idle") return;
		if (result.kind === "insert") {
			this.complete(result);
			return;
		}
		this.ensureFieldEditors();
		this.formFocusIndex = 0;
		this.formOffset = 0;
		this.previewOffset = 0;
	}

	private changeSelection(change: () => void): void {
		const before = this.state.selectedFilenames.length;
		change();
		this.emitCountIfChanged(before);
	}

	private emitCountIfChanged(before: number): void {
		const after = this.state.selectedFilenames.length;
		if (before !== after) this.options.onSelectedCountChange?.(after);
	}

	private complete(result: SnippetPickerResult): void {
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

	private moveFocus(delta: number): void {
		if (this.state.stage === "browse") {
			this.browseFocusIndex = (this.browseFocusIndex + delta + BROWSE_FOCUS.length) % BROWSE_FOCUS.length;
		} else {
			const focuses = this.formFocuses();
			if (focuses.length > 0) this.formFocusIndex = (this.formFocusIndex + delta + focuses.length) % focuses.length;
		}
		this.syncChildFocus();
	}

	private formFocuses(): readonly FormFocus[] {
		const fields: FormFocus[] = this.state.fieldGroups.flatMap((group) =>
			group.fields.map((field) => ({
				kind: "field" as const,
				filename: group.snippet.filename,
				fieldName: field.name,
			})),
		);
		return [...fields, { kind: "preview" }, { kind: "back" }, { kind: "insert" }];
	}

	private ensureFieldEditors(): void {
		for (const group of this.state.fieldGroups) {
			for (const field of group.fields) {
				const key = this.fieldKey(group.snippet.filename, field.name);
				if (this.fieldEditors.has(key)) continue;
				const editor = new Editor(this.tui, editorTheme(this.theme), { paddingX: 0 });
				editor.disableSubmit = true;
				editor.setText(field.value);
				this.fieldEditors.set(key, {
					filename: group.snippet.filename,
					fieldName: field.name,
					editor,
				});
			}
		}
		this.syncChildFocus();
	}

	private syncEditorValues(): void {
		for (const entry of this.fieldEditors.values()) {
			this.state.setFieldValue(entry.filename, entry.fieldName, entry.editor.getExpandedText());
		}
	}

	private syncChildFocus(): void {
		this.searchInput.focused = this.isFocused && this.state.stage === "browse" && this.focusTarget === "search";
		const current = this.state.stage === "fields" ? this.formFocuses()[this.formFocusIndex] : undefined;
		for (const entry of this.fieldEditors.values()) {
			entry.editor.focused =
				this.isFocused &&
				current?.kind === "field" &&
				entry.filename === current.filename &&
				entry.fieldName === current.fieldName;
		}
	}

	private renderSearch(width: number): string {
		const prefix = this.focusTarget === "search" ? this.theme.fg("accent", "Search › ") : "Search   ";
		const [input = ""] = this.searchInput.render(Math.max(1, width - 9));
		return fit(prefix + input, width);
	}

	private renderBrowseBody(width: number, rows: number): string[] {
		if (width >= 88) {
			const listWidth = Math.max(30, Math.floor((width - 3) * 0.43));
			const previewWidth = width - listWidth - 3;
			const list = this.renderList(listWidth, rows);
			const preview = this.renderPreview(previewWidth, rows);
			return Array.from({ length: rows }, (_, index) =>
				fit(`${fit(list[index] ?? "", listWidth)} │ ${fit(preview[index] ?? "", previewWidth)}`, width),
			);
		}

		const listRows = Math.max(1, Math.ceil(rows * 0.55));
		const previewRows = Math.max(0, rows - listRows);
		return [...this.renderList(width, listRows), ...this.renderPreview(width, previewRows)];
	}

	private renderList(width: number, rows: number): string[] {
		const contentRows = Math.max(0, rows - 1);
		this.state.setListRows(Math.max(1, contentRows));
		const heading = fit(this.theme.fg(this.focusTarget === "list" ? "accent" : "muted", "Snippets"), width);
		if (contentRows === 0) return [heading];
		if (this.state.filteredSnippets.length === 0) {
			const message =
				this.state.catalog.state === "unavailable"
					? "Unable to read snippets"
					: this.state.query.length > 0
						? "No matching snippets"
						: "No snippets found";
			const hint = `Add Markdown files in ${displaySafe(this.state.catalog.directory)}`;
			return [heading, fit(this.theme.fg("warning", message), width), ...renderText(hint, width)].slice(0, rows);
		}

		const visible = this.state.filteredSnippets.slice(this.state.listScroll, this.state.listScroll + contentRows);
		return [
			heading,
			...visible.map((item, localIndex) => {
				const index = this.state.listScroll + localIndex;
				const focused = index === this.state.focusedIndex;
				const number = this.state.selectionNumber(item.filename);
				const marker = number === undefined ? "○ " : `✓${number} `;
				const line = `${focused ? "›" : " "} ${marker}${displaySafe(item.name)} (${displaySafe(item.filename)})`;
				return fit(this.theme.fg(focused ? "accent" : number === undefined ? "text" : "success", line), width);
			}),
		].slice(0, rows);
	}

	private renderPreview(width: number, rows: number): string[] {
		if (rows <= 0) {
			this.previewRows = 1;
			this.previewOffset = 0;
			return [];
		}
		const heading = fit(this.theme.fg(this.focusTarget === "preview" ? "accent" : "muted", "Preview"), width);
		const contentRows = Math.max(0, rows - 1);
		this.previewRows = Math.max(1, contentRows);
		const content = renderText(this.previewContent(), width);
		this.clampPreviewLines(content, this.previewRows);
		return [heading, ...content.slice(this.previewOffset, this.previewOffset + contentRows)].map((line) =>
			fit(line, width),
		);
	}

	private renderFormBody(width: number, rows: number): string[] {
		this.ensureFieldEditors();
		if (width >= 88) {
			const formWidth = Math.max(38, Math.floor((width - 3) * 0.55));
			const previewWidth = width - formWidth - 3;
			const form = this.renderForm(formWidth, rows);
			const preview = this.renderPreview(previewWidth, rows);
			return Array.from({ length: rows }, (_, index) =>
				fit(`${fit(form[index] ?? "", formWidth)} │ ${fit(preview[index] ?? "", previewWidth)}`, width),
			);
		}

		const formRows = Math.max(1, Math.ceil(rows * 0.65));
		const previewRows = Math.max(0, rows - formRows);
		return [...this.renderForm(width, formRows), ...this.renderPreview(width, previewRows)];
	}

	private renderForm(width: number, rows: number): string[] {
		const lines: string[] = [];
		const ranges: Array<{ focus: FormFocus; start: number; end: number }> = [];
		for (const group of this.state.fieldGroups) {
			for (const field of group.fields) {
				const focus: FormFocus = { kind: "field", filename: group.snippet.filename, fieldName: field.name };
				const start = lines.length;
				lines.push(
					fit(
						this.theme.fg(
							this.focusTarget === `field:${group.snippet.filename}:${field.name}` ? "accent" : "muted",
							`${displaySafe(group.snippet.name)} (${displaySafe(group.snippet.filename)}) — ${displaySafe(field.name)}`,
						),
						width,
					),
				);
				const editor = this.getFieldEditor(group.snippet.filename, field.name);
				if (editor !== undefined) lines.push(...editor.render(width).map((line) => fit(line, width)));
				ranges.push({ focus, start, end: Math.max(start, lines.length - 1) });
			}
		}
		const backStart = lines.length;
		lines.push(fit(this.renderAction("back", "← Back", "return to snippets"), width));
		ranges.push({ focus: { kind: "back" }, start: backStart, end: backStart });
		const insertStart = lines.length;
		lines.push(fit(this.renderAction("insert", "Insert", "place resolved text at cursor"), width));
		ranges.push({ focus: { kind: "insert" }, start: insertStart, end: insertStart });

		const current = this.formFocuses()[this.formFocusIndex];
		const anchor = current?.kind === "preview" ? ({ kind: "insert" } as const) : current;
		const range = anchor === undefined ? undefined : ranges.find(({ focus }) => sameFormFocus(focus, anchor));
		const maximum = Math.max(0, lines.length - rows);
		this.formOffset = Math.min(this.formOffset, maximum);
		if (range !== undefined) {
			if (range.start < this.formOffset) this.formOffset = range.start;
			if (range.end >= this.formOffset + rows) this.formOffset = Math.min(maximum, range.end - rows + 1);
		}
		return lines.slice(this.formOffset, this.formOffset + rows);
	}

	private renderAction(kind: "back" | "insert", label: string, hint: string): string {
		const active = this.focusTarget === kind;
		return this.theme.fg(active ? "accent" : "text", `${active ? "›" : " "} [ ${label} ] ${hint}`);
	}

	private diagnosticLines(width: number): string[] {
		return this.state.catalog.diagnostics.map((diagnostic) =>
			fit(
				this.theme.fg(
					"warning",
					`! ${diagnostic.filename === undefined ? "" : `${displaySafe(diagnostic.filename)}: `}${displaySafe(diagnostic.message)}`,
				),
				width,
			),
		);
	}

	private previewContent(): string {
		if (this.state.stage === "fields") return this.state.composedText;
		const item = this.state.focusedSnippet;
		return item === undefined ? "Select a snippet to preview it." : this.state.resolvedText(item);
	}

	private previewKey(data: string): boolean {
		if (matchesKey(data, Key.up)) this.previewOffset -= 1;
		else if (matchesKey(data, Key.down)) this.previewOffset += 1;
		else if (matchesKey(data, Key.pageUp)) this.previewOffset -= this.previewRows;
		else if (matchesKey(data, Key.pageDown)) this.previewOffset += this.previewRows;
		else return false;
		this.previewOffset = Math.max(0, this.previewOffset);
		return true;
	}

	private clampPreview(content: string, rows: number): void {
		this.clampPreviewLines(renderText(content, 80), rows);
	}

	private clampPreviewLines(lines: readonly string[], rows: number): void {
		this.previewOffset = Math.min(Math.max(0, this.previewOffset), Math.max(0, lines.length - rows));
	}

	private fieldKey(filename: string, fieldName: string): string {
		return `${filename}\u0000${fieldName}`;
	}

	private changed(): void {
		this.syncChildFocus();
		this.tui.requestRender();
	}
}

export async function openSnippetPicker(
	ui: Pick<ExtensionUIContext, "custom">,
	catalog: SnippetCatalog,
	options: SnippetPickerOptions = {},
): Promise<SnippetPickerResult> {
	if (options.signal?.aborted) return { kind: "cancel" };
	const result = await ui.custom<SnippetPickerResult | undefined>(
		(tui, theme, keybindings, done) => new SnippetPicker(tui, theme, keybindings, catalog, done, options),
		{
			overlay: true,
			overlayOptions: { width: "80%", maxHeight: `${PICKER_HEIGHT_PERCENT}%`, anchor: "center" },
		},
	);
	return result ?? { kind: "cancel" };
}
