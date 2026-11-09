import type { QuestionData, AnswerData } from "./types.js";

export interface ToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

export function formatResult(
	result: { answers: Record<string, AnswerData[]>; skipped: string[]; unanswered: string[] },
	questions: QuestionData[],
): ToolResult {
	const questionMap: Record<string, string> = {};
	for (const q of questions) { questionMap[q.id] = q.question; }

	return {
		content: [{ type: "text", text: JSON.stringify(result) }],
		details: {
			answered: Object.keys(result.answers).length > 0,
			questions: questionMap,
			answers: result.answers,
			skipped: result.skipped,
			unanswered: result.unanswered,
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
