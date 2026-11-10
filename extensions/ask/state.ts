import type { QuestionData, OptionData, AnswerData, AskResult } from "./types.js";
import type { SelectionStrategy } from "./selection-strategy.js";
import { MultiSelectStrategy, SingleSelectStrategy } from "./selection-strategy.js";

export type { QuestionData, OptionData, AnswerData };

/**
 * What the inline editor is editing, when `editorActive` is true.
 *
 * The editor used to be either an option note or a custom answer, told apart by
 * whether `noteEditingValue` was set. A note that belongs to a whole question, or to
 * the whole ask, has no option to name, so the target is now stated.
 */
export const EditorTarget = {
	Option: "option",
	Custom: "custom",
	Question: "question",
	Shared: "shared",
} as const;
export type EditorTarget = (typeof EditorTarget)[keyof typeof EditorTarget];

/** Notes that apply to one question, or to every question, keyed the way the result carries them. */
export interface NoteFields {
	note?: string;
	questionNotes?: Record<string, string>;
}

const multiStrategy = new MultiSelectStrategy();
const singleStrategy = new SingleSelectStrategy();

export class QuestionnaireState {
	private answers = new Map<string, Set<string>>();
	private custom = new Map<string, string>();
	private customSelected = new Set<string>();
	private notes = new Map<string, Map<string, string>>();
	private questionNotes = new Map<string, string>();
	private sharedNote: string | undefined;
	private skipped = new Set<string>();

	currentTab = 0;
	focusedOptionIndex = 0;
	editorActive = false;
	editorTarget: EditorTarget | undefined;
	noteEditingValue: string | null = null;

	private questions: QuestionData[];

	constructor(questions: QuestionData[]) {
		this.questions = questions;
	}

	/**
	 * Open the inline editor. One entry point so `editorActive`, the target, and the
	 * option value the editor is drawn next to can never disagree — a note that is
	 * saved against the wrong target lands on the wrong answer.
	 */
	beginEdit(target: EditorTarget, optionValue?: string): void {
		this.editorActive = true;
		this.editorTarget = target;
		this.noteEditingValue = target === EditorTarget.Option ? optionValue ?? null : null;
	}

	/** Close the editor without saving: whatever was typed is dropped. */
	cancelEdit(): void {
		this.editorActive = false;
		this.editorTarget = undefined;
		this.noteEditingValue = null;
	}

	/** Text is kept only if it carries something; blank means the user removed it. */
	private static trimmed(text: string): string | undefined {
		const value = text.trim();
		return value.length > 0 ? value : undefined;
	}

	getDonetab(): number {
		return this.questions.length;
	}

	advanceTab(): boolean {
		if (this.currentTab < this.getDonetab()) {
			this.currentTab++;
			this.focusedOptionIndex = 0;
			return true;
		}
		return false;
	}

	goBackTab(): boolean {
		if (this.currentTab > 0) {
			this.currentTab--;
			this.focusedOptionIndex = 0;
			return true;
		}
		return false;
	}

	currentQuestion(): QuestionData | null {
		if (this.currentTab >= this.questions.length) {
			return null;
		}
		return this.questions[this.currentTab];
	}

	strategyFor(q: QuestionData): SelectionStrategy {
		return q.multi === false ? singleStrategy : multiStrategy;
	}

	toggleOption(value: string): void {
		const q = this.currentQuestion();
		if (!q) return;

		this.skipped.delete(q.id);

		const current = this.answers.get(q.id) || new Set<string>();
		const strategy = this.strategyFor(q);
		this.answers.set(q.id, strategy.toggle(current, value));

		if (!strategy.isMulti()) {
			this.customSelected.delete(q.id);
		}
	}

	getCustomOptionIndex(): number {
		const q = this.currentQuestion();
		return q?.options?.length ?? 0;
	}

	isOnCustomOption(): boolean {
		return this.focusedOptionIndex === this.getCustomOptionIndex();
	}

	setCustomAnswer(text: string): void {
		const q = this.currentQuestion();
		if (!q) return;

		this.skipped.delete(q.id);
		this.custom.set(q.id, text);
		this.customSelected.add(q.id);

		if (!this.strategyFor(q).isMulti()) {
			this.answers.set(q.id, new Set<string>());
		}
	}

	getCustomAnswer(): string | undefined {
		const q = this.currentQuestion();
		if (!q) return undefined;
		return this.custom.get(q.id);
	}

	isCustomSelected(): boolean {
		const q = this.currentQuestion();
		if (!q) return false;
		return this.customSelected.has(q.id);
	}

	toggleCustomSelected(): void {
		const q = this.currentQuestion();
		if (!q) return;

		if (this.customSelected.has(q.id)) {
			this.customSelected.delete(q.id);
		} else {
			this.customSelected.add(q.id);
			this.skipped.delete(q.id);
			if (!this.strategyFor(q).isMulti()) {
				this.answers.set(q.id, new Set<string>());
			}
		}
	}

	hasCustomAnswer(): boolean {
		return !!this.getCustomAnswer();
	}

