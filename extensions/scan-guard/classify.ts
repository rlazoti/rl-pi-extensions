/**
 * scan-guard: what a bash command walks, and what to say instead.
 *
 * A pure function. It reads no files, spawns no processes, and imports no Pi
 * types, so the whole corpus of real commands from `~/.pi/agent/sessions` runs
 * through it in a test without a filesystem to be wrong about. `hasFd`, the
 * session cwd and the home directory come in as arguments; the caller that
 * knows those things is `implementation.ts`.
 *
 * ## The rule
 *
 * A `find`/`fd` is refused when its root is broad — the volume or the whole
 * home directory — and its depth is unbounded (or larger than `MAX_CHEAP_DEPTH`,
 * or not a literal the guard can read). Broad root *and* bounded depth is
 * `warn`: allowed to run, with a notice, because depth bounds cost well
 * (`find ~ -maxdepth 4` is 1.1 s warm) and yet the single most expensive call in
 * this machine's session logs was `find ~ -maxdepth 4` at 5,550 s. Silence would
 * be a claim that measurement cannot support.
 *
 * ## Fail open, everywhere
 *
 * A `tool_call` handler that throws blocks the tool as a fail-safe (Pi 1.4.0
 * docs/extensions.md:375), so a parser that raised on one malformed command
 * would freeze every `bash` call in the session. Every path that is not sure
 * returns `allow` — unbalanced quotes, unbalanced parens, a here-document with
 * no terminator, a root that is really `$( … )`, an empty string, 20 KB of
 * emoji. Being unsure is allowed to cost a missed scan; it is not allowed to
 * cost a shell.
 *
 * ## What walks through untouched (documented escapes, tested as limits)
 *
 * `bash -c "find /"`, a script file, `xargs find`, `python -c 'os.walk(…)'`,
 * backticks, and any root that is a glob (`~/*`) or a variable (`"$DIR"`). The
 * detector reads a command line, not a process tree; it aims at a habit visible
 * in 13k recorded commands, not at an adversary.
 */

/** Deep enough to be the recorded shape of a hunt, shallow enough to be seconds. */
export const MAX_CHEAP_DEPTH = 4;

/** Roots that are not a directory but a whole machine, or the whole of a life. */
const BROAD_ROOTS = ["/", "/Users", "/Volumes", "/System", "/Library", "/private", "/net", "/usr", "/opt", "/var", "/etc"];

export interface ScanEnv {
	/** The session's working directory, absolute. `.` in a command means this. */
	cwd: string;
	/** Home directory, absolute, without a trailing slash. `~` means this. */
	home: string;
	/** Whether `fd` exists, so a suggestion can name a binary that is installed. */
	hasFd: boolean;
	/**
	 * The roots a scoped search should name, in the order they should be tried.
	 * Expected to already exclude anything broad. Absolute, or using `~`.
	 */
	scopedRoots: string[];
}

export interface ScanFinding {
	tool: "find" | "fd";
	/** The command as written, for the message. */
	written: string;
	/** The root operand as written, e.g. `~` or `/`. */
	root: string;
	/** That root, expanded and normalised. */
	rootPath: string;
	/** `-maxdepth`/`-d` as a literal, or null when unbounded or unreadable. */
	depth: number | null;
	/** A destructive flag: `-delete`, `fd --delete`, `-exec`. */
	destructive: boolean;
}

export type Verdict =
	| { action: "allow" }
	| { action: "warn"; finding: ScanFinding; suggestion: string; reason: string }
	| { action: "block"; finding: ScanFinding; suggestion: string; reason: string };

// ---------------------------------------------------------------------------
// Segmenting a command line
// ---------------------------------------------------------------------------

