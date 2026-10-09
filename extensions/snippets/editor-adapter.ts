import { CustomEditor, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;
type CapturedEditor = CustomEditor;

const capturedEditor = Symbol("capturedEditor");
const capturedOuterFactory = Symbol("capturedOuterFactory");

export interface EditorHost {
	getEditorComponent?: ExtensionUIContext["getEditorComponent"];
	setEditorComponent?: ExtensionUIContext["setEditorComponent"];
}

export type EditorInsertionFailure =
	| "unsupported-ui"
	| "editor-conflict"
	| "editor-unavailable"
	| "inactive-session"
	| "stale-generation"
	| "ownership-lost"
	| "editor-changed"
	| "draft-changed"
	| "cursor-changed";

export interface EditorInsertionSnapshot {
	readonly generation: number;
	readonly rawText: string;
	readonly expandedText: string;
	readonly cursor: Readonly<{ line: number; col: number }>;
	readonly [capturedEditor]: CapturedEditor;
	readonly [capturedOuterFactory]: EditorFactory;
}

export type EditorInitializationResult = { readonly ok: true; readonly generation: number } | EditorInsertionError;

export type EditorCaptureResult =
	| { readonly ok: true; readonly snapshot: EditorInsertionSnapshot }
	| EditorInsertionError;

export type EditorInsertResult = { readonly ok: true } | EditorInsertionError;

export interface EditorInsertionError {
	readonly ok: false;
	readonly reason: EditorInsertionFailure;
	readonly message: string;
}

const failureMessages: Record<EditorInsertionFailure, string> = {
	"unsupported-ui": "The current Pi UI does not expose custom editor component APIs.",
	"editor-conflict": "Another extension already owns the custom editor; pi-snippets will not replace it.",
	"editor-unavailable": "Pi did not construct the snippets editor for the active session.",
	"inactive-session": "The snippets editor session is not active.",
	"stale-generation": "The insertion snapshot belongs to an earlier editor session.",
	"ownership-lost": "Another extension replaced the snippets editor factory.",
	"editor-changed": "Pi reconstructed the editor after the insertion snapshot was captured.",
	"draft-changed": "The editor draft changed while the snippet picker was open.",
	"cursor-changed": "The editor cursor changed while the snippet picker was open.",
};

function failure(reason: EditorInsertionFailure): EditorInsertionError {
	return { ok: false, reason, message: failureMessages[reason] };
}

function isMounted(root: Component, target: Component): boolean {
	const pending: Component[] = [root];
	const visited = new Set<Component>();

	while (pending.length > 0) {
		const component = pending.pop()!;
		if (component === target) return true;
		if (visited.has(component)) continue;
		visited.add(component);

		if ("children" in component && Array.isArray(component.children)) {
			pending.push(...component.children);
		}
	}

	return false;
}

export class EditorInsertionAdapter {
	private generation = 0;
	private active = false;
	private host: EditorHost | undefined;
	private factory: EditorFactory | undefined;
	private editor: CapturedEditor | undefined;
	private tui: TUI | undefined;

	initialize(host: EditorHost): EditorInitializationResult {
		if (typeof host.getEditorComponent !== "function" || typeof host.setEditorComponent !== "function") {
			return failure("unsupported-ui");
		}

		if (this.active && this.host === host && this.readyEditor().ok) {
			return { ok: true, generation: this.generation };
		}

		if (this.active) this.endSession();
		if (host.getEditorComponent() !== undefined) return failure("editor-conflict");

		this.generation++;
		const generation = this.generation;
		let factory: EditorFactory;
		factory = (tui, theme, keybindings) => {
			const editor = new CustomEditor(tui, theme, keybindings);
			if (this.active && this.generation === generation && this.host === host && this.factory === factory) {
				this.editor = editor;
				this.tui = tui;
			}
			return editor;
		};

		this.active = true;
		this.host = host;
		this.factory = factory;
		host.setEditorComponent(factory);

		return { ok: true, generation };
	}

	capture(): EditorCaptureResult {
		const ready = this.readyEditor();
		if (!ready.ok) return ready;
		const editor = ready.editor;

		return {
			ok: true,
			snapshot: {
				generation: this.generation,
				rawText: editor.getText(),
				expandedText: editor.getExpandedText(),
				cursor: editor.getCursor(),
				[capturedEditor]: editor,
				[capturedOuterFactory]: ready.outerFactory,
			},
		};
	}

	insert(snapshot: EditorInsertionSnapshot, text: string): EditorInsertResult {
		const ready = this.readyEditor();
		if (!ready.ok) return ready;
		const editor = ready.editor;

		if (snapshot.generation !== this.generation) return failure("stale-generation");
		if (snapshot[capturedOuterFactory] !== ready.outerFactory) return failure("ownership-lost");
		if (snapshot[capturedEditor] !== editor) return failure("editor-changed");
		if (snapshot.rawText !== editor.getText() || snapshot.expandedText !== editor.getExpandedText()) {
			return failure("draft-changed");
		}

		const cursor = editor.getCursor();
		if (snapshot.cursor.line !== cursor.line || snapshot.cursor.col !== cursor.col) {
			return failure("cursor-changed");
		}

		editor.insertTextAtCursor(text);
		return { ok: true };
	}

	invalidate(): void {
		this.endSession();
	}

	shutdown(): void {
		this.endSession();
	}

	private readyEditor():
		| { readonly ok: true; readonly editor: CapturedEditor; readonly outerFactory: EditorFactory }
		| EditorInsertionError {
		if (!this.active || !this.host || !this.factory) return failure("inactive-session");
		const outerFactory = this.host.getEditorComponent?.();
		if (!outerFactory) return failure("ownership-lost");
		if (!this.editor) return failure("editor-unavailable");
		if (!this.tui || !isMounted(this.tui, this.editor)) return failure("ownership-lost");
		return { ok: true, editor: this.editor, outerFactory };
	}

	private endSession(): void {
		if (!this.active) return;

		const host = this.host;
		const factory = this.factory;
		this.active = false;
		this.generation++;
		this.host = undefined;
		this.factory = undefined;
		this.editor = undefined;
		this.tui = undefined;

		if (host !== undefined && host.getEditorComponent?.() === factory) {
			host.setEditorComponent?.(undefined);
		}
	}
}
