/**
 * Every bound a prompt pays for, in one place.
 *
 * The numbers and the reasoning for them belong together: a cap moved out of its own
 * explanation gets retuned by guesswork the next time it bites. Nothing here reads the
 * filesystem or the config — a cap is a pure function of text, which is what makes the
 * truncation fixtures in `handlers.test.ts` able to state their expectations exactly.
 */

/**
 * Lines of one knowledge file allowed into a prompt. The documented target is
 * 10-50 lines with 100 as the ceiling, so this only bites files that already
 * broke their own guideline — and up to three of them can match one prompt.
 */
export const MAX_INJECTED_FILE_LINES = 100;

/**
 * The same limit in the unit a prompt is billed in.
 *
 * A line cap does not bound cost, and the file that proved it is a knowledge file: 100 lines of
 * a day's archive is 14,000 characters because the lines are long. 6,000 sits above the median
 * file in this bank (2,576) and above its mean (4,209), so the cap takes the outliers a prompt
 * cannot carry and leaves an ordinary file whole — the files it takes are the ones the log shows
 * arriving at 6.7–8.5 KB. The head is kept: a knowledge file states its point at the top and
 * its source notes at the end, and losing the source notes is the cheaper error.
 */
export const MAX_INJECTED_FILE_CHARS = 6000;
/** Below this, truncating a file costs more in notice than it saves in text. */
export const MIN_FILE_CUT_CHARS = 500;
/**
 * Cap on an injected core file. Knowledge is capped and only injected when it
 * matches; core is injected on every prompt whatever the topic — so until now the
 * one unbounded path was the unconditional one, and a 900-line dailyContext cost
 * 900 lines of every prompt with no marker. 300, deliberately double the
 * 150-line daily guideline: a cap equal to a guideline truncates a file that is
 * exactly as compliant as intended.
 */
export const MAX_INJECTED_CORE_LINES = 300;
/**
 * The same cap in the unit a prompt is billed in.
 *
 * A line budget does not bound a cost. 150 lines is 13 KB when the entries run 90
 * characters, and that is what happened: measured over four days, `dailyContext.md`
 * was 4.5-6.2 KB a day and 14 KB on the worst one, every one of them inside the
 * 150-line rule, and all of it went into every prompt of every project. 8,000
 * characters against a written budget of 6,000 — the same "keep the cap away from the
 * guideline" rule as the line cap, at a ratio under 2x because characters were never
 * bounded at all and what is being rationed is money per turn.
 */
export const MAX_INJECTED_CORE_CHARS = 8000;
/**
 * Cap on one *section* of a core file, which is what actually fixes the case above:
 * 2,500 characters clears every section measured on a normal day (largest: 2,328) and
 * takes a bloated `### Carried Forward` from 4,412 to 2,500.
 *
 * Per section rather than per file, because of where a cut lands. A whole-file cut
 * keeps the top of the file, and the template puts `Context for Tomorrow` last — so a
 * bloated day loses the section that says what to do next while the 200-item task list
 * stays in every prompt. Capping sections keeps every section present and trims the fat
 * one; the file cap below then drops whole sections from the end, naming them.
 */
export const MAX_INJECTED_SECTION_LINES = 60;
export const MAX_INJECTED_SECTION_CHARS = 2500;
/** What `/memory doctor` holds a core file to, in the unit a prompt pays. */
export const MAX_CORE_FILE_BUDGET_CHARS = 6000;

/** Knowledge/history files allowed into one prompt, best-matching first. */
export const MAX_INJECTED_FILES = 3;

/** Section budgets the agent is told to keep, stated here so doctor can check them. */
export const MAX_ACTIVE_PROJECTS_LINES = 50;
export const MAX_DAILY_CONTEXT_LINES = 150;

/** Lines returned by one memory_read call, a guard rail rather than a budget. */
export const MAX_READ_LINES = 2000;
// Bound the response as well as its line count: a single very long line can
// otherwise be clipped downstream after we have recorded it as fully served.
export const MAX_READ_BYTES = 16 * 1024;