/**
 * Split a command line into the things bash would run as commands.
 *
 * Beyond quote-awareness this understands three things `splitShellCommand`
 * deliberately does not, because root extraction cannot afford to be wrong about
 * them:
 *
 *  - **`$( … )` and `( … )` nest.** `for d in $(find ~ -maxdepth 4 …)` is where
 *    the worst recorded call hid; `(` and `$(` open a new command, `)` closes it.
 *  - **`#` starts a comment** to end of line. Without this, a python here-document
 *    mentioning the word `find` is a `find` command with garbage operands.
 *  - **A here-document body is data.** `python3 - <<'PY' … find … PY` runs python;
 *    the body never reaches the parser.
 *
 * Returns `ok: false` when the text cannot be trusted (unbalanced anything), and
 * callers must then allow.
 */
export function commandSegments(cmd: string): { ok: boolean; segments: string[] } {
	const segments: string[] = [];
	let cur = "";
	let i = 0;
	let depth = 0; // nesting depth of ( … ) and $( … )

	const flush = () => {
		if (cur.trim()) segments.push(cur.trim());
		cur = "";
	};

	while (i < cmd.length) {
		const ch = cmd[i];

		// Quoted region: kept verbatim inside the current token, never scanned.
		if (ch === '"' || ch === "'") {
			const quote = ch;
			cur += ch;
			i++;
			for (; i < cmd.length; i++) {
				if (quote === '"' && cmd[i] === "\\" && i + 1 < cmd.length) {
					cur += cmd[i] + cmd[i + 1];
					i++;
					continue;
				}
				cur += cmd[i];
				if (cmd[i] === quote) {
					i++;
					break;
				}
			}
			// Loop ended on the closing quote only if we consumed one.
			if (cur.endsWith(quote) || i >= cmd.length) {
				if (i >= cmd.length && !cur.endsWith(quote)) return { ok: false, segments: [] };
			}
			continue;
		}

		// Backslash escape: two characters, whatever they are.
		if (ch === "\\" && i + 1 < cmd.length) {
			cur += cmd[i] + cmd[i + 1];
			i += 2;
			continue;
		}

		// Backticks: opaque. A scan inside them is a documented escape.
		if (ch === "`") {
			const end = cmd.indexOf("`", i + 1);
			if (end < 0) return { ok: false, segments: [] };
			cur += cmd.slice(i, end + 1);
			i = end + 1;
			continue;
		}

		// Comment: to end of line, when it starts a word.
		if (ch === "#" && /(^|[\s;&|(<])$/.test(cmd.slice(0, i).slice(-2))) {
			const nl = cmd.indexOf("\n", i);
			i = nl < 0 ? cmd.length : nl; // the newline itself splits below
			continue;
		}

		// Here-document: skip its body, which is data, not commands.
		if (ch === "<" && cmd[i + 1] === "<") {
			let j = i + 2;
			if (cmd[j] === "-") j++;
			while (j < cmd.length && /\s/.test(cmd[j])) j++;
			let delim = "";
			if (cmd[j] === '"' || cmd[j] === "'") {
				const q = cmd[j];
				const end = cmd.indexOf(q, j + 1);
				if (end < 0) return { ok: false, segments: [] };
				delim = cmd.slice(j + 1, end);
				j = end + 1;
			} else {
				while (j < cmd.length && /[^\s;|&)<]/.test(cmd[j])) delim += cmd[j++];
			}
			if (!delim) return { ok: false, segments: [] };
			cur += cmd.slice(i, j);
			const lineEnd = cmd.indexOf("\n", j);
			if (lineEnd < 0) {
				i = cmd.length; // `<<EOF` with nothing after it: nothing to skip
				continue;
			}
			i = lineEnd + 1;
			// Skip lines until the terminator. `<<-` lets it carry leading tabs.
			for (;;) {
				const next = cmd.indexOf("\n", i);
				const line = next < 0 ? cmd.slice(i) : cmd.slice(i, next);
				if (line.trim() === delim) {
					i = next < 0 ? cmd.length : next + 1;
					break;
				}
				if (next < 0) return { ok: false, segments: [] }; // unterminated here-doc
				i = next + 1;
			}
			continue;
		}

		// Subshell / command substitution open and close a command.
		if (ch === "$" && cmd[i + 1] === "(") {
			flush();
			depth++;
			i += 2;
			continue;
		}
		if (ch === "(") {
			flush();
			depth++;
			i++;
			continue;
		}
		if (ch === ")" && depth > 0) {
			flush();
			depth--;
			i++;
			continue;
		}

		// Command separators.
		const two = cmd.slice(i, i + 2);
		if (two === "&&" || two === "||" || two === "||") {
			flush();
			i += 2;
			continue;
		}
		if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
			flush();
			i++;
			continue;
		}

		cur += ch;
		i++;
	}

	if (depth !== 0) return { ok: false, segments: [] };
	flush();
	return { ok: true, segments };
}

