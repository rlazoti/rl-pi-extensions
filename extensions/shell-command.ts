/**
 * Shared shell-command parsing for anything that has to read a bash command
 * without running it.
 *
 * Two primitives, both quote-aware and both deliberately incomplete as a shell:
 * `splitShellCommand` splits a command at unquoted `&&`, `||`, `|`, `;` and
 * newline, and `containsUnquoted` matches a regex only where bash would see it.
 * Between them they answer "does this command run X", which is what
 * `co-authored-by-ai` patches on.
 *
 * Both walk the command with one scanner (`scanShellCommand`), so they cannot
 * disagree about what is quoted, where a command ends, or where a
 * here-document body starts and stops.
 *
 * Here-documents: the body of `cmd <<TAG … TAG` (also `<<-TAG`, `<<'TAG'`,
 * `<<"TAG"`, `<<\TAG`) is data that `cmd` reads on stdin. Bash does no quote
 * processing in it when the tag is quoted, and none that changes where
 * commands start when it is not. So the body is opaque here: it is never a
 * segment, and nothing in it counts as unquoted. Before this, a Python script
 * fed through `python3 - <<'EOF'` was read as shell. One `\'` inside a
 * single-quoted Python string flipped the quote tracking, and a later
 * `git commit` inside a Python string got `--trailer` pasted into the script
 * (Nov 25 2026). The one exception is a body that a shell runs as commands
 * (`bash <<EOF`, `sh -s <<'EOF'`, `cat <<EOF | bash`): there the lines ARE
 * commands, so the body is scanned like the rest of the command.
 *
 * What they still do not do, and no fix here should pretend otherwise:
 * `$( … )`, backticks, subshells and `xargs` are opaque text, and a backslash
 * outside quotes is not treated as an escape. A `;` inside `$( … )` splits a
 * segment here that bash keeps together. That is harmless for a yes/no
 * question and not harmless for deciding which token of a command is which,
 * so anything extracting operands brings its own tokenizer (scan-guard does).
 */

/** Shells whose here-document body is commands, not data. */
const SHELL_NAME = String.raw`(?:\S*\/)?(?:bash|sh|zsh|dash|ksh)`;

/**
 * The command words before `<<` name a shell that reads commands from stdin:
 * optional `VAR=value` assignments, the shell, then only flags (`-s`, `-e`,
 * `-x`). A `-c` script or a script-file operand means stdin is data again.
 */
const SHELL_OWNER_RE = new RegExp(String.raw`^\s*(?:\w+=\S*\s+)*${SHELL_NAME}(?:\s+-(?!c\b)[A-Za-z]+)*\s*\d?$`);

/** The rest of the line pipes into a shell: `cat <<EOF | bash`. */
const PIPED_TO_SHELL_RE = new RegExp(String.raw`(?:^|[^|])\|\s*(?:\w+=\S*\s+)*${SHELL_NAME}(?:\s+-(?!c\b)[A-Za-z]+)*\s*(?:$|[;&|\n])`);

interface PendingHeredoc {
	tag: string;
	stripTabs: boolean;
	feedsShell: boolean;
}

export interface ShellScan {
	/** [start, end) of each separator, whitespace and opaque here-document bodies included. */
	separators: Array<[number, number]>;
	/** [start, end) of each region bash would not read as code: quoted text and opaque here-document bodies. */
	quotedRanges: Array<[number, number]>;
}

/**
 * Walk `cmd` once and report its separators and its non-code regions.
 *
 * Separators: `&&`, `||`, `|`, `;` and newline, each widened over the
 * whitespace around it (matching the original `\s*(op)\s*` regex). An opaque
 * here-document body, with its terminator line, is folded into the newline
 * separator that precedes it, so it lands between two segments and is never
 * read as one.
 */