	clearCustomAnswer(): void {
		const q = this.currentQuestion();
		if (q) {
			this.custom.delete(q.id);
			this.customSelected.delete(q.id);
		}
	}

	setNote(optionValue: string, note: string): void {
		const q = this.currentQuestion();
		if (!q) return;
		if (!this.notes.has(q.id)) {
			this.notes.set(q.id, new Map());
		}
		this.notes.get(q.id)!.set(optionValue, note);
	}

	getNote(optionValue: string): string | undefined {
		const q = this.currentQuestion();
		if (!q) return undefined;
		return this.notes.get(q.id)?.get(optionValue);
	}

	clearNote(optionValue: string): void {
		const q = this.currentQuestion();
		if (!q) return;
		this.notes.get(q.id)?.delete(optionValue);
	}

	// ── Notes that are not attached to an option ───────────────────────────────

	setQuestionNote(questionId: string, text: string): void {
		const value = QuestionnaireState.trimmed(text);
		if (value) this.questionNotes.set(questionId, value);
		else this.questionNotes.delete(questionId);
	}

	getQuestionNote(questionId: string): string | undefined {
		return this.questionNotes.get(questionId);
	}

	/** The note for the tab the user is on; nothing on the Done tab, which has no question. */
	getCurrentQuestionNote(): string | undefined {
		const q = this.currentQuestion();
		return q ? this.questionNotes.get(q.id) : undefined;
	}

	setCurrentQuestionNote(text: string): void {
		const q = this.currentQuestion();
		if (q) this.setQuestionNote(q.id, text);
	}

	setSharedNote(text: string): void {
		this.sharedNote = QuestionnaireState.trimmed(text);
	}

	getSharedNote(): string | undefined {
		return this.sharedNote;
	}

	/** Question notes survive skipping their question: the note is often the reason. */
	skipCurrentQuestion(): void {
		const q = this.currentQuestion();
		if (q) {
			this.answers.delete(q.id);
			this.custom.delete(q.id);
			this.customSelected.delete(q.id);
			this.notes.delete(q.id);
			this.skipped.add(q.id);
		}
	}

	/** The two note fields, present only when they carry something. */
	noteFields(): NoteFields {
		const fields: NoteFields = {};
		if (this.sharedNote) fields.note = this.sharedNote;
		const perQuestion: Record<string, string> = {};
		for (const q of this.questions) {
			const note = this.questionNotes.get(q.id);
			if (note) perQuestion[q.id] = note;
		}
		if (Object.keys(perQuestion).length > 0) fields.questionNotes = perQuestion;
		return fields;
	}

	totalOptionCount(): number {
		const q = this.currentQuestion();
		return (q?.options?.length ?? 0) + 1;
	}

	focusNextOption(): void {
		this.focusedOptionIndex = Math.min(this.focusedOptionIndex + 1, this.totalOptionCount() - 1);
	}

	focusPrevOption(): void {
		this.focusedOptionIndex = Math.max(this.focusedOptionIndex - 1, 0);
	}

	isOptionSelected(value: string): boolean {
		const q = this.currentQuestion();
		if (!q) return false;
		return this.answers.get(q.id)?.has(value) ?? false;
	}

	isFocusedOption(index: number): boolean {
		return index === this.focusedOptionIndex;
	}

	getRecommendedIndex(): number {
		const q = this.currentQuestion();
		if (!q?.options) return 0;
		const idx = q.options.findIndex(o => o.recommended);
		return idx >= 0 ? idx : 0;
	}

	isQuestionAnswered(questionId: string): boolean {
		const answerCount = (this.answers.get(questionId)?.size ?? 0) +
			(this.customSelected.has(questionId) ? 1 : 0);
		return answerCount > 0;
	}

	isQuestionSkipped(questionId: string): boolean {
		return this.skipped.has(questionId);
	}

	buildResult(): AskResult {
		const result: Record<string, AnswerData[]> = {};
		const skippedIds: string[] = [];
		const unansweredIds: string[] = [];

		for (const q of this.questions) {
			const sel = this.answers.get(q.id) || new Set<string>();
			const cust = this.customSelected.has(q.id) ? this.custom.get(q.id) : undefined;
			const hasAnswer = sel.size > 0 || !!cust;

			if (hasAnswer) {
				const answers: AnswerData[] = [];
				const qNotes = this.notes.get(q.id);
				for (const v of sel) {
					const opt = q.options?.find(o => o.value === v);
					if (opt) {
						const a: AnswerData = { label: opt.label, value: opt.value };
						if (opt.description) a.description = opt.description;
						const note = qNotes?.get(v);
						if (note) a.note = note;
						answers.push(a);
					}
				}
				if (cust) {
					answers.push({ value: cust, custom: true });
				}
				result[q.id] = answers;
			} else if (this.skipped.has(q.id)) {
				skippedIds.push(q.id);
			} else {
				unansweredIds.push(q.id);
			}
		}

		return {
			answers: result,
			skipped: skippedIds,
			unanswered: unansweredIds,
			...this.noteFields(),
		};
	}
}