/** One word of a command, with the quote that covered its first character. */
export interface Word {
	text: string;
	/**
	 * The quote covering the word's first character, if any. Bash expands `~` and
	 * `$HOME` only at the start of an unquoted word — `'~'` is a directory called
	 * tilde and `"$HOME"` is home — so this one bit decides whether `find "~"` is a
	 * scan of the home directory or a mistake about one.
	 */
	quote: "'" | '"' | null;
}

/** Split one command into words, dropping the quotes but remembering their kind. */
export function words(command: string): { ok: boolean; words: Word[] } {
	const out: Word[] = [];
	let cur = "";
	let quote: "'" | '"' | null = null;
	let sawWord = false;
	let i = 0;
	const push = () => {
		if (sawWord) out.push({ text: cur, quote });
		cur = "";
		quote = null;
		sawWord = false;
	};
	while (i < command.length) {
		const ch = command[i];
		if (ch === "'" || ch === '"') {
			if (sawWord) quote = quote ?? null; // a quote in the middle cannot start an expansion
			else quote = ch;
			sawWord = true;
			i++;
			let closed = false;
			for (; i < command.length; i++) {
				if (ch === '"' && command[i] === "\\" && i + 1 < command.length) {
					cur += command[i + 1];
					i++;
					continue;
				}
				if (command[i] === ch) {
					i++;
					closed = true;
					break;
				}
				cur += command[i];
			}
			// An unterminated quote is a command bash refuses to run; nothing here is
			// worth guessing about it.
			if (!closed) return { ok: false, words: [] };
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			cur += command[i + 1];
			sawWord = true;
			i += 2;
			continue;
		}
		if (/\s/.test(ch)) {
			push();
			i++;
			continue;
		}
		cur += ch;
		sawWord = true;
		i++;
	}
	push();
	return { ok: true, words: out };
}

// ---------------------------------------------------------------------------
// Which words make a command a scan, and what it walks
// ---------------------------------------------------------------------------

/** Words that run another program without changing what it walks. */
const WRAPPERS = new Set(["sudo", "command", "time", "timeout", "env", "nohup", "nice", "stdbuf", "parallel", "doas"]);

/** Skip wrappers and `VAR=value` assignments; return the program and its argv tail. */
function programAndArgs(argv: Word[]): { program: string; args: Word[] } | null {
	let i = 0;
	while (i < argv.length) {
		const w = argv[i].text;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
			i++;
			continue;
		}
		const base = w.split("/").pop() ?? w;
		if (WRAPPERS.has(base)) {
			i++;
			// `timeout 60 x`, `nice -n 5 x`, `env FOO=1 x`, `timeout --foreground 20 x`.
			while (i < argv.length && (/^\d+(\.\d+)?[smhd]?$/.test(argv[i].text) || argv[i].text.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i].text))) i++;
			continue;
		}
		return { program: base, args: argv.slice(i + 1) };
	}
	return null;
}

/**
 * The path an operand names, or null when it is not a plain path (a glob, a
 * substitution, a variable other than `$HOME`). `quote` is the quote covering the
 * operand's first character: single quotes expand nothing, double quotes expand
 * `$HOME` but not `~`, and `~` expands only when nothing quotes it.
 */
