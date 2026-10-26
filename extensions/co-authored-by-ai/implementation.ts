/**
 * co-authored-by-ai — attribute commits Pi creates.
 *
 * Patches a `git commit` bash command before it executes, appending
 * `--trailer "Co-authored-by: AI (Pi/<model>) <noreply@pi.dev>"`. Nothing else
 * is touched: the hook only ever sees tool calls the agent issues, so a human
 * commit made in another terminal can never be reached from here, and a
 * command that already carries a `Co-authored-by:` trailer is left alone.
 *
 * Ported from a standalone extension (~/.pi/agent/_extensions/co-authored-by-ai)
 * with two changes, both decided when it landed here:
 *
 *  - **Graphite (`gt`) support is dropped.** `gt` is not installed on this
 *    machine, and it was the only path that rewrote a commit *message* —
 *    string surgery on a quoted `-m` argument, which is precisely how a
 *    message containing `$&` gets mangled by `String.replace` and how a
 *    `-am` cluster silently loses the trailer. With git alone the injection
 *    is "append a flag" and git itself parses the trailer.
 *  - **`git commit --amend --no-edit` is no longer skipped.** Upstream skipped
 *    it as "no message to attach to"; there is one — the reused message — and
 *    `git commit --amend --no-edit --trailer "<same trailer>"` is idempotent:
 *    measured on git 2.56.0, three amends of one commit leave exactly one
 *    trailer (interpret-trailer's default is `addIfDifferent`). Skipping it
 *    instead dropped attribution from the common commit-then-amend flow.
 *    Pinned by the real-git tests at the bottom of `implementation.test.ts`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const GIT_COMMIT_RE = /\bgit\s+commit\b/;

const FALLBACK_TRAILER = "Co-authored-by: AI (Pi) <noreply@pi.dev>";

/**
 * Build a Co-authored-by trailer.
 *
 * With model:     `Co-authored-by: AI (Pi/Claude Sonnet 4) <noreply@pi.dev>`
 * Without model:  `Co-authored-by: AI (Pi) <noreply@pi.dev>`
 *
 * The `Co-authored-by: AI` prefix is the stable part: it is what tooling greps
 * for in git history. The parenthetical carries the tool+model detail.
 */
export function buildTrailer(model?: { name: string; provider: string }): string {
	if (!model) return FALLBACK_TRAILER;
	return `Co-authored-by: AI (Pi/${model.name}) <noreply@pi.dev>`;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx: ExtensionContext) => {
		if (!isToolCallEventType("bash", event)) return;

		const cmd = event.input.command;
		if (!cmd) return;
		if (hasCoAuthoredBy(cmd)) return;
		if (!containsUnquoted(cmd, GIT_COMMIT_RE)) return;

		const trailer = buildTrailer(ctx.model ? { name: ctx.model.name, provider: ctx.model.provider } : undefined);
		event.input.command = injectGitTrailer(cmd, trailer);
	});
}

/**
 * Check if the command already contains a Co-authored-by trailer (case-insensitive).
 */
export function hasCoAuthoredBy(cmd: string): boolean {
	return /co-authored-by:/i.test(cmd);
}

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

/**
 * Inject the `--trailer` flag into a git commit command.
 *
 * Uses `splitShellCommand` so that operators inside quoted messages (e.g.
 * `git commit -m "fix; thing"`) don't get mistaken for command separators,
 * and so that newline-separated commands (e.g. a `git commit` followed by
 * a cleanup `rm` on the next line) are treated as separate commands.
 *
 * The first matching segment is the one that gets the trailer — a commit
 * happens once per command, and appending it to a later segment would put
 * `--trailer` on whatever cleanup ran after it (`rm: --trailer: No such file
 * or directory`).
 */
export function injectGitTrailer(cmd: string, trailer: string): string {
	const parts = splitShellCommand(cmd);

	for (let i = 0; i < parts.length; i += 2) {
		if (containsUnquoted(parts[i], GIT_COMMIT_RE)) {
			parts[i] = parts[i].trimEnd() + ` --trailer "${trailer}"`;
			return parts.join("");
		}
	}

	return parts.join("");
}
