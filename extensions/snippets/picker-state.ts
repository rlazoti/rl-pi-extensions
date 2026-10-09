import type { CatalogSnippet, SnippetCatalog } from "./catalog.js";
import type { PlaceholderField } from "./placeholders.js";

export type PickerStage = "browse" | "fields";

export type PickerAdvanceResult =
	| Readonly<{ kind: "idle" }>
	| Readonly<{ kind: "fields" }>
	| Readonly<{ kind: "insert"; text: string }>;

export interface PickerField extends PlaceholderField {
	readonly value: string;
}

export interface PickerFieldGroup {
	readonly snippet: CatalogSnippet;
	readonly fields: readonly PickerField[];
}

export class PickerState {
	readonly catalog: SnippetCatalog;

	private queryValue = "";
	private filtered: readonly CatalogSnippet[];
	private focusIndex = -1;
	private scroll = 0;
	private listRows = 1;
	private selected: string[] = [];
	private readonly snippetsByFilename: ReadonlyMap<string, CatalogSnippet>;
	private readonly values = new Map<string, Map<string, string>>();
	private currentStage: PickerStage = "browse";

	constructor(catalog: SnippetCatalog) {
		this.catalog = catalog;
		this.filtered = catalog.snippets.slice();
		this.focusIndex = this.filtered.length === 0 ? -1 : 0;
		this.snippetsByFilename = new Map(catalog.snippets.map((item) => [item.filename, item]));
	}

	get stage(): PickerStage {
		return this.currentStage;
	}

	get query(): string {
		return this.queryValue;
	}

	get filteredSnippets(): readonly CatalogSnippet[] {
		return this.filtered;
	}

	get focusedIndex(): number {
		return this.focusIndex;
	}

	get focusedSnippet(): CatalogSnippet | undefined {
		return this.focusIndex < 0 ? undefined : this.filtered[this.focusIndex];
	}

	get listScroll(): number {
		return this.scroll;
	}

	get selectedFilenames(): readonly string[] {
		return this.selected.slice();
	}

	get selectedSnippets(): readonly CatalogSnippet[] {
		return this.selected.flatMap((filename) => {
			const item = this.snippetsByFilename.get(filename);
			return item === undefined ? [] : [item];
		});
	}

	get fieldGroups(): readonly PickerFieldGroup[] {
		return this.selectedSnippets.flatMap((item) => {
			if (item.template.fields.length === 0) return [];
			return [
				{
					snippet: item,
					fields: item.template.fields.map((field) => ({
						...field,
						value: this.getFieldValue(item.filename, field.name),
					})),
				},
			];
		});
	}

	get composedText(): string {
		return this.selectedSnippets.map((item) => this.resolvedText(item)).join("\n\n");
	}

	resolvedText(item: CatalogSnippet): string {
		return item.template.render(this.values.get(item.filename));
	}

	setQuery(query: string): void {
		this.queryValue = query;
		const normalized = query.toLocaleLowerCase();
		this.filtered = this.catalog.snippets.filter((item) =>
			[item.name, item.description ?? "", item.filename].some((value) =>
				value.toLocaleLowerCase().includes(normalized),
			),
		);
		this.focusIndex =
			this.filtered.length === 0 ? -1 : Math.min(Math.max(this.focusIndex, 0), this.filtered.length - 1);
		this.clampScroll();
	}

	setListRows(rows: number): void {
		this.listRows = Math.max(1, Math.floor(rows));
		this.clampScroll();
	}

	moveFocus(delta: number): void {
		if (this.filtered.length === 0) {
			this.focusIndex = -1;
			this.scroll = 0;
			return;
		}
		this.focusIndex = Math.min(this.filtered.length - 1, Math.max(0, this.focusIndex + delta));
		this.clampScroll();
	}

	selectionNumber(filename: string): number | undefined {
		const index = this.selected.indexOf(filename);
		return index < 0 ? undefined : index + 1;
	}

	toggle(filename: string): void {
		const item = this.snippetsByFilename.get(filename);
		if (item === undefined) return;
		const index = this.selected.indexOf(filename);
		if (index >= 0) {
			this.selected.splice(index, 1);
			return;
		}
		this.selected.push(filename);
		this.initializeValues(item);
	}

	toggleFocused(): void {
		const item = this.focusedSnippet;
		if (item !== undefined) this.toggle(item.filename);
	}

	advance(): PickerAdvanceResult {
		if (this.currentStage === "browse" && this.selected.length === 0) {
			if (this.focusedSnippet === undefined) return { kind: "idle" };
			this.toggleFocused();
		}
		if (this.selected.length === 0) return { kind: "idle" };

		if (this.currentStage === "browse" && this.fieldGroups.length > 0) {
			this.currentStage = "fields";
			return { kind: "fields" };
		}
		return { kind: "insert", text: this.composedText };
	}

	back(): void {
		this.currentStage = "browse";
	}

	getFieldValue(filename: string, fieldName: string): string {
		const item = this.snippetsByFilename.get(filename);
		const field = item?.template.fields.find(({ name }) => name === fieldName);
		if (field === undefined) return "";
		return this.values.get(filename)?.get(fieldName) ?? field.initialValue;
	}

	setFieldValue(filename: string, fieldName: string, value: string): void {
		const item = this.snippetsByFilename.get(filename);
		if (item?.template.fields.some(({ name }) => name === fieldName) !== true) return;
		this.initializeValues(item);
		this.values.get(filename)!.set(fieldName, value);
	}

	private initializeValues(item: CatalogSnippet): void {
		if (this.values.has(item.filename)) return;
		this.values.set(item.filename, new Map(item.template.fields.map((field) => [field.name, field.initialValue])));
	}

	private clampScroll(): void {
		if (this.focusIndex < 0) {
			this.scroll = 0;
			return;
		}
		const maximum = Math.max(0, this.filtered.length - this.listRows);
		this.scroll = Math.min(this.scroll, maximum);
		if (this.focusIndex < this.scroll) this.scroll = this.focusIndex;
		if (this.focusIndex >= this.scroll + this.listRows) this.scroll = this.focusIndex - this.listRows + 1;
	}
}
