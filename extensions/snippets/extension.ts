import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadSnippetCatalog, type CatalogDiagnostic, type SnippetCatalog } from "./catalog.js";
import { displaySafe } from "./display-safe.js";
import {
	EditorInsertionAdapter,
	type EditorCaptureResult,
	type EditorHost,
	type EditorInitializationResult,
	type EditorInsertResult,
	type EditorInsertionSnapshot,
} from "./editor-adapter.js";
import { openSnippetPicker, type SnippetPickerOptions, type SnippetPickerResult } from "./picker.js";

export const SNIPPETS_SHORTCUT = "alt+shift+s" as const;
export const SNIPPETS_WIDGET_KEY = "pi-snippets" as const;

export interface SnippetEditorAdapter {
	initialize(host: EditorHost): EditorInitializationResult;
	capture(): EditorCaptureResult;
	insert(snapshot: EditorInsertionSnapshot, text: string): EditorInsertResult;
	shutdown(): void;
}

export interface SnippetsExtensionDependencies {
	readonly adapter?: SnippetEditorAdapter;
	readonly loadCatalog?: () => Promise<SnippetCatalog>;
	readonly openPicker?: (
		ui: Pick<ExtensionContext["ui"], "custom">,
		catalog: SnippetCatalog,
		options?: SnippetPickerOptions,
	) => Promise<SnippetPickerResult>;
}

interface ActiveSession {
	readonly ui: ExtensionContext["ui"];
	initialization: EditorInitializationResult | undefined;
}

interface ActiveRequest {
	readonly id: number;
	readonly session: ActiveSession;
	readonly abortController: AbortController;
}

const MAX_NOTIFICATION_DIAGNOSTICS = 3;

function diagnosticSummary(diagnostics: readonly CatalogDiagnostic[]): string {
	const shown = diagnostics
		.slice(0, MAX_NOTIFICATION_DIAGNOSTICS)
		.map((diagnostic) =>
			displaySafe(
				diagnostic.filename === undefined ? diagnostic.message : `${diagnostic.filename}: ${diagnostic.message}`,
			),
		);
	const remaining = diagnostics.length - shown.length;
	if (remaining > 0) shown.push(`${remaining} more diagnostic${remaining === 1 ? "" : "s"}.`);
	return shown.join("\n");
}

export class SnippetsController {
	private readonly adapter: SnippetEditorAdapter;
	private readonly loadCatalog: () => Promise<SnippetCatalog>;
	private readonly openPicker: NonNullable<SnippetsExtensionDependencies["openPicker"]>;
	private session: ActiveSession | undefined;
	private activeRequest: ActiveRequest | undefined;
	private nextRequestId = 1;

	constructor(dependencies: SnippetsExtensionDependencies = {}) {
		this.adapter = dependencies.adapter ?? new EditorInsertionAdapter();
		this.loadCatalog = dependencies.loadCatalog ?? (() => loadSnippetCatalog());
		this.openPicker = dependencies.openPicker ?? openSnippetPicker;
	}

	startSession(ctx: ExtensionContext): void {
		if (!ctx.hasUI || this.session) return;
		this.session = { ui: ctx.ui, initialization: undefined };
		this.session.initialization = this.adapter.initialize(ctx.ui);
	}

	shutdownSession(_ctx: ExtensionContext): void {
		if (!this.session) return;
		this.endSession(this.session);
		this.session = undefined;
	}

	async open(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				"pi-snippets requires Pi's interactive TUI; custom editors are unavailable in this mode.",
				"warning",
			);
			return;
		}
		if (!this.session) {
			ctx.ui.notify("pi-snippets is not initialized for the active session.", "error");
			return;
		}

		const session = this.session!;
		if (session.initialization && !session.initialization.ok) {
			ctx.ui.notify(displaySafe(session.initialization.message), "error");
			return;
		}
		if (this.activeRequest) {
			ctx.ui.notify("A snippet picker is already open. Use Escape to cancel it.", "warning");
			return;
		}

		const captured = this.adapter.capture();
		if (!captured.ok) {
			ctx.ui.notify(displaySafe(captured.message), "error");
			return;
		}

		const request: ActiveRequest = {
			id: this.nextRequestId++,
			session,
			abortController: new AbortController(),
		};
		this.activeRequest = request;

		try {
			const catalog = await this.loadCatalog();
			if (!this.isCurrent(request)) return;
			if (catalog.snippets.length === 0) {
				const message =
					catalog.state === "missing"
						? `Snippet directory not found: ${displaySafe(catalog.directory)}`
						: catalog.state === "empty"
							? `No Markdown snippets found in ${displaySafe(catalog.directory)}.`
							: `No usable snippets found in ${displaySafe(catalog.directory)}.`;
				const details = diagnosticSummary(catalog.diagnostics);
				ctx.ui.notify(
					details.length === 0 ? message : `${message}\n${details}`,
					catalog.state === "unavailable" ? "error" : catalog.diagnostics.length > 0 ? "warning" : "info",
				);
				return;
			}
			if (catalog.diagnostics.length > 0) {
				ctx.ui.notify(
					`${catalog.diagnostics.length} snippet file${catalog.diagnostics.length === 1 ? " was" : "s were"} skipped; valid snippets remain available.`,
					"warning",
				);
			}
			const result = await this.openPicker(session.ui, catalog, {
				signal: request.abortController.signal,
				onSelectedCountChange: (count) => {
					if (!this.isCurrent(request)) return;
					session.ui.setWidget(SNIPPETS_WIDGET_KEY, [
						`Snippets: ${count} selected · Alt+Shift+S · fallback: /snippets (conflicts: /hotkeys)`,
					]);
				},
			});
			if (!this.isCurrent(request) || result.kind === "cancel") return;
			if (result.text.length === 0) {
				ctx.ui.notify("Selected snippets resolved to empty text; the draft was left unchanged.", "info");
				return;
			}
			const inserted = this.adapter.insert(captured.snapshot, result.text);
			if (!inserted.ok) ctx.ui.notify(`Snippet insertion stopped: ${displaySafe(inserted.message)}`, "error");
		} catch (error) {
			if (this.isCurrent(request)) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Unable to open snippets: ${displaySafe(message)}`, "error");
			}
		} finally {
			if (this.activeRequest === request) {
				this.activeRequest = undefined;
				session.ui.setWidget(SNIPPETS_WIDGET_KEY, undefined);
			}
		}
	}

	private isCurrent(request: ActiveRequest): boolean {
		return (
			this.activeRequest === request && this.session === request.session && !request.abortController.signal.aborted
		);
	}

	private endSession(session: ActiveSession): void {
		if (this.activeRequest?.session === session) {
			this.activeRequest.abortController.abort();
			this.activeRequest = undefined;
		}
		session.ui.setWidget(SNIPPETS_WIDGET_KEY, undefined);
		this.adapter.shutdown();
	}
}

export function registerSnippetsExtension(
	pi: ExtensionAPI,
	dependencies: SnippetsExtensionDependencies = {},
): SnippetsController {
	const controller = new SnippetsController(dependencies);
	pi.registerCommand("snippets", {
		description: "Insert predefined text snippets into the prompt",
		handler: async (_args, ctx) => controller.open(ctx),
	});
	pi.registerShortcut(SNIPPETS_SHORTCUT, {
		description: "Insert predefined text snippets into the prompt",
		handler: async (ctx) => controller.open(ctx),
	});
	pi.on("session_start", (_event, ctx) => controller.startSession(ctx));
	pi.on("session_shutdown", (_event, ctx) => controller.shutdownSession(ctx));
	return controller;
}
