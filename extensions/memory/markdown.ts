/**
 * One markdown section parser for the whole component.
 *
 * Both the migration and the daily rollover need the same thing — a section tree
 * with fenced blocks treated as content, not structure — and two parsers is how one
 * format ends up with two subtly different meanings. Everything that reads
 * structure in this component goes through here.
 */

export interface Section {
	level: number;
	title: string;
	/** Lines owned by this heading, before any child heading. */
	lines: string[];
	/** Headings nested under this one, in document order. */
	children: Section[];
}

export interface ParsedMarkdown {
	/** Everything before the first heading (the title line is dropped). */
	preamble: string[];
	nodes: Section[];
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*\S)\s*$/;

/** Fence open/close, shared by everything that reads markdown in this component. */
export const FENCE = /^ {0,3}(```|~~~)/;
/** A top-level list marker, at the outermost indentation the parser accepts. */
export const BULLET = /^\s{0,3}([-*]|\d+\.)\s+/;

export function parseMarkdown(text: string, options: { dropTopHeading?: boolean } = {}): ParsedMarkdown {
	const dropTop = options.dropTopHeading !== false;
	const preamble: string[] = [];
	const roots: Section[] = [];
	const stack: Section[] = [];
	let fence: string | null = null;

	for (const line of text.split(/\r?\n/)) {
		const fenceMatch = FENCE.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1]!;
			if (fence === null) fence = marker;
			else if (fence === marker) fence = null;
			target(preamble, stack).push(line);
			continue;
		}

		const heading = fence === null ? HEADING.exec(line) : null;
		if (heading) {
			const level = heading[1]!.length;
			const title = heading[2]!.trim();
			if (dropTop && level === 1 && stack.length === 0) continue;
			const section: Section = { level, title, lines: [], children: [] };
			while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
			if (stack.length === 0) roots.push(section);
			else stack[stack.length - 1]!.children.push(section);
			stack.push(section);
			continue;
		}

		target(preamble, stack).push(line);
	}

	return { preamble, nodes: roots };
}

function target(preamble: string[], stack: Section[]): string[] {
	return stack.length === 0 ? preamble : stack[stack.length - 1]!.lines;
}

/** A section's own lines plus everything nested inside it, as written. */
export function sectionText(section: Section): string {
	const parts = [section.lines.join("\n").trim()];
	for (const child of section.children) {
		parts.push(`${"#".repeat(child.level)} ${child.title}`, sectionText(child));
	}
	return parts.filter((part) => part !== "").join("\n\n").trim();
}

/** Nodes at a given level, in document order. */
export function nodesAtLevel(parsed: ParsedMarkdown, level: number): Section[] {
	const found: Section[] = [];
	const walk = (nodes: Section[]) => {
		for (const node of nodes) {
			if (node.level === level) found.push(node);
			walk(node.children);
		}
	};
	walk(parsed.nodes);
	return found;
}
