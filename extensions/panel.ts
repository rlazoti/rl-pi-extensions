import { truncateToWidth, visibleWidth, type Theme } from "@earendil-works/pi-tui";

/**
 * Shared framed-panel layout helpers for the overlay pickers (rl-extensions,
 * snippets). One implementation so both pickers frame identically.
 */

/** Truncate to width, never wider than 1 column. */
export function fit(line: string, width: number): string {
	return truncateToWidth(line, Math.max(1, width), "", true);
}

/**
 * Pad one line to `width` and paint the whole panel background
 * (`customMessageBg`), preserving ANSI sequences already in the line.
 */
export function panelLine(theme: Theme, line: string, width: number): string {
	const background = theme.getBgAnsi("customMessageBg");
	const padded = fit(line, width);
	const restored = padded.replace(/\u001b\[(?:0|49)?m/g, (reset) => reset + background);
	return theme.bg("customMessageBg", restored);
}

/**
 * Wrap `content` in a double-line frame with a centered-left title bar,
 * `paddingY` blank rows above and below the body, every row panel-colored.
 */
export function frameLines(
	theme: Theme,
	content: readonly string[],
	width: number,
	paddingY: number,
	title: string,
): string[] {
	const inner = width - 4;
	const border = (text: string) => theme.fg("accent", text);
	const trimmedTitle = truncateToWidth(title, width - 2, "");
	const top = border(`╔${trimmedTitle}${"═".repeat(Math.max(0, width - 2 - visibleWidth(trimmedTitle)))}╗`);
	const bottom = border(`╚${"═".repeat(width - 2)}╝`);
	const blank = border("║") + " ".repeat(width - 2) + border("║");
	const body = content.map((line) => border("║") + " " + fit(line, inner) + " " + border("║"));
	return [top, ...Array<string>(paddingY).fill(blank), ...body, ...Array<string>(paddingY).fill(blank), bottom].map(
		(line) => panelLine(theme, line, width),
	);
}

/** Pad/trim `lines` to exactly `rows` rows. */
export function fillRows(lines: readonly string[], rows: number): string[] {
	return Array.from({ length: rows }, (_, index) => lines[index] ?? "");
}
