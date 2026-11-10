import type { QuestionData, AnswerData, AskResult } from "./types.js";

export interface ToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

/**
 * A note rendered as one line of prose. The stored value keeps its newlines — the
 * JSON below it carries them — but the header line is meant to read as a sentence.
 */
function asLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Notes are written as lines above the JSON, not only as fields inside it: a string
 * sitting next to `answers` reads like one more answer to choose between, and these
 * are the user's words about all of them.
 */
function noteLines(result: AskResult, questions: QuestionData[]): string[] {
	const lines: string[] = [];
	if (result.note) lines.push(`User note: ${asLine(result.note)}`);
	if (result.questionNotes) {
		for (const q of questions) {
			const note = result.questionNotes[q.id];
			if (note) lines.push(`User note on ${q.id} (${JSON.stringify(q.question)}): ${asLine(note)}`);
		}
	}
	return lines;
}

export function formatResult(
	result: AskResult,
	questions: QuestionData[],
): ToolResult {
	const questionMap: Record<string, string> = {};
	for (const q of questions) { questionMap[q.id] = q.question; }

	const notes = noteLines(result, questions);

	return {
		content: [{ type: "text", text: [...notes, JSON.stringify(result)].join("\n") }],
		details: {
			answered: Object.keys(result.answers).length > 0,
			questions: questionMap,
			answers: result.answers,
			skipped: result.skipped,
			unanswered: result.unanswered,
			...(result.note ? { note: result.note } : {}),
			...(result.questionNotes ? { questionNotes: result.questionNotes } : {}),
		},
	};
}

export function formatSingleFreeResult(id: string, answer: string | null | undefined): ToolResult {
	if (!answer?.trim()) {
		return {
			content: [{ type: "text", text: "User skipped. Proceed with your best judgment." }],
			details: {
				answered: false,
				answers: {},
				skipped: [id],
				unanswered: [],
			},
		};
	}

	const result = {
		answers: { [id]: [{ value: answer.trim(), custom: true }] as AnswerData[] },
		skipped: [] as string[],
		unanswered: [] as string[],
	};

	return {
		content: [{ type: "text", text: JSON.stringify(result) }],
		details: { answered: true, ...result },
	};
}

export function formatCancelledResult(): ToolResult {
	return {
		content: [{ type: "text", text: "Cancelled. Proceed with your best judgment." }],
		details: { cancelled: true },
	};
}

export function formatNoUIResult(): ToolResult {
	return {
		content: [{ type: "text", text: "Cannot ask — no UI available. Make your best judgment and proceed." }],
		details: { cancelled: true },
	};
}
