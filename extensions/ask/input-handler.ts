/**
 * Input Handler for Ask Tool
 *
 * Maps keyboard input to actions. Editor-active input is handled
 * directly by the caller (needs editor reference); this handler
 * guards against being called in that state.
 */

import { Key, matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { QuestionnaireState } from "./state.js";

export const InputAction = {
	AdvanceTab: "AdvanceTab",
	GoBackTab: "GoBackTab",
	NextOption: "NextOption",
	PrevOption: "PrevOption",
	ToggleFocused: "ToggleFocused",
	ToggleOptionByNumber: "ToggleOptionByNumber",
	StartCustom: "StartCustom",
	StartNote: "StartNote",
	StartQuestionNote: "StartQuestionNote",
	StartSharedNote: "StartSharedNote",
	Skip: "Skip",
	Done: "Done",
	Cancel: "Cancel",
	None: "None",
} as const;
export type InputAction = (typeof InputAction)[keyof typeof InputAction];

export class InputHandler {
	private lastNumberIndex = -1;

	private state: QuestionnaireState;

	constructor(state: QuestionnaireState) {
		this.state = state;
	}

	getLastNumberIndex(): number {
		return this.lastNumberIndex;
	}

	process(data: string): InputAction {
		if (this.state.editorActive) {
			return InputAction.None;
		}

		if (matchesKey(data, Key.escape)) {
			return InputAction.Cancel;
		}

		if (matchesKey(data, Key.tab) || matchesKey(data, "l") || matchesKey(data, Key.right)) {
			return InputAction.AdvanceTab;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, "h") || matchesKey(data, Key.left)) {
			return InputAction.GoBackTab;
		}

		// The shared note belongs to the whole ask, so it is reachable from the Done tab
		// too — which is where you are when you realise the context applies to everything.
		if (matchesKey(data, "n")) {
			return InputAction.StartSharedNote;
		}

		if (this.state.currentTab === this.state.getDonetab()) {
			if (matchesKey(data, Key.enter)) {
				return InputAction.Done;
			}
			return InputAction.None;
		}

		const q = this.state.currentQuestion();
		if (!q) return InputAction.None;

		// A note about this question, without having to pick an option to hang it on.
		if (matchesKey(data, "m")) {
			return InputAction.StartQuestionNote;
		}

		const hasOptions = q.options && q.options.length > 0;

		if (!hasOptions) {
			if (matchesKey(data, Key.enter)) {
				return InputAction.StartCustom;
			}
			if (matchesKey(data, "s")) {
				return InputAction.Skip;
			}
			return InputAction.None;
		}

		// Question with options (multi or single select)
		if (matchesKey(data, "s")) {
			return InputAction.Skip;
		}

		if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
			return InputAction.NextOption;
		}
		if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
			return InputAction.PrevOption;
		}

		if (matchesKey(data, Key.space)) {
			return InputAction.ToggleFocused;
		}

		const totalOptions = this.state.totalOptionCount();
		for (let i = 0; i < Math.min(totalOptions, 9); i++) {
			if (matchesKey(data, String(i + 1) as KeyId)) {
				this.lastNumberIndex = i;
				return InputAction.ToggleOptionByNumber;
			}
		}

		if (matchesKey(data, Key.enter)) {
			if (this.state.isOnCustomOption()) {
				return InputAction.StartCustom;
			}
			return InputAction.StartNote;
		}

		return InputAction.None;
	}

	toggleFocusedOption(): void {
		const q = this.state.currentQuestion();
		if (!q?.options) return;

		const focused = q.options[this.state.focusedOptionIndex];
		if (focused) {
			this.state.toggleOption(focused.value);
		}
	}

	toggleOptionByIndex(index: number): void {
		const q = this.state.currentQuestion();
		if (!q?.options || index >= q.options.length) return;

		this.state.focusedOptionIndex = index;
		this.state.toggleOption(q.options[index].value);
	}
}
