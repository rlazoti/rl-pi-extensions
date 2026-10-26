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
 *
 * The flag also weakens a check git offers for free, which the two hooks here
 * exist to put back. `--trailer` *is* message content, so an empty message no
 * longer fails: measured on git 2.56.0, `-m ""`, `-m "   "`, `-m "$UNSET"` and
 * `-F -` with empty stdin all commit successfully with the trailer as the
 * entire message, where unpatched each one exits 1 with "Aborting commit due to
 * empty commit message". So:
 *
 *  - `hasOnlyEmptyMessageLiteral` refuses to patch a commit whose only message
 *    is a blank literal, leaving git's own failure intact and loud.
 *  - For the emptiness no tool call can see (`-m "$VAR"`, stdin), a
 *    `tool_result` hook reads HEAD back for the commits *this* hook patched and,
 *    when the message is nothing but our trailer, tells the agent in the result
 *    it is about to read and the human by notification.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const GIT_COMMIT_RE = /\bgit\s+commit\b/;

const FALLBACK_TRAILER = "Co-authored-by: AI (Pi) <noreply@pi.dev>";

/**
 * A `-m`/`--message` whose value is a quoted literal, attached (`-m"…"`) or
 * spaced (`-m "…"`). Only matches a leading `-m`, never a `-am` cluster, so an
 * unparseable cluster is treated as unknown rather than as an empty message.
 */
const MESSAGE_LITERAL_RE = /(?:^|\s)(?:-m|--message)\s*("(?:[^"\\]|\\.)*"|'[^']*')/g;

/** Flags that supply a message beside `-m`, so an empty `-m` is not the whole story. */
const OTHER_MESSAGE_SOURCE_RE = /(?:^|\s)(?:-F|--file|-C|-c|--reuse-message|--reedit-message|--fixup|--squash|--template)(?:\s|=|$)/;

/** Matches any trailer this extension could have written, whatever model it named. */
const OUR_TRAILER_RE = /^\s*co-authored-by:\s*ai\s*\(pi(?:\/[^)]*)?\)\s*<noreply@pi\.dev>\s*$/i;

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
	/**
	 * Commits this extension patched, keyed by tool call id. The after-the-fact
	 * check only ever looks at HEAD for one of these, and a result for any other
	 * call is ignored — that is what keeps it from warning about a commit some
	 * other command made.
	 */
	const patched = new Map<string, { cwd: string; headBefore: string | null }>();

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		if (!isToolCallEventType("bash", event)) return;

		const cmd = event.input.command;
		if (!cmd) return;
		if (hasCoAuthoredBy(cmd)) return;
		if (!containsUnquoted(cmd, GIT_COMMIT_RE)) return;

		// Refusing here is the cheap half of the fix. `--trailer` makes an empty
		// message commit (see `hasOnlyEmptyMessageLiteral`), so patching such a
		// command would trade git's loud "empty commit message" failure for a
		// quiet commit whose entire message is attribution. Left unpatched, git
		// rejects it exactly as it would have without this extension.
		if (hasOnlyEmptyMessageLiteral(cmd)) {
			ctx.ui.notify(
				"co-authored-by-ai: left this git commit unpatched — its -m message is empty, and --trailer would have made git accept an empty message",
				"warning",
			);
			return;
		}

		const trailer = buildTrailer(ctx.model ? { name: ctx.model.name, provider: ctx.model.provider } : undefined);
		const patchedCmd = injectGitTrailer(cmd, trailer);
		if (patchedCmd === cmd) return; // matched the regex but no segment was patchable

		event.input.command = patchedCmd;

		// Remember HEAD as it stands now, so the after-the-fact check reads the
		// message of the commit this command made and not some older one.
		let headBefore: string | null = null;
		try {
			const head = await pi.exec("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: ctx.cwd, timeout: 2_000 });
			if (head.code === 0 && head.stdout.trim()) headBefore = head.stdout.trim();
		} catch {
			headBefore = null; // no exec, no baseline: the check degrades to "is this trailer-only commit new?"
		}

		// Aborted calls never reach tool_result; keep the map from growing forever.
		if (patched.size >= 32) patched.delete(patched.keys().next().value as string);
		patched.set(event.toolCallId, { cwd: ctx.cwd, headBefore });
	});

	pi.on("tool_result", async (event, ctx: ExtensionContext) => {
		const mine = patched.get(event.toolCallId);
		if (!mine) return; // not a commit this extension patched
		patched.delete(event.toolCallId);
		if (event.isError) return; // git refused the command: nothing was committed

		const EMPTY_MESSAGE_WARNING =
			"co-authored-by-ai: this commit's message is nothing but the Co-authored-by trailer. " +
			"The command supplied an empty message, which git would have rejected — it accepted it because this extension adds --trailer. " +
			'Repair with: git commit --amend -m "<subject>"';

		let out;
		try {
			out = await pi.exec("git", ["log", "-1", "--format=%H%n%B"], { cwd: mine.cwd, timeout: 2_000 });
		} catch {
			return; // no git, no answer: say nothing rather than warn on a guess
		}
		if (out.code !== 0) return;

		const newline = out.stdout.indexOf("\n");
		if (newline < 0) return;
		const headNow = out.stdout.slice(0, newline).trim();
		const body = out.stdout.slice(newline + 1);
		if (mine.headBefore !== null && headNow === mine.headBefore) return; // no new commit happened
		if (!messageIsOnlyTrailer(body)) return;

		// Both audiences: the human sees the notification, and the agent that
		// made the commit reads the warning in the very result it is about to act on.
		ctx.ui.notify(EMPTY_MESSAGE_WARNING, "error");
		return {
			content: [...event.content, { type: "text" as const, text: EMPTY_MESSAGE_WARNING }],
			structuredContent: event.structuredContent,
		};
	});
}