export function scanShellCommand(cmd: string): ShellScan {
	const separators: Array<[number, number]> = [];
	const quotedRanges: Array<[number, number]> = [];
	const isWs = (c: string | undefined) => c !== undefined && /\s/.test(c);

	let quote: '"' | "'" | null = null;
	let quoteStart = -1;
	let segStart = 0;
	let pending: PendingHeredoc[] = [];

	/**
	 * Called at an unquoted newline while here-documents are pending. For
	 * opaque bodies, records them and returns the index just past the last
	 * terminator line (the newline that ends it, or the end of the command).
	 * For bodies a shell runs, records nothing and returns `opaque: false`, so
	 * scanning resumes at the first body line.
	 */
	const consumeBodies = (nl: number): { end: number; opaque: boolean } => {
		const heredocs = pending;
		pending = [];
		if (heredocs.some((h) => h.feedsShell)) return { end: nl + 1, opaque: false };
		let pos = nl + 1;
		for (const h of heredocs) {
			const bodyStart = pos;
			let end = cmd.length;
			while (pos <= cmd.length) {
				const lineEnd = cmd.indexOf("\n", pos);
				const stop = lineEnd < 0 ? cmd.length : lineEnd;
				const line = cmd.slice(pos, stop);
				if ((h.stripTabs ? line.replace(/^\t+/, "") : line) === h.tag) {
					end = stop;
					pos = stop + 1;
					break;
				}
				if (lineEnd < 0) {
					// Unterminated: bash reads to end of input, and so do we.
					end = cmd.length;
					pos = cmd.length + 1;
					break;
				}
				pos = lineEnd + 1;
			}
			if (end > bodyStart) quotedRanges.push([bodyStart, end]);
			if (pos > cmd.length) return { end: cmd.length, opaque: true };
		}
		return { end: pos - 1, opaque: true };
	};

	/** Widen a separator forward over whitespace, consuming any here-document body it crosses. */
	const extendForward = (from: number): number => {
		let j = from;
		while (j < cmd.length && isWs(cmd[j])) {
			if (cmd[j] === "\n" && pending.length > 0) {
				const { end, opaque } = consumeBodies(j);
				j = end;
				if (!opaque) break; // shell-fed: the body is commands, stop widening here
				continue;
			}
			j++;
		}
		return j;
	};

	/**
	 * Parse a here-document operator at `i` (`cmd[i..i+1] === "<<"`). Returns
	 * the index after the tag word, or -1 when this is not a here-document.
	 */
	const parseHeredoc = (i: number): number => {
		if (cmd[i + 2] === "<") return -1; // here-string `<<<`
		if (i > 0 && cmd[i - 1] === "<") return -1;
		const prefix = cmd.slice(segStart, i);
		// `$((1<<2))` and `((x<<=1))` are arithmetic shifts, not here-documents.
		if ((prefix.match(/\(\(/g)?.length ?? 0) > (prefix.match(/\)\)/g)?.length ?? 0)) return -1;

		let j = i + 2;
		const stripTabs = cmd[j] === "-";
		if (stripTabs) j++;
		while (cmd[j] === " " || cmd[j] === "\t") j++;

		let tag = "";
		while (j < cmd.length && !/[\s;&|<>()]/.test(cmd[j])) {
			const c = cmd[j];
			if (c === "'" || c === '"') {
				const close = cmd.indexOf(c, j + 1);
				if (close < 0) return -1;
				tag += cmd.slice(j + 1, close);
				j = close + 1;
			} else if (c === "\\" && j + 1 < cmd.length) {
				tag += cmd[j + 1];
				j += 2;
			} else {
				tag += c;
				j++;
			}
		}
		if (tag === "") return -1;

		const lineEnd = cmd.indexOf("\n", j);
		const restOfLine = cmd.slice(j, lineEnd < 0 ? cmd.length : lineEnd);
		const feedsShell = SHELL_OWNER_RE.test(prefix) || PIPED_TO_SHELL_RE.test(restOfLine);
		pending.push({ tag, stripTabs, feedsShell });
		return j;
	};

	let i = 0;
	while (i < cmd.length) {
		const ch = cmd[i];

		if (quote) {
			// Inside double quotes, a backslash escapes the next char (bash rules).
			// Inside single quotes, backslashes are literal.
			if (quote === '"' && ch === "\\" && i + 1 < cmd.length) {
				i += 2;
				continue;
			}
			if (ch === quote) {
				quotedRanges.push([quoteStart, i + 1]);
				quote = null;
				quoteStart = -1;
			}
			i++;
			continue;
		}

		if (ch === '"' || ch === "'") {
			quote = ch;
			quoteStart = i;
			i++;
			continue;
		}

		if (ch === "<" && cmd[i + 1] === "<") {
			const after = parseHeredoc(i);
			if (after > 0) {
				i = after;
				continue;
			}
			i += cmd[i + 2] === "<" ? 3 : 2;
			continue;
		}

		// Detect a separator operator at position i. `||` is checked before `|`
		// so a logical-or is never mistaken for two pipes.
		let opLen = 0;
		if ((ch === "&" && cmd[i + 1] === "&") || (ch === "|" && cmd[i + 1] === "|")) {
			opLen = 2;
		} else if (ch === ";" || ch === "\n" || ch === "|") {
			opLen = 1;
		}

		if (opLen > 0) {
			let sepStart = i;
			while (sepStart > segStart && isWs(cmd[sepStart - 1])) sepStart--;
			let sepEnd: number;
			if (ch === "\n" && pending.length > 0) {
				const { end, opaque } = consumeBodies(i);
				sepEnd = opaque ? extendForward(end) : end;
			} else {
				sepEnd = extendForward(i + opLen);
			}
			separators.push([sepStart, sepEnd]);
			segStart = sepEnd;
			i = sepEnd;
			continue;
		}

		i++;
	}

	// Unterminated quote — treat everything from the opening quote onward as
	// quoted (bash would error, but we shouldn't act on a malformed command).
	if (quote && quoteStart >= 0) quotedRanges.push([quoteStart, cmd.length]);

	return { separators, quotedRanges };
}

/**
 * Split a command string into alternating [segment, separator, segment, ...]
 * pieces, aware of shell quotes so that operators inside `"..."` or `'...'`
 * are not treated as command separators, and aware of here-documents so that
 * the lines of a body fed to a program are not treated as commands.
 *
 * Recognised separators: `&&`, `||`, `|`, `;`, and newline. Backslash escapes
 * inside double quotes are honoured (to match bash).
 *
 * Each separator captures surrounding whitespace (matching `\s*(op)\s*`),
 * so `parts.join("")` always reconstructs the original `cmd`, and the
 * first/last elements are always the surrounding segments (possibly empty).
 * An opaque here-document body sits inside the separator after the line that
 * opened it.
 */
export function splitShellCommand(cmd: string): string[] {
	const parts: string[] = [];
	let segStart = 0;
	for (const [start, end] of scanShellCommand(cmd).separators) {
		parts.push(cmd.slice(segStart, start));
		parts.push(cmd.slice(start, end));
		segStart = end;
	}
	parts.push(cmd.slice(segStart));
	return parts;
}

/**
 * Test whether `re` has at least one match in `text` that lies entirely
 * outside any quoted region or opaque here-document body. Uses the same
 * scanner as `splitShellCommand`.
 *
 * This is what keeps `node -e 'git commit …'`, `echo "git commit"` and a
 * script fed through `python3 - <<'EOF'` from being treated as commits: the
 * match has to be a token bash would run.
 */
export function containsUnquoted(text: string, re: RegExp): boolean {
	const { quotedRanges } = scanShellCommand(text);

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
