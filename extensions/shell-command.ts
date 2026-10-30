/**
 * Shared shell-command parsing for anything that has to read a bash command
 * without running it.
 *
 * Two primitives, both quote-aware and both deliberately incomplete as a shell:
 * `splitShellCommand` splits a command at unquoted `&&`, `||`, `|`, `;` and
 * newline, and `containsUnquoted` matches a regex only where bash would see it.
 * Between them they answer "does this command run X", which is what
 * `co-authored-by-ai` patches on and what `scan-guard` refuses on.
 *
 * What they do not do, and no fix here should pretend otherwise: `$( … )`,
 * backticks, subshells, here-documents and `xargs` are opaque text. A `;`
 * inside `$( … )` splits a segment here that bash keeps together. That is
 * harmless for a yes/no question and not harmless for deciding which token of a
 * command is which, so anything extracting operands — scan-guard's root
 * extraction — brings its own tokenizer.
 *
 * Moved out of `co-authored-by-ai/implementation.ts` unchanged when
 * `scan-guard` needed the same primitives. They were exported and tested there
 * already, and a fork of a parser is two parsers that drift.
 */

/**
 * Split a command string into alternating [segment, separator, segment, ...]
 * pieces, aware of shell quotes so that operators inside `"..."` or `'...'`
 * are not treated as command separators.
 *
 * Recognised separators: `&&`, `||`, `|`, `;`, and newline. Backslash escapes
 * inside double quotes are honoured (to match bash). Note `||` is detected
 * before `|` so a logical-or is never mistaken for two pipes.
 *
 * Each separator captures surrounding whitespace (matching `\s*(op)\s*`),
 * so `parts.join("")` always reconstructs the original `cmd`, and the
 * first/last elements are always the surrounding segments (possibly empty).
 */
export function splitShellCommand(cmd: string): string[] {
	const parts: string[] = [];
	let segStart = 0;
	let i = 0;
	let quote: '"' | "'" | null = null;

	// Match the original regex's \s* (includes spaces, tabs, newlines).
	const isWs = (c: string | undefined) => c !== undefined && /\s/.test(c);

	while (i < cmd.length) {
		const ch = cmd[i];

		if (quote) {
			// Inside double quotes, a backslash escapes the next char (bash rules).
			// Inside single quotes, backslashes are literal.
			if (quote === '"' && ch === "\\" && i + 1 < cmd.length) {
				i += 2;
				continue;
			}
			if (ch === quote) quote = null;
			i++;
			continue;
		}

		if (ch === '"' || ch === "'") {
			quote = ch;
			i++;
			continue;
		}

		// Detect a separator operator at position i.
		let opLen = 0;
		if ((ch === "&" && cmd[i + 1] === "&") || (ch === "|" && cmd[i + 1] === "|")) {
			opLen = 2;
		} else if (ch === ";" || ch === "\n" || ch === "|") {
			opLen = 1;
		}

		if (opLen > 0) {
			// Extend the separator to include surrounding whitespace so that
			// `parts.join("")` reconstructs `cmd` and segments carry no leading or
			// trailing whitespace around the operator (matching the original
			// `\s*(op)\s*` regex semantics).
			let sepStart = i;
			while (sepStart > segStart && isWs(cmd[sepStart - 1])) sepStart--;
			let sepEnd = i + opLen;
			while (sepEnd < cmd.length && isWs(cmd[sepEnd])) sepEnd++;

			parts.push(cmd.slice(segStart, sepStart));
			parts.push(cmd.slice(sepStart, sepEnd));
			segStart = sepEnd;
			i = sepEnd;
			continue;
		}

		i++;
	}

	parts.push(cmd.slice(segStart));
	return parts;
}

/**
 * Test whether `re` has at least one match in `text` that lies entirely
 * outside any quoted region. Uses the same quote semantics as
 * `splitShellCommand` (double- and single-quotes, `\\x` escape inside `"`).
 *
 * This is what keeps `node -e 'git commit …'` and `echo "git commit"` from
 * being treated as commits: the match has to be a token bash would run.
 */
export function containsUnquoted(text: string, re: RegExp): boolean {
	// Walk once, tracking quote state, and collect the [start, end) ranges of
	// quoted regions. Then check whether the regex matches in the remaining
	// (unquoted) text.
	const quotedRanges: Array<[number, number]> = [];
	let quote: '"' | "'" | null = null;
	let quoteStart = -1;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (quote === '"' && ch === "\\" && i + 1 < text.length) {
				i++;
				continue;
			}
			if (ch === quote) {
				quotedRanges.push([quoteStart, i + 1]);
				quote = null;
				quoteStart = -1;
			}
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			quoteStart = i;
		}
	}
	// Unterminated quote — treat everything from the opening quote onward as
	// quoted (bash would error, but we shouldn't inject into a malformed
	// command).
	if (quote && quoteStart >= 0) quotedRanges.push([quoteStart, text.length]);

	// Try successive matches; accept the first one that's entirely unquoted.
	const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
	for (let m = globalRe.exec(text); m !== null; m = globalRe.exec(text)) {
		const start = m.index;
		const end = start + m[0].length;
		const overlapsQuoted = quotedRanges.some(([qs, qe]) => start < qe && end > qs);
		if (!overlapsQuoted) return true;
		// Guard against zero-length matches hanging the loop.
		if (m[0].length === 0) globalRe.lastIndex++;
	}
	return false;
}