function literalOperand(word: string, quote: "'" | '"' | null): string | null {
	if (!word) return null;
	const plain = /^[A-Za-z0-9_@%+=:,.\/-]+$/.test(word);
	if (!plain && !/^(["']?(~|\$\{?HOME\}?))(\/|$)/.test(word) && !["$", "$HOME", "${HOME}"].includes(word)) return null;
	let w = word;
	const tildeOk = quote !== "'" && quote !== '"';
	const homeOk = quote !== "'";
	if (tildeOk) w = w.replace(/^~/, "\u0000");
	if (homeOk) w = w.replace(/^\$\{HOME\}/, "\u0000").replace(/^\$HOME/, "\u0000");
	if (/[*?[\]`(){}|]/.test(w)) return null;
	return w;
}

/** Expand a parsed operand to an absolute path, or null when it cannot be one. */
export function expandRoot(word: string, cwd: string, home: string, quote: "'" | '"' | null = null): string | null {
	const lit = literalOperand(word, quote);
	if (lit === null) return null;
	let p = lit.replace(/\u0000/g, home);
	if (p === "") p = home; // a bare `~`
	if (!p.startsWith("/")) {
		if (cwd === "") return null;
		p = `${cwd.replace(/\/+$/, "")}/${p}`;
	}
	// Normalise `//`, `/.`, and a trailing slash, textually and without touching the
	// filesystem. `..` stays: resolving it is a filesystem question (is any part a
	// symlink?) and this function may not ask one, so `/Users/me/..` is never
	// claimed to be `/`. Missing that scan is cheaper than naming a root the shell
	// did not use.
	const lead = p.startsWith("/") ? "/" : "";
	const parts = p.split("/").filter((s) => s !== "" && s !== ".");
	p = lead + parts.join("/");
	return p === "" ? "/" : p;
}

export function isBroadRoot(path: string, env: ScanEnv): boolean {
	if (path === env.home) return true;
	return BROAD_ROOTS.includes(path);
}

/** `find <root>… <expression>`: indices of the leading positionals. */
export function findRootIndices(args: string[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith("-") || a === "(" || a === ")" || a === "!" || a === "-o" || a === "-a") break;
		if (/^[012]?[<>]/.test(a)) continue; // a redirection glued to its target: 2>/dev/null
		out.push(i);
	}
	return out;
}

/** Long flags that consume the next word, for `fd`'s grammar. */
const FD_VALUE_LONG = new Set([
	"--max-depth",
	"--min-depth",
	"--exact-depth",
	"--type",
	"--extension",
	"--engine",
	"--format",
	"--color",
	"--strip-cwd-prefix",
	"--changed-within",
	"--changed-after",
	"--max-buffer-time",
	"--regex",
]);
/** Short `fd` flags that consume the next word when they end a cluster. */
const FD_VALUE_SHORT = new Set(["d", "t", "e", "E", "r", "p"]);

/** `fd [flags] <pattern> [path…]`: index of the pattern and of the root positionals. */
export function fdPositionalIndices(args: string[]): { patternIndex: number | null; rootIndices: number[] } {
	const positional: number[] = [];
	let skipNext = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (/^[012]?[<>]/.test(a)) continue;
		if (a.startsWith("--")) {
			if (!a.includes("=") && FD_VALUE_LONG.has(a)) skipNext = true;
			continue;
		}
		if (a.startsWith("-") && a.length > 1) {
			if (FD_VALUE_SHORT.has(a.slice(-1))) skipNext = true;
			continue;
		}
		positional.push(i);
	}
	return { patternIndex: positional.length > 0 ? positional[0] : null, rootIndices: positional.slice(1) };
}

/** The largest literal depth bound in an argv, or null when there is none. */
function depthBound(args: string[], tool: "find" | "fd"): number | null {
	let best: number | null = null;
	const note = (n: number) => {
		best = best === null ? n : Math.max(best, n);
	};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (tool === "find") {
			const eq = /^-maxdepth=(\d+)$/.exec(a);
			if (eq) note(Number(eq[1]));
			else if (a === "-maxdepth" && /^\d+$/.test(args[i + 1] ?? "")) note(Number(args[++i]));
			continue;
		}
		const long = /^--max-depth(?:=|\s+)(\d+)$/.exec(a);
		if (long) note(Number(long[1]));
		else if (a === "--max-depth" && /^\d+$/.test(args[i + 1] ?? "")) note(Number(args[++i]));
		else if (/^-d\d+$/.test(a)) note(Number(a.slice(2)));
		else if (/^-[^-]*d$/.test(a) && /^\d+$/.test(args[i + 1] ?? "")) note(Number(args[++i]));
	}
	return best;
}

function isDestructive(args: string[], tool: "find" | "fd"): boolean {
	return tool === "find" ? args.includes("-delete") : args.includes("--delete") || args.includes("-exec") || args.includes("-x");
}

/** The positionals that decide what a scan walks, per its own grammar. */
export function scanOperandIndices(tool: "find" | "fd", args: string[]): { rootIndices: number[]; patternIndex: number | null } {
	if (tool === "find") return { rootIndices: findRootIndices(args), patternIndex: null };
	const { patternIndex, rootIndices } = fdPositionalIndices(args);
	return { rootIndices, patternIndex };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** Display form of a root list, preferring `~` for anything under home. */
function displayRoot(path: string, env: ScanEnv): string {
	if (path === env.home) return "~";
	if (path.startsWith(env.home + "/")) return "~" + path.slice(env.home.length);
	return path;
}

/** Quote a word for a shell only when it needs it. */
function shellArg(word: string): string {
	return /^[A-Za-z0-9_@%+=:,.\/-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The roots a scoped search should name: the caller's list, minus anything broad
 * (a session whose cwd is `$HOME` would otherwise be handed back the walk it was
 * just refused) and minus anything a shorter named root already covers —
 * `~/Projects/X ~/Projects` would make `find` print every file in the project
 * twice, so only `~/Projects` is kept.
 */
export function suggestionRoots(env: ScanEnv): string[] {
	const kept: string[] = [];
	for (const raw of env.scopedRoots) {
		const path = expandRoot(raw, env.cwd, env.home);
		if (path === null || path === env.home || isBroadRoot(path, env)) continue;
		if (kept.includes(path)) continue;
		// A root that contains another one makes the smaller one redundant, and
		// `find` would print every file under it twice.
		const covered = kept.findIndex((o) => path.startsWith(o + "/"));
		if (covered >= 0) continue;
		for (let i = kept.length - 1; i >= 0; i--) if (kept[i].startsWith(path + "/")) kept.splice(i, 1);
		kept.push(path);
	}
	return kept.map((path) => displayRoot(path, env));
}

/**
 * A `find` argv with its roots, its depth flag and its delete flag removed — the
 * question the command asked, without the parts being refused.
 */
function findExpression(args: string[]): string[] {
	let i = 0;
	while (i < args.length && !args[i].startsWith("-") && args[i] !== "(" && args[i] !== "!") i++;
	const out: string[] = [];
	for (; i < args.length; i++) {
		const a = args[i];
		if (/^[012]?[<>]/.test(a)) continue; // a redirection glued to its target: 2>/dev/null
		if (a === "-maxdepth" || a === "-depth" || a === "-d") {
			i++; // and its value
			continue;
		}
		if (/^-maxdepth=/.test(a) || a === "-delete") continue;
		out.push(a);
	}
	return out;
}

/**
 * The name a search was for, as a literal, or null when it is not one.
 *
 * `*foo*` is fd's default substring match and becomes `foo`. `*foo*bar*` is not a
 * substring of anything and stays a `find` suggestion, because `fd -F` would take
 * it literally and answer "nothing", which is a wrong answer with a new root
 * attached.
 */
function literalName(args: string[], tool: "find" | "fd"): string | null {
	let raw: string | undefined;
	if (tool === "find") {
		const idx = args.findIndex((a) => a === "-name" || a === "-iname");
		raw = idx >= 0 ? args[idx + 1] : undefined;
	} else {
		const { patternIndex } = fdPositionalIndices(args);
		raw = patternIndex === null ? undefined : args[patternIndex];
	}
	if (!raw) return null;
	const name = raw.replace(/^\*/, "").replace(/\*$/, "");
	if (name === "" || name === "." || /[*?[\]{}()|^$\\]/.test(name)) return null;
	return name;
}

/**
 * The command the agent should run instead: the same question, and roots that are
 * not the whole machine. `fd` is offered only when it is installed *and* the
 * question was a plain name — otherwise the `find` form carries the original
 * predicate, which is the difference between a suggestion and a different
 * question.
 *
 * **No depth flag, on purpose.** The refusal is about a broad *root*; once the
 * roots are projects and dot-directories, an unbounded walk of them is what the
 * measurements call cheap (`fd -H . ~/Projects` is 1.1 s over 299k entries,
 * `fd -H <name> ~/.pi` is 0.13 s). Carrying `-maxdepth 4` into the suggestion
 * turned a real recorded hunt into a wrong answer: `find / -maxdepth 8 -type d
 * -name pi-vcc` was looking for `~/.pi/agent/npm/node_modules/@sting8k/pi-vcc`,
 * five directories down, and the scoped-but-bounded suggestion found nothing. A
 * suggestion that answers "not there" when the thing is there is the exact
 * failure this file refuses to commit against the agent's own command.
 */
export function scopedSuggestion(finding: ScanFinding, args: string[], env: ScanEnv): string {
	const roots = suggestionRoots(env);
	const name = literalName(args, finding.tool);
	if (env.hasFd && name !== null) {
		return ["fd", "-H", "-F", shellArg(name), ...roots].join(" ");
	}
	if (finding.tool === "fd") {
		const { patternIndex } = fdPositionalIndices(args);
		const pattern = patternIndex === null ? "." : args[patternIndex];
		return ["fd", "-H", shellArg(pattern), ...roots].join(" ");
	}
	return ["find", ...roots, ...findExpression(args).map(shellArg)].join(" ");
}

function blockReason(finding: ScanFinding, suggestion: string, env: ScanEnv, multi: boolean): string {
	const where = finding.rootPath === "/" ? "the volume root" : "all of the home directory";
	const lines = finding.destructive
		? [`scan-guard: refused \`${finding.written}\` — a delete rooted at ${displayRoot(finding.rootPath, env)}.`]
		: [
				`scan-guard: refused \`${finding.written}\` — an unbounded walk of ${where}.`,
				"Measured here: `find ~` unbounded is 49 s over 1.3M entries, and `find /` walks the volume twice. Walks like this were 9.4% of all bash wall time in 13,000 recorded commands; of the four `find /` that were scored by hand, one found the file it was looking for.",
			];
	lines.push(
		multi
			? "Nothing in this command ran — not the scan, and not the other commands beside it. Cutting the scan out and running the rest would be editing what you asked for."
			: "Nothing ran.",
	);
	lines.push(
		finding.destructive
			? "It was not bounded for you either: a depth limit changes what a delete reaches, and that is a decision, not a performance tweak."
			: "It was not bounded for you either: `-maxdepth 4` turns \"not found\" into \"not found at depth 4\", and you would report the second one as a fact.",
	);
	lines.push(`The same search, scoped to where the file can be:\n  ${suggestion}`);
	lines.push("(mdfind is 0.3 s but does not index dot-directories, so it cannot see anything under ~/.pi — that is what sends agents to `find /`.)");
	return lines.join("\n");
}

function warnReason(finding: ScanFinding, suggestion: string): string {
	return [
		`scan-guard: \`${finding.written}\` walks ${finding.rootPath === "/" ? "`/`" : "all of `~`"} at depth ${finding.depth} — letting it run.`,
		"Bounded walks are cheap here (1.1 s at `$HOME -maxdepth 4`), but the most expensive call in this machine's session logs was this shape at 5,550 s, so bounded is not the same as safe.",
		`Narrower, if it was one file:\n  ${suggestion}`,
	].join("\n");
}

/**
 * The one call the adapter makes: read a bash command, decide allow / warn / block.
 *
 * `warn` means the same words as `block` about the root and differ about the
 * depth: the walk runs, and the human hears about it. `block` never patches the
 * command — see the header.
 */
export function verdictForCommand(cmd: string, env: ScanEnv): Verdict {
	const empty: Verdict = { action: "allow" };
	if (typeof cmd !== "string" || cmd.length === 0 || cmd.length > 64_000) return empty;

	const segs = commandSegments(cmd);
	if (!segs.ok) return empty;

	// Track `cd` so a bare `.` or a relative root resolves to the directory bash
	// would actually be in, not to the session's cwd.
	let cwd = env.cwd;
	let cwdKnown = true;

	let worst: { finding: ScanFinding; args: string[]; multi: boolean } | null = null;
	let isBlock = false;

	for (const segment of segs.segments) {
		const split = words(segment);
		if (!split.ok) return empty;
		const prog = programAndArgs(split.words);
		if (!prog) continue;
		const args = prog.args.map((w) => w.text);
		const quotes = prog.args.map((w) => w.quote);

		const tool: "find" | "fd" | null = prog.program === "find" ? "find" : prog.program === "fd" ? "fd" : null;

		if (tool) {
			const { rootIndices } = scanOperandIndices(tool, args);
			// find and fd both search `.` when given no path.
			const roots: Array<{ text: string; quote: "'" | '"' | null; index: number }> =
				rootIndices.length > 0 ? rootIndices.map((i) => ({ text: args[i], quote: quotes[i], index: i })) : [{ text: ".", quote: null, index: -1 }];
			const depth = depthBound(args, tool);
			const destructive = isDestructive(args, tool);
			for (const root of roots) {
				// A relative root under a working directory the guard could not work out
				// (a `cd $SOMETHING` in the same command) is a root it cannot name.
				if (!cwdKnown && !root.text.startsWith("/") && !root.text.startsWith("~") && root.text !== ".") continue;
				const path = expandRoot(root.text, cwdKnown ? cwd : "", env.home, root.quote);
				if (path === null || (!cwdKnown && !path.startsWith("/"))) continue;
				if (!isBroadRoot(path, env)) continue;
				const finding: ScanFinding = {
					tool,
					written: segment.replace(/\s+/g, " ").slice(0, 200),
					root: root.text,
					rootPath: path,
					depth,
					destructive,
				};
				const block = destructive || depth === null || depth > MAX_CHEAP_DEPTH;
				if (!worst || (block && !isBlock)) {
					worst = { finding, args, multi: segs.segments.length > 1 };
					isBlock = block;
				}
			}
			continue;
		}

		if (prog.program === "cd" || prog.program === "pushd") {
			const i = args.findIndex((a) => !a.startsWith("-"));
			const target = i < 0 ? undefined : args[i];
			const resolved = target === undefined ? env.home : expandRoot(target, cwdKnown ? cwd : "", env.home, quotes[i]);
			if (target === undefined || resolved === null || /[$*`"']/.test(target)) cwdKnown = false;
			else cwd = resolved;
		}
	}

	if (!worst) return empty;
	const suggestion = scopedSuggestion(worst.finding, worst.args, env);
	if (!isBlock) {
		return { action: "warn", finding: worst.finding, suggestion, reason: warnReason(worst.finding, suggestion) };
	}
	return { action: "block", finding: worst.finding, suggestion, reason: blockReason(worst.finding, suggestion, env, worst.multi) };
}