/** What an injected core file left out, in both units and by section name. */
export interface Hidden {
	lines: number;
	chars: number;
	sections: string[];
}

export const cropped = (h: Hidden): boolean => h.lines > 0 || h.chars > 0 || h.sections.length > 0;

/** How a core file reads in the log and the debug line — a pointer is not the file. */
export function coreLabel(name: string, hidden: Hidden, skipped: boolean): string {
	if (skipped) return `${name} (pointer)`;
	return cropped(hidden) ? `${name} (${hiddenNote(hidden)} hidden)` : name;
}

/** Short form for the debug line: what one core file withheld, and in what unit. */
export function hiddenNote(h: Hidden): string {
	const parts: string[] = [];
	if (h.chars > 0) parts.push(`${h.chars.toLocaleString()} chars`);
	if (h.lines > 0 && h.chars === 0) parts.push(`${h.lines} lines`);
	if (h.sections.length > 0) parts.push(`${h.sections.length} sections`);
	return parts.join(" + ");
}

/**
 * Split on headings, keeping each heading with its body. Text before the first heading
 * is a section too, named for what it is, so a core file with no headings gets the
 * section cap instead of being quietly exempt from it.
 */
export function splitSections(text: string): Array<{ name: string; body: string }> {
	const sections: Array<{ name: string; body: string }> = [];
	let current = { name: "(top of file)", body: "" };
	for (const line of text.split("\n")) {
		const heading = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
		if (heading) {
			if (current.body !== "") sections.push(current);
			current = { name: heading[1], body: `${line}\n` };
			continue;
		}
		current.body += `${line}\n`;
	}
	if (current.body !== "") sections.push(current);
	return sections.length > 0 ? sections : [{ name: "(top of file)", body: text }];
}

/**
 * Keep a block of bank text to `maxLines` and `maxChars`, reporting how much was hidden so
 * the caller can say so out loud.
 *
 * Nothing bounded size before this: one 800-line knowledge file was injected whole into every
 * prompt that matched it (~20 KB, per turn, for the rest of the session), and a read of a large
 * file returned all of it.
 */
export function capText(text: string, maxLines: number, maxChars: number): { text: string; hiddenLines: number; hiddenChars: number } {
	const lines = text.split("\n");
	let kept = lines.slice(0, maxLines).join("\n");
	if (kept.length > maxChars) kept = kept.slice(0, maxChars).replace(/\s\S*$/, "");
	const hiddenChars = Math.max(0, text.length - kept.length);
	const hiddenLines = hiddenChars === 0 ? 0 : Math.max(0, lines.length - kept.split("\n").length);
	return { text: kept, hiddenLines, hiddenChars };
}

/** Appended to a budget warning once the file is also past, or near, the injection cap. */
export function overCap(lines: number, chars: number): string {
	const caps: string[] = [];
	if (lines > MAX_INJECTED_CORE_LINES) caps.push(`the ${MAX_INJECTED_CORE_LINES}-line injection cap`);
	if (chars > MAX_INJECTED_CORE_CHARS) caps.push(`the ${MAX_INJECTED_CORE_CHARS.toLocaleString()}-character injection cap`);
	else if (chars > MAX_CORE_FILE_BUDGET_CHARS) caps.push(`${(MAX_INJECTED_CORE_CHARS - chars).toLocaleString()} characters from the injection cap`);
	return caps.length === 0 ? "" : ` and ${caps.join(" plus ")}, so every prompt pays for it`;
}

/**
 * Cap an injected knowledge or history file by lines and by characters, whichever bites first,
 * and describe the cut in the unit that caused it. The caller appends the description to the
 * shown text, so "it was truncated" is visible to the model rather than a silent short read.
 */
