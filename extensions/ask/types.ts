export interface OptionData {
	label: string;
	value: string;
	description?: string;
	recommended?: boolean;
}

export interface QuestionData {
	id: string;
	question: string;
	label: string;
	context?: string;
	multi?: boolean;
	options?: OptionData[];
}

export interface AnswerData {
	label?: string;
	value: string;
	description?: string;
	note?: string;
	custom?: boolean;
}

/**
 * What the questionnaire returns, and what the tool result is built from.
 *
 * Two kinds of note, neither of which is an answer: `note` is the user's note for
 * the whole ask — one text applying to every question — and `questionNotes` is keyed
 * by question id for notes attached to a single question without picking an option.
 * They are absent rather than empty, so a questionnaire with no notes serialises
 * exactly as it did before notes existed.
 */
export interface AskResult {
	answers: Record<string, AnswerData[]>;
	skipped: string[];
	unanswered: string[];
	note?: string;
	questionNotes?: Record<string, string>;
}

import type { AskConfig } from "./config.js";

type RawOption = string | (Omit<OptionData, "value"> & { value?: string });

export function normalizeOptions(raw: RawOption[] | undefined, questionId = "(unspecified)"): OptionData[] | undefined {
	if (!raw || raw.length === 0) return undefined;
	const seen = new Map<string, number>();
	return raw.map((o, index) => {
		const option = typeof o === "string" ? { label: o, value: o } : { ...o, value: o.value ?? o.label };
		const first = seen.get(option.value);
		if (first !== undefined) {
			throw new Error(`Question ${JSON.stringify(questionId)}: options ${first + 1} and ${index + 1} share a value. Give them distinct explicit values or distinct labels when omitting values.`);
		}
		seen.set(option.value, index);
		return option;
	});
}

export function normalizeQuestion(raw: any, config: AskConfig): QuestionData {
	const q: QuestionData = {
		id: raw.id,
		question: raw.question,
		label: raw.label,
		context: raw.context,
		options: normalizeOptions(raw.options, raw.id),
	};
	if (raw.multi === false && config.enableSingleSelect) {
		q.multi = false;
	}
	if (!q.options && !config.enableFreeForm) {
		q.options = [{ label: "(no options)", value: "" }];
	}
	return q;
}

export function normalizeQuestions(raw: any, config: AskConfig): QuestionData[] {
	const arr = Array.isArray(raw) ? raw : [raw];
	return arr.map((q: any) => normalizeQuestion(q, config));
}
