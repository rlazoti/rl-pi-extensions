/**
 * Finding a heading, and where its body ends — one rule for `memory_append`, rollover and
 * the carry-forward audit, so three features cannot read one file three ways.
 */
/**
 * Escape a string for literal use inside a RegExp.
 */
export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * Find a section heading, and where its body ends.
 *
 * Two heading levels are in play: the template writes `### Completed`, a
 * hand-written file may use `## Completed`. This used to search for either with a
 * single `###?` pattern, so a file holding both got appended to whichever came
 * first in the file instead of the deeper, template-shaped one. Levels are tried
 * in preference order now.
 *
 * The heading is also escaped. Interpolated raw, `WIP (2026)` became a capture
 * group that silently matched nothing, and `WIP [2026` threw SyntaxError out of
 * the tool call.
 */
export function findSection(content: string, heading: string): { bodyStart: number; end: number } | null {
	const needle = escapeRegExp(heading);
	for (const level of ["###", "##"]) {
		const match = content.match(new RegExp(`^${level}\\s+${needle}\\s*$`, "m"));
		if (!match || match.index === undefined) continue;

		const bodyStart = match.index + match[0].length;
		const rest = content.slice(bodyStart);
		// A section runs to the next heading of either level, or to end of file.
		const offset = rest.search(/^#{2,3}\s+/m);
		return { bodyStart, end: offset === -1 ? content.length : bodyStart + offset };
	}
	return null;
}
export function extractSection(content: string, heading: string): string | null {
	const found = findSection(content, heading);
	if (!found) return null;
	return content.slice(found.bodyStart, found.end).trim() || null;
}