export function capFile(text: string): { text: string; hiddenLines: number; hiddenChars: number; cut: string } {
	const all = text.split("\n");
	const byLines = all.length > MAX_INJECTED_FILE_LINES;
	const body0 = byLines ? all.slice(0, MAX_INJECTED_FILE_LINES).join("\n") : text;
	// A cut shorter than this is not worth a line of small print, and the small print is what
	// tells the model the file is longer — same rule as the pointer's minimum saving, found by
	// watching a real prompt pay 44 characters of note for 44 characters of cut.
	const byChars = body0.length - MAX_INJECTED_FILE_CHARS >= MIN_FILE_CUT_CHARS;
	const body = byChars ? body0.slice(0, body0.lastIndexOf("\n", MAX_INJECTED_FILE_CHARS) + 1 || MAX_INJECTED_FILE_CHARS) : body0;
	const hiddenLines = byLines ? all.length - MAX_INJECTED_FILE_LINES : 0;
	const hiddenChars = text.length - body.length;
	const parts: string[] = [];
	if (byLines) parts.push(`${hiddenLines} more lines`);
	if (byChars) parts.push(`${(hiddenChars - (byLines ? 0 : 0)).toLocaleString()} more characters`);
	return { text: body, hiddenLines, hiddenChars, cut: parts.join(" and ") };
}

export function capLines(text: string, maxLines: number): { text: string; hiddenLines: number } {
	const lines = text.split("\n");
	const hiddenLines = lines.length - maxLines;
	if (hiddenLines <= 0) return { text, hiddenLines: 0 };
	return { text: lines.slice(0, maxLines).join("\n"), hiddenLines };
}

/**
 * A core file's injected text and what it left out — by section, counted in characters
 * as well as lines, plus any section dropped whole. Never silently: the reader gets the
 * counts, which sections, and the way to read the whole file.
 */
export function injectCore(relPath: string, content: string): { text: string; hidden: Hidden } {
	const hidden: Hidden = { lines: 0, chars: 0, sections: [] };
	const out: string[] = [];
	let keptChars = 0;
	let keptLines = 0;

	const sections = splitSections(content);
	// Reserve space for actionable handoff sections before older material, while
	// retaining the original document order in the rendered block.
	const priority = relPath === "core/dailyContext.md"
		? ["Context for Tomorrow", "In Progress", "Key Decisions", "Completed", "Carried Forward"]
		: [];
	const order = sections.map((section, index) => ({ section, index })).sort((a, b) => {
		const rank = (name: string) => { const i = priority.indexOf(name); return i < 0 ? -1 : i; };
		return rank(a.section.name) - rank(b.section.name) || a.index - b.index;
	});
	const included = new Map<number, string>();
	for (const { section, index } of order) {
		const fit = capText(section.body, MAX_INJECTED_SECTION_LINES, MAX_INJECTED_SECTION_CHARS);
		hidden.lines += fit.hiddenLines;
		hidden.chars += fit.hiddenChars;
		const shown =
			fit.hiddenChars > 0 || fit.hiddenLines > 0
				? `${fit.text.trimEnd()}\n… ${fit.hiddenChars.toLocaleString()} characters (${fit.hiddenLines} lines) of ` +
					`"${section.name}" not shown — memory_read "${relPath}" for the whole file\n`
				: fit.text;

		// Past the file cap, whole sections go — each one is already self-limited, and a
		// section that fits is not worth breaking in half to keep.
		const lines = shown.split("\n").length - 1;
		if (keptChars + shown.length > MAX_INJECTED_CORE_CHARS || keptLines + lines > MAX_INJECTED_CORE_LINES) {
			hidden.sections.push(section.name);
			continue;
		}
		keptChars += shown.length;
		keptLines += lines;
		included.set(index, shown);
	}
	for (const [, shown] of [...included].sort((a, b) => a[0] - b[0])) out.push(shown);

	if (hidden.sections.length > 0) {
		const named = hidden.sections.map((s) => `"${s}"`).join(", ");
		out.push(
			`\n… ${hidden.sections.length} more section${hidden.sections.length === 1 ? "" : "s"} not shown (${named}) — ` +
			`${MAX_INJECTED_CORE_CHARS.toLocaleString()}-character injection cap; memory_read "${relPath}" for the whole file\n`,
		);
	}
	return { text: out.join(""), hidden };
}
