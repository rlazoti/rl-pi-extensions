export type PlaceholderErrorCode =
	| "conflicting-default"
	| "invalid-name"
	| "invalid-value"
	| "nested-placeholder"
	| "unsafe-control"
	| "unterminated-placeholder";

export class PlaceholderError extends Error {
	readonly code: PlaceholderErrorCode;
	readonly offset?: number;

	constructor(code: PlaceholderErrorCode, message: string, offset?: number) {
		super(message);
		this.name = "PlaceholderError";
		this.code = code;
		this.offset = offset;
	}
}

export interface PlaceholderField {
	readonly name: string;
	readonly initialValue: string;
}

export interface ParsedPlaceholderTemplate {
	readonly fields: readonly PlaceholderField[];
	/**
	 * Renders each parsed token exactly once. Missing values use initialValue;
	 * a present Map entry, including an empty string, always wins.
	 */
	render(values?: ReadonlyMap<string, string>): string;
}

type TemplateToken = Readonly<{ type: "text"; value: string } | { type: "placeholder"; name: string }>;
type FieldState = { readonly name: string; explicitDefault?: string };

const PLACEHOLDER_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function terminalControlAt(value: string): { index: number; codePoint: number } | undefined {
	for (let index = 0; index < value.length; index += 1) {
		const codePoint = value.charCodeAt(index);
		const allowedWhitespace = codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d;
		if ((!allowedWhitespace && codePoint <= 0x1f) || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f)) {
			return { index, codePoint };
		}
	}
	return undefined;
}

export function assertTerminalSafe(value: string, label: string): void {
	const control = terminalControlAt(value);
	if (control === undefined) return;

	const renderedCodePoint = `U+${control.codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
	throw new PlaceholderError(
		"unsafe-control",
		`${label} contains unsafe terminal control ${renderedCodePoint} at offset ${control.index}`,
		control.index,
	);
}

function appendText(tokens: TemplateToken[], value: string): void {
	if (value.length === 0) return;
	const previous = tokens.at(-1);
	if (previous?.type === "text") {
		tokens[tokens.length - 1] = Object.freeze({ type: "text", value: previous.value + value });
		return;
	}
	tokens.push(Object.freeze({ type: "text", value }));
}

/**
 * Parses {{name}} and {{name:default}} placeholders.
 *
 * The returned immutable template throws PlaceholderError for malformed input.
 * Rendering accepts a ReadonlyMap so names such as "__proto__" remain ordinary
 * keys and so a present empty value is distinguishable from a missing value.
 */
export function parsePlaceholderTemplate(source: string): ParsedPlaceholderTemplate {
	assertTerminalSafe(source, "placeholder source");

	const tokens: TemplateToken[] = [];
	const fieldsByName = new Map<string, FieldState>();
	let cursor = 0;

	while (cursor < source.length) {
		const opening = source.indexOf("{{", cursor);
		if (opening === -1) {
			appendText(tokens, source.slice(cursor));
			break;
		}

		const closing = source.indexOf("}}", opening + 2);
		if (closing === -1) {
			throw new PlaceholderError(
				"unterminated-placeholder",
				`unterminated placeholder opening at offset ${opening}`,
				opening,
			);
		}

		if (source[opening - 1] === "\\") {
			appendText(tokens, source.slice(cursor, opening - 1));
			appendText(tokens, source.slice(opening, closing + 2));
			cursor = closing + 2;
			continue;
		}

		appendText(tokens, source.slice(cursor, opening));
		const content = source.slice(opening + 2, closing);
		if (content.includes("{{")) {
			throw new PlaceholderError(
				"nested-placeholder",
				`nested placeholder syntax is unsupported at offset ${opening}`,
				opening,
			);
		}

		const colon = content.indexOf(":");
		const name = colon === -1 ? content : content.slice(0, colon);
		const explicitDefault = colon === -1 ? undefined : content.slice(colon + 1);
		if (!PLACEHOLDER_NAME.test(name)) {
			throw new PlaceholderError(
				"invalid-name",
				`invalid placeholder name ${JSON.stringify(name)} at offset ${opening}; expected ${PLACEHOLDER_NAME}`,
				opening,
			);
		}

		const existing = fieldsByName.get(name);
		if (existing === undefined) {
			fieldsByName.set(name, { name, explicitDefault });
		} else if (explicitDefault !== undefined) {
			if (existing.explicitDefault !== undefined && existing.explicitDefault !== explicitDefault) {
				throw new PlaceholderError(
					"conflicting-default",
					`placeholder ${JSON.stringify(name)} has conflicting defaults ${JSON.stringify(existing.explicitDefault)} and ${JSON.stringify(explicitDefault)}`,
					opening,
				);
			}
			existing.explicitDefault = explicitDefault;
		}

		tokens.push(Object.freeze({ type: "placeholder", name }));
		cursor = closing + 2;
	}

	const fields = Object.freeze(
		Array.from(fieldsByName.values(), ({ name, explicitDefault }) =>
			Object.freeze({ name, initialValue: explicitDefault ?? "" }),
		),
	);
	const frozenTokens = Object.freeze(tokens.slice());
	const initialValues = new Map(fields.map((field) => [field.name, field.initialValue]));

	const template: ParsedPlaceholderTemplate = {
		fields,
		render(values) {
			let rendered = "";
			for (const token of frozenTokens) {
				if (token.type === "text") {
					rendered += token.value;
					continue;
				}

				const value = values?.has(token.name) ? values.get(token.name) : initialValues.get(token.name);
				if (typeof value !== "string") {
					throw new PlaceholderError(
						"invalid-value",
						`placeholder value for ${JSON.stringify(token.name)} must be a string`,
					);
				}
				assertTerminalSafe(value, `placeholder value for ${JSON.stringify(token.name)}`);
				rendered += value;
			}
			return rendered;
		},
	};

	return Object.freeze(template);
}
