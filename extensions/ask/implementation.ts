/**
 * Ask Tool Extension (Tabbed Multi-Question Interface)
 *
 * Supports single-select, multi-select, structured options with
 * descriptions and recommended badges, free-form text, and
 * feature-gated configuration.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, Editor, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type EditorTheme } from "@earendil-works/pi-tui";
import { QuestionnaireState, type QuestionData, type OptionData, type AnswerData } from "./state.js";
import { InputHandler, InputAction } from "./input-handler.js";
import { normalizeQuestions } from "./types.js";
import { formatResult, formatSingleFreeResult, formatCancelledResult, formatNoUIResult } from "./result.js";
import { defaultConfig, type AskConfig } from "./config.js";
import { withHerdrBlocked } from "./herdr.js";

export default function askExtension(pi: ExtensionAPI) {
	const config: AskConfig = { ...defaultConfig };

	const OptionDataSchema = Type.Object({
		label: Type.String({ description: "Display label" }),
		value: Type.String({ description: "Value returned in result" }),
		description: Type.Optional(Type.String({ description: "Shown when option is focused" })),
		recommended: Type.Optional(Type.Boolean({ description: "Show ★ badge and pre-focus" })),
	});

	const AskQuestionSchema = Type.Object({
		id: Type.String({ description: "Unique identifier for this question" }),
		question: Type.String({ description: "The question text" }),
		label: Type.String({ description: "Short 1-2 word tab label" }),
		context: Type.Optional(
			Type.String({ description: "Optional context/instruction for this question" }),
		),
		multi: Type.Optional(
			Type.Boolean({ description: "Whether multiple options can be selected. Defaults to true (multi-select). Set to false when the question expects exactly one answer (e.g. picking a time slot, choosing one option from a list)." }),
		),
		options: Type.Optional(
			Type.Array(Type.Union([Type.String(), OptionDataSchema]), {
				description: "Predefined choices. Strings are shorthand for { label, value }.",
			}),
		),
	});

	pi.registerTool({
		name: "ask",
		label: "Ask User",
		description:
			"Ask the user one or more questions with optional single-select or multi-select options. Tabbed interface with keyboard navigation.",
		promptSnippet:
			"Use ask to prompt the user for input. Supports single or multiple questions. Each question can be multi-select (default) or single-select (multi: false) — always pick the right mode for the question.",
		promptGuidelines: [
			"Use ask for questions with predefined options — the user can select multiple or write custom answers.",
			"Pass a single question object or an array of questions for a tabbed interface. Each question needs a short 'label' for the tab.",
			"For each question with options, decide: should the user pick ONE answer (multi: false) or MULTIPLE (default)? Use single-select for mutually exclusive choices.",
			"Options can be strings or objects with { label, value, description?, recommended? }.",
			"Users navigate tabs with Tab/h/l, options with j/k, toggle with Space, skip question with 's', submit with Enter.",
			"All text fields (question, label, context, option labels/descriptions) must be plain text — no markdown, no formatting.",
		],
		parameters: Type.Object({
			questions: Type.Union([
				AskQuestionSchema,
				Type.Array(AskQuestionSchema),
			], {
				description: "Single question or array of questions to ask",
			}),
		}),
		async execute(_toolCallId: string, params, _signal: AbortSignal | undefined, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return formatNoUIResult();
			}

			const questions = normalizeQuestions(params.questions, config);

			if (config.enableNotifications) {
				const sessionName = pi.getSessionName();
				pi.events.emit("notify:send", {
					title: sessionName ? `π: ${sessionName}` : "π",
					body: questions.length === 1
						? questions[0].question
						: `${questions.length} questions waiting for input`,
				});
			}

			// Single free-form question → simple input
			if (questions.length === 1 && !questions[0].options?.length) {
				const answer = await withHerdrBlocked(pi, "Waiting for input", () =>
					ctx.ui.input(questions[0].question, ""),
				);
				return formatSingleFreeResult(questions[0].id, answer);
			}

			// RPC supports input(), but not custom TUI components.
			if (ctx.mode !== "tui") return formatNoUIResult();

			// Tabbed interface
			const result = await withHerdrBlocked(pi, "Waiting for input", () =>
				ctx.ui.custom<{ answers: Record<string, AnswerData[]>; skipped: string[]; unanswered: string[] } | null>(
					(tui, theme, _kb, done) => {
					const state = new QuestionnaireState(questions);
					const inputHandler = new InputHandler(state);
					const editor = new Editor(tui, createEditorTheme(theme));
					const initializedTabs = new Set<number>();

					let cachedLines: string[] | undefined;
					let cachedWidth: number | undefined;

					const clearRenderCache = () => {
						cachedLines = undefined;
						cachedWidth = undefined;
					};

					const refresh = () => {
						clearRenderCache();
						tui.requestRender();
					};

					const toggleCustomOption = () => {
						if (!config.showCustomOption) return;
						if (state.hasCustomAnswer()) {
							state.toggleCustomSelected();
						} else {
							state.focusedOptionIndex = state.getCustomOptionIndex();
							state.editorActive = true;
							editor.setText("");
						}
					};

					const openCustomEditor = (prefill: string) => {
						if (!config.showCustomOption) return;
						state.focusedOptionIndex = state.getCustomOptionIndex();
						state.editorActive = true;
						editor.setText(prefill);
					};

					const initTab = () => {
						if (initializedTabs.has(state.currentTab)) return;
						initializedTabs.add(state.currentTab);
						if (config.enableRecommended) {
							state.focusedOptionIndex = state.getRecommendedIndex();
						}
					};

					initTab();

					const handleInput = (data: string) => {
						if (state.editorActive) {
							if (matchesKey(data, Key.escape)) {
								editor.setText("");
								state.editorActive = false;
								state.noteEditingValue = null;
								refresh();
								return;
							}
							if (matchesKey(data, Key.enter)) {
								// Large pastes are displayed as markers; submit their original text.
								const text = editor.getExpandedText().trim();
								if (state.noteEditingValue) {
									if (text) {
										state.setNote(state.noteEditingValue, text);
									} else {
										state.clearNote(state.noteEditingValue);
									}
									state.noteEditingValue = null;
								} else {
									if (text) {
										state.setCustomAnswer(text);
									} else {
										state.clearCustomAnswer();
									}
								}
								editor.setText("");
								state.editorActive = false;
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						const action = inputHandler.process(data);

						switch (action) {
							case InputAction.AdvanceTab:
								state.advanceTab();
								state.editorActive = false;
								initTab();
								break;
							case InputAction.GoBackTab:
								state.goBackTab();
								state.editorActive = false;
								initTab();
								break;
							case InputAction.NextOption:
								state.focusNextOption();
								break;
							case InputAction.PrevOption:
								state.focusPrevOption();
								break;
							case InputAction.ToggleFocused:
								if (state.isOnCustomOption()) {
									toggleCustomOption();
								} else {
									inputHandler.toggleFocusedOption();
								}
								break;
							case InputAction.ToggleOptionByNumber: {
								const index = inputHandler.getLastNumberIndex();
								if (index === state.getCustomOptionIndex()) {
									toggleCustomOption();
								} else {
									inputHandler.toggleOptionByIndex(index);
								}
								break;
							}
							case InputAction.StartCustom:
								openCustomEditor(state.getCustomAnswer() || "");
								break;
							case InputAction.StartNote: {
								if (!config.enableNotes) break;
								const q = state.currentQuestion();
								if (!q?.options) break;
								const opt = q.options[state.focusedOptionIndex];
								if (!opt) break;
								if (!state.isOptionSelected(opt.value)) {
									state.toggleOption(opt.value);
								}
								state.noteEditingValue = opt.value;
								state.editorActive = true;
								editor.setText(state.getNote(opt.value) || "");
								break;
							}
							case InputAction.Skip:
								state.skipCurrentQuestion();
								state.advanceTab();
								state.editorActive = false;
								initTab();
								break;
							case InputAction.Done:
								done(state.buildResult());
								return;
							case InputAction.Cancel:
								done(null);
								return;
							case InputAction.None:
								return;
						}

						refresh();
					};

					const render = (width: number): string[] => {
						if (cachedLines && cachedWidth === width) return cachedLines;

						const lines: string[] = [];
						const wrapWidth = Math.max(1, width - 2);
						const add = (s: string) => { lines.push(truncateToWidth(` ${s}`, width)); };
						const addWrapped = (s: string) => {
							for (const line of wrapTextWithAnsi(s, wrapWidth)) {
								add(line);
							}
						};

						// Tab bar
						const tabs: string[] = [];
						for (let i = 0; i < questions.length; i++) {
							const qid = questions[i].id;
							const label = ` ${questions[i].label} `;

							if (i === state.currentTab) {
								tabs.push(theme.bg("selectedBg", theme.fg("text", label)));
							} else if (state.isQuestionAnswered(qid)) {
								tabs.push(theme.fg("success", `✓${label}`));
							} else if (state.isQuestionSkipped(qid)) {
								tabs.push(theme.fg("warning", `↷${label}`));
							} else {
								tabs.push(theme.fg("muted", ` ${label}`));
							}
						}

						const doneLabel = " Done ";
						if (state.currentTab === state.getDonetab()) {
							tabs.push(theme.bg("selectedBg", theme.fg("text", doneLabel)));
						} else {
							tabs.push(theme.fg("muted", doneLabel));
						}

						add(` ${tabs.join(" ")}`);
						lines.push("");

						if (state.currentTab === state.getDonetab()) {
							renderSummary(lines, add, theme, state, questions);
						} else {
							const q = state.currentQuestion();
							if (q) {
								renderQuestion(lines, add, addWrapped, theme, state, q, editor, width, config);
							}
						}

						lines.push("");
						add(theme.fg("accent", "─".repeat(width)));

						cachedLines = lines;
						cachedWidth = width;
						return lines;
					};

					return {
						render,
						invalidate: clearRenderCache,
						handleInput,
					};
				},
				),
			);

			if (!result) {
				return formatCancelledResult();
			}

			return formatResult(result, questions);
		},

		renderCall(args) {
			const a = args as { questions?: any };
			const qs = Array.isArray(a.questions) ? a.questions : a.questions ? [a.questions] : [];
			if (qs.length === 0) return new Text("ask ...", 0, 0);
			return new Text(`ask ${qs.length} question${qs.length !== 1 ? "s" : ""}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const d = result.details as {
				answered?: boolean;
				questions?: Record<string, string>;
				answers?: Record<string, AnswerData[]>;
				skipped?: string[];
				unanswered?: string[];
				cancelled?: boolean;
			} | undefined;

			if (d?.cancelled) {
				return new Text(theme.fg("warning", "cancelled"), 0, 0);
			}

			const lines: string[] = [];

			if (d?.answers && d?.questions) {
				for (const [id, vals] of Object.entries(d.answers)) {
					const q = d.questions[id] || id;
					const display = vals.map(a => a.custom ? `✎ ${a.value}` : a.label || a.value).join(", ");
					lines.push(`${theme.fg("muted", q)}: ${theme.fg("text", display)}`);
				}
			}
			if (d?.skipped?.length && d?.questions) {
				for (const id of d.skipped) {
					const q = d.questions[id] || id;
					lines.push(`${theme.fg("muted", q)}: ${theme.fg("warning", "skipped")}`);
				}
			}
			if (d?.unanswered?.length && d?.questions) {
				for (const id of d.unanswered) {
					const q = d.questions[id] || id;
					lines.push(`${theme.fg("muted", q)}: ${theme.fg("dim", "unanswered")}`);
				}
			}

			if (lines.length === 0) {
				return new Text(theme.fg("dim", "no answers"), 0, 0);
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

function createEditorTheme(theme: any): EditorTheme {
	return {
		borderColor: (s: string) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		},
	};
}

function renderQuestion(
	lines: string[],
	add: (s: string) => void,
	addWrapped: (s: string) => void,
	theme: any,
	state: QuestionnaireState,
	q: QuestionData,
	editor: Editor,
	width: number,
	config: AskConfig,
) {
	addWrapped(theme.fg("text", theme.bold(q.question)));

	if (q.context) {
		lines.push("");
		addWrapped(theme.fg("muted", q.context));
	}

	lines.push("");

	if (q.options && q.options.length > 0) {
		const strategy = state.strategyFor(q);
		const isMulti = strategy.isMulti();

		add(theme.fg("accent", isMulti ? " Select one or more:" : " Select one:"));

		let focusedDescription: string | undefined;

		for (let i = 0; i < q.options.length; i++) {
			const opt = q.options[i];
			const isSelected = state.isOptionSelected(opt.value);
			const isFocused = state.isFocusedOption(i);

			const indicator = isMulti
				? (isSelected ? theme.fg("success", "☑ ") : theme.fg("dim", "☐ "))
				: (isSelected ? theme.fg("success", "◉ ") : theme.fg("dim", "○ "));

			const focusMarker = isFocused ? theme.fg("accent", "→ ") : "  ";
			const badge = (opt.recommended && config.enableRecommended) ? theme.fg("warning", " ★") : "";
			const numLabel = isMulti ? `[${i + 1}]` : `(${i + 1})`;
			const note = state.getNote(opt.value);
			const noteDisplay = (note && config.enableNotes) ? theme.fg("muted", ` — "${note}"`) : "";
			let line = `${focusMarker}${indicator}${theme.fg("accent", numLabel)} ${opt.label}${badge}${noteDisplay}`;

			if (state.editorActive && state.noteEditingValue === opt.value && isFocused) {
				line = theme.bg("selectedBg", `${focusMarker}${indicator}${theme.fg("accent", numLabel)} ${opt.label}${badge}`);
				add(line);
				for (const eline of editor.render(width - 8)) {
					add(`      ${eline}`);
				}
				add("      " + theme.fg("accent", "Enter") + theme.fg("dim", " to set note • ") + theme.fg("accent", "Esc") + theme.fg("dim", " to cancel"));
				if (opt.description && config.enableDescriptions) {
					focusedDescription = opt.description;
				}
				continue;
			}

			if (isFocused) {
				line = theme.bg("selectedBg", line);
				if (opt.description && config.enableDescriptions) {
					focusedDescription = opt.description;
				}
			}

			add(line);
		}

		// Custom option
		if (config.showCustomOption) {
			const customIdx = state.getCustomOptionIndex();
			const customFocused = state.isFocusedOption(customIdx);
			const customText = state.getCustomAnswer();
			const customSelected = state.isCustomSelected();

			const customIndicator = isMulti
				? (customSelected ? theme.fg("success", "☑ ") : theme.fg("dim", "☐ "))
				: (customSelected ? theme.fg("success", "◉ ") : theme.fg("dim", "○ "));
			const customFocusMarker = customFocused ? theme.fg("accent", "→ ") : "  ";

			const customNumLabel = isMulti ? `[${customIdx + 1}]` : `(${customIdx + 1})`;

			if (state.editorActive && customFocused) {
				let editorLabel = `${customFocusMarker}${customIndicator}${theme.fg("accent", customNumLabel)} `;
				editorLabel = theme.bg("selectedBg", editorLabel);
				add(editorLabel);
				for (const line of editor.render(width - 6)) {
					add(`    ${line}`);
				}
				add("    " + theme.fg("accent", "Enter") + theme.fg("dim", " to set • ") + theme.fg("accent", "Esc") + theme.fg("dim", " to cancel"));
			} else {
				const label = customText
					? `${theme.fg("accent", "✎")} ${customText}`
					: `${theme.fg("muted", "✎ Enter your own option...")}`;
				let line = `${customFocusMarker}${customIndicator}${theme.fg("accent", customNumLabel)} ${label}`;
				if (customFocused) {
					line = theme.bg("selectedBg", line);
				}
				add(line);
			}
		}

		// Focused option description (tooltip) — always render line to prevent UI jumping
		lines.push("");
		if (focusedDescription) {
			addWrapped(theme.fg("muted", `  ${focusedDescription}`));
		} else {
			add("");
		}

		lines.push("");
		const selCount = q.options.filter(o => state.isOptionSelected(o.value)).length +
			(state.isCustomSelected() ? 1 : 0);
		const countText = selCount > 0 ? ` (${selCount} selected)` : "";

		const noteHint = config.enableNotes ? (theme.fg("accent", " Enter") + theme.fg("dim", " note • ")) : "";
		add(theme.fg("accent", " j/k") + theme.fg("dim", " navigate • ") +
			theme.fg("accent", "Space") + theme.fg("dim", " toggle • ") +
			theme.fg("dim", "1-9 quick select") + theme.fg("muted", countText));
		add(noteHint +
			theme.fg("accent", "Tab/l") + theme.fg("dim", " next • ") +
			theme.fg("accent", "Shift+Tab/h") + theme.fg("dim", " prev • ") +
			theme.fg("accent", "s") + theme.fg("dim", " skip"));
	} else if (state.editorActive) {
		add(theme.fg("accent", " Your answer:"));
		lines.push("");
		for (const line of editor.render(width - 4)) {
			add(`  ${line}`);
		}
		lines.push("");
		add(theme.fg("accent", " Enter") + theme.fg("dim", " to set • ") + theme.fg("accent", "Esc") + theme.fg("dim", " to cancel"));
	} else {
		const customText = state.getCustomAnswer();
		if (customText) {
			add(`  ${theme.fg("success", "✓")} ${customText}`);
			lines.push("");
		}

		add(theme.fg("success", " Enter") + theme.fg("dim", " to write • ") +
			theme.fg("accent", "s") + theme.fg("dim", " to skip"));
		add(theme.fg("accent", "Tab/l") + theme.fg("dim", " next • ") +
			theme.fg("accent", "Shift+Tab/h") + theme.fg("dim", " prev"));
	}
}

function renderSummary(
	lines: string[],
	add: (s: string) => void,
	theme: any,
	state: QuestionnaireState,
	questions: QuestionData[],
) {
	add(theme.fg("accent", theme.bold(" Summary")));
	lines.push("");

	const result = state.buildResult();
	for (const q of questions) {
		if (result.answers[q.id]) {
			add(`  ${theme.fg("success", "✓")} ${theme.fg("muted", q.question.slice(0, 40))}`);
			for (const a of result.answers[q.id]) {
				const display = a.custom ? `${theme.fg("accent", "✎")} ${a.value}` : a.value;
				add(`     ${display}`);
			}
		} else if (result.skipped.includes(q.id)) {
			add(`  ${theme.fg("warning", "↷")} ${theme.fg("muted", q.question.slice(0, 40))} ${theme.fg("dim", "(skipped)")}`);
		} else {
			add(`  ${theme.fg("dim", "○")} ${theme.fg("muted", q.question.slice(0, 40))} ${theme.fg("dim", "(unanswered)")}`);
		}
	}

	lines.push("");
	add(theme.fg("success", " Enter") + theme.fg("dim", " to submit • ") +
		theme.fg("dim", "h/Tab back • l forward"));
}