/**
 * True when the command supplies a message only through `-m`/`--message` and
 * every one of those literals is blank — `-m ""`, `-m ''`, `-m "   "`.
 *
 * This exists because `git commit --trailer` turns an empty message into a
 * commit whose whole message is the trailer, killing the "Aborting commit due
 * to empty commit message" exit 1 that git otherwise raises. Measured on git
 * 2.56.0, all four empty-message shapes are affected: `-m ""`, `-m "   "`,
 * `-m "$UNSET"`, and `-F -` with empty stdin. The statically visible ones are
 * caught here; the dynamic two cannot be seen from a tool call and are caught
 * afterwards instead.
 *
 * Returns false — "unknown", do not refuse — when there is no literal to read
 * (`-F -`, `-F file`, `--amend --no-edit`, an editor, `-m "$VAR"`, `-m $'…'`)
 * or when another message source is present alongside an empty literal.
 */
export function hasOnlyEmptyMessageLiteral(cmd: string): boolean {
	for (const segment of segmentList(cmd)) {
		const matched = GIT_COMMIT_RE.exec(segment);
		if (!matched) continue;
		// Only what follows `git commit` counts: `-c` before it is a config option
		// (`git -c user.name=x commit`), after it means "reedit this commit's
		// message", which is a message source like -F.
		const after = segment.slice(matched.index + matched[0].length);
		if (OTHER_MESSAGE_SOURCE_RE.test(after)) return false;
		const literals = [...after.matchAll(MESSAGE_LITERAL_RE)];
		if (literals.length > 0 && literals.every((m) => (m[1] ?? "").slice(1, -1).trim() === "")) return true;
	}
	return false;
}

/**
 * The command's segments that bash would run — the even indices of the
 * quote-aware `splitShellCommand` array, which puts separators between them.
 */
function segmentList(cmd: string): string[] {
	return splitShellCommand(cmd).filter((_, index) => index % 2 === 0);
}

/**
 * True when a commit message carries no content beyond this extension's own
 * trailer — the shape that means the author's message was empty.
 */
export function messageIsOnlyTrailer(message: string): boolean {
	return message
		.split(/\n/)
		.every((line) => line.trim() === "" || OUR_TRAILER_RE.test(line));
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
