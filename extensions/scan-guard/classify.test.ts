/**
 * scan-guard classifier tests.
 *
 * Three kinds, and the third is the one that matters most:
 *
 *  1. Grammar — `find` and `fd` take their operands differently and getting that
 *     wrong produces a refusal that names the wrong root.
 *  2. Failure — every input that could make this throw is asserted to return
 *     `allow`, because a throwing `tool_call` handler blocks every bash call in
 *     the session as a fail-safe (Pi 1.4.0 docs/extensions.md:375).
 *  3. **The suggestion is executed** in a real temp tree with real `find` and real
 *     `fd`, per AGENTS.md § 5. A refusal whose example command errors is worse
 *     than no refusal, and a string-level assertion cannot see that.
 *
 * The home directory here is synthetic. `expandRoot` is a text function, so
 * classification needs no filesystem; only the executed-suggestion tests build
 * one, and they point `HOME` at it so a suggested `~/.pi` resolves there.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	MAX_CHEAP_DEPTH,
	commandSegments,
	expandRoot,
	isBroadRoot,
	scopedSuggestion,
	suggestionRoots,
	verdictForCommand,
	words,
	type ScanEnv,
	type Verdict,
} from "./classify.ts";

const HOME = "/home/tester";

function makeEnv(over: Partial<ScanEnv> = {}): ScanEnv {
	return {
		cwd: `${HOME}/Projects/app`,
		home: HOME,
		hasFd: true,
		scopedRoots: [`${HOME}/Projects/app`, `${HOME}/Projects`, `${HOME}/.pi`, `${HOME}/Downloads`],
		...over,
	};
}

const verdict = (cmd: string, over: Partial<ScanEnv> = {}): Verdict => verdictForCommand(cmd, makeEnv(over));

/**
 * "and then look at what it said", without the type dance at every call site.
 *
 * It is a function and not an inline `!== "allow"` because `assert.equal(v.action,
 * "block")` already narrows `v.action`, and TypeScript is then entitled to call a
 * follow-up comparison impossible. Inside this predicate the verdict is still a
 * verdict.
 */
function acted(v: Verdict): v is Extract<Verdict, { action: "block" | "warn" }> {
	return v.action !== "allow";
}

// =============================================================================
// The rule: broad root AND unbounded depth
// =============================================================================

describe("the rule", () => {
	it("blocks a `find` under `/` with no depth bound", () => {
		const v = verdict(`find / -name 'jogoforca-port.md' 2>/dev/null | head -3`);
		assert.equal(v.action, "block");
	});

	it("blocks a `find` under `$HOME`, spelled four ways", () => {
		for (const spelling of ["~", "~/", "$HOME", "${HOME}"]) {
			const v = verdict(`find ${spelling} -name knowledge -type d`);
			assert.equal(v.action, "block", spelling);
			if (acted(v)) assert.equal(v.finding.rootPath, HOME, spelling);
		}
	});

	it("blocks the absolute home root as written", () => {
		assert.equal(verdict(`find /home/tester -name dailyContext.md`).action, "block");
	});

	it("allows the same search at any root inside home — `fd -H x ~/.pi` is 0.13 s", () => {
		for (const root of ["~/.pi", "~/Projects", "$HOME/.pi/memory3", "~/Documents/foo"]) {
			assert.equal(verdict(`find ${root} -name knowledge`).action, "allow", root);
		}
	});

	it("allows a bounded walk of a broad root, with a warning", () => {
		const v = verdict(`find ~ -maxdepth 3 -iname '*second-brain*'`);
		assert.equal(v.action, "warn");
		if (acted(v)) assert.equal(v.finding.depth, 3);
	});

	it("puts the cut-off at MAX_CHEAP_DEPTH, blocking one past it", () => {
		assert.equal(verdict(`find ~ -maxdepth ${MAX_CHEAP_DEPTH} -name x`).action, "warn");
		assert.equal(verdict(`find ~ -maxdepth ${MAX_CHEAP_DEPTH + 1} -name x`).action, "block");
	});

	it("treats a depth that is not a literal as no depth at all", () => {
		// `for d in 1 2 3; do find ~ -maxdepth $d; done` really is unbounded to us,
		// and the guard may not read a loop variable it cannot see.
		assert.equal(verdict(`find ~ -maxdepth $d -name x`).action, "block");
	});

	it("takes the widest of several -maxdepth flags, as find does", () => {
		const v = verdict(`find ~ -maxdepth 2 -iname a -o -maxdepth 4 -iname b`);
		assert.equal(v.action, "warn");
		if (acted(v)) assert.equal(v.finding.depth, 4);
	});

	it("does not let -mount or -xdev make `/` narrow", () => {
		assert.equal(verdict(`find / -mount -name x`).action, "block");
		assert.equal(verdict(`find / -xdev -name x`).action, "block");
	});

	it("blocks a delete at a broad root whatever the depth", () => {
		const v = verdict(`find ~ -maxdepth 2 -name cache -delete`);
		assert.equal(v.action, "block");
		if (acted(v)) assert.match(v.reason, /delete/);
	});

	it("blocks `du`… no: only find and fd are policed in v1", () => {
		// Pinned as a non-goal, so that adding du later is a decision and not drift.
		assert.equal(verdict(`du -sh /`).action, "allow");
		assert.equal(verdict(`grep -r secret /`).action, "allow");
		assert.equal(verdict(`rg --files /`).action, "allow");
	});
});

// =============================================================================
// Two grammars
// =============================================================================

describe("find and fd grammars", () => {
	it("`find <root>` — the leading positionals are the roots", () => {
		const v = verdict(`find /tmp build / -name x -type f`);
		assert.equal(v.action, "block");
		if (acted(v)) assert.equal(v.finding.rootPath, "/");
	});

	it("`find` with no operand means `.`", () => {
		assert.equal(verdict(`find -name x`, { cwd: HOME }).action, "block");
		assert.equal(verdict(`find -name x`, { cwd: `${HOME}/Projects` }).action, "allow");
	});

	it("`fd <pattern> [path…]` — the first positional is a pattern, not a root", () => {
		// The same two words are a root to find and a pattern to fd. Reading fd's
		// pattern as a root would refuse `fd -H jogoforca-port.md` as if it searched /.
		const v = verdict(`fd -H 'jogoforca-port\\.md' ~/.pi`);
		assert.equal(v.action, "allow");
		const w = verdict(`fd -H 'jogoforca-port\\.md' ~`);
		assert.equal(w.action, "block");
		if (acted(w)) assert.equal(w.finding.rootPath, HOME);
	});

	it("`fd` with no path means the working directory", () => {
		assert.equal(verdict(`fd -H knowledge`, { cwd: HOME }).action, "block");
		assert.equal(verdict(`fd -H knowledge`, { cwd: `${HOME}/Projects` }).action, "allow");
	});

	it("reads fd's depth from every spelling of it", () => {
		for (const flag of ["-d 4", "-d4", "--max-depth 4", "--max-depth=4", "-Hd 4", "-Hl -d 4"]) {
			const v = verdict(`fd -H ${flag} knowledge ~`);
			assert.equal(v.action, "warn", flag);
		}
	});

	it("does not mistake an fd flag's value for a root", () => {
		// `-t`/`--type` consume the next word; if they did not, "file" would be a
		// positional and the pattern would shift onto the real root.
		const v = verdict(`fd -H -t file knowledge ~/.pi`);
		assert.equal(v.action, "allow");
	});

	it("a quoted `\"~\"` is a directory called tilde, not home", () => {
		// find treats a quoted ~ literally. So does the guard, because a refusal that
		// is wrong about the root is worse than a missed scan.
		assert.equal(verdict(`find "~" -name x`).action, "allow");
	});

	it("a glob or a variable is a root the guard cannot name", () => {
		for (const root of ['"$DIR"', "$DIR", "~/*", "~/Proj*", "`echo ~`"]) {
			assert.equal(verdict(`find ${root} -name x`).action, "allow", root);
		}
	});

	it("resolves `.` against a `cd` in the same command, not against the session", () => {
		// Session cwd was ~/.terminal; the walk was of $HOME.
		const v = verdict(`cd ~ && echo hi && timeout 60 find . -maxdepth 4 -iname '*powerline*' 2>/dev/null`, {
			cwd: `${HOME}/.terminal`,
		});
		assert.equal(v.action, "warn");
	});

	it("does not claim a root when the directory came from a variable", () => {
		assert.equal(verdict(`cd "$TARGET" && find . -name x`, { cwd: HOME }).action, "allow");
	});

	it("stops tracking cd when it cannot read it, rather than guessing", () => {
		// Two cds: the last one wins, and the last one is unknown.
		assert.equal(verdict(`cd ~ && cd "$SOMEWHERE" && find . -name x`, { cwd: HOME }).action, "allow");
	});
});

// =============================================================================
// Broad roots
// =============================================================================

describe("broad roots", () => {
	const env = makeEnv();
	it("names the machine and the life", () => {
		for (const root of ["/", "/Users", "/Volumes", "/System", "/Library", "/private", "/net", "/usr", "/opt", "/var", "/etc", HOME]) {
			assert.ok(isBroadRoot(root, env), root);
		}
	});

	it("does not reach into a project", () => {
		for (const root of ["/usr/local/bin", "/opt/homebrew", `${HOME}/Projects`, "/private/tmp"]) {
			assert.ok(!isBroadRoot(root, env), root);
		}
	});

	it("does not resolve `..`, so `find /home/tester/..` is not claimed to be `/`", () => {
		// Resolving dot-dot is a filesystem question (is any part a symlink?), and a
		// guard that asked one would be wrong the other way round.
		assert.equal(expandRoot(`${HOME}/..`, env.cwd, HOME), `${HOME}/..`);
		assert.equal(verdict(`find ${HOME}/.. -name x`).action, "allow");
	});

	it("normalises slashes without asking the filesystem", () => {
		assert.equal(expandRoot(`${HOME}//./`, env.cwd, HOME), HOME);
		assert.equal(expandRoot("/", env.cwd, HOME), "/");
	});
});

// =============================================================================
// Documented escapes — limits, not bugs
// =============================================================================

describe("documented escapes", () => {
	it("`bash -c \"find /\"` runs untouched: the scan is inside a quoted string", () => {
		assert.equal(verdict(`bash -c "find / -name x"`).action, "allow");
	});

	it("a script file, an xargs and a python -c run untouched", () => {
		assert.equal(verdict(`./hunt.sh`).action, "allow");
		assert.equal(verdict(`printf '~\\n' | xargs -I{} find {} -name x`).action, "allow");
		assert.equal(verdict(`python3 -c 'import os; [w for w in os.walk("/")]'`).action, "allow");
	});

	it("backticks are opaque", () => {
		assert.equal(verdict(`echo ` + "`find / -name x`").action, "allow");
	});

	it("a here-document body is data, however many times it says find", () => {
		const cmd = `python3 - <<'PY'\nimport os\n# find test blocks mentioning fallback\nfor d in os.walk("/"): print(d)\nPY`;
		assert.equal(verdict(cmd).action, "allow");
	});

	it("a comment is not a command", () => {
		assert.equal(verdict(`# find ~ -name everything is a bad idea\necho ok`).action, "allow");
	});

	it("a `find` in a quoted echo is not a scan", () => {
		assert.equal(verdict(`echo "use find ~ to search your home"`).action, "allow");
		assert.equal(verdict(`grep -rn 'find /' README.md`).action, "allow");
	});
});

// =============================================================================
// Segmentation the root extractor needs and splitShellCommand does not do
// =============================================================================

describe("segmentation", () => {
	it("finds the scan inside $( … ) — where the 5,550 s call hid", () => {
		const cmd = `echo ===; for d in $(find ~ -maxdepth 4 -name knowledge -type d 2>/dev/null); do echo "$d: $(find $d -type f | wc -l)"; done`;
		const v = verdict(cmd);
		assert.equal(v.action, "warn");
	});

	it("keeps scanning past a nested subshell", () => {
		assert.equal(verdict(`( cd /tmp; ls ) ; find ~ -name x`).action, "block");
	});

	it("reads a wrapper without losing the command behind it", () => {
		for (const cmd of [
			`timeout 60 find ~ -name x`,
			`time find ~ -name x`,
			`sudo find / -name x`,
			`command find ~ -name x`,
			`FOO=bar find ~ -name x`,
			`/usr/bin/find ~ -name x`,
		]) {
			assert.equal(verdict(cmd).action, "block", cmd);
		}
	});

	it("ignores a redirection glued to the end of the operand list", () => {
		const v = verdict(`find / -name x 2>/dev/null`);
		assert.equal(v.action, "block");
		if (acted(v)) assert.equal(v.finding.rootPath, "/");
	});

	it("splits segments at every separator", () => {
		const { ok, segments } = commandSegments(`a; b && c || d | e & f\ng`);
		assert.ok(ok);
		assert.deepEqual(segments, ["a", "b", "c", "d", "e", "f", "g"]);
	});

	it("words() strips both quote styles, keeps one word, and remembers the quote", () => {
		assert.deepEqual(words(`echo "two words" 'and ${HOME}'`), {
			ok: true,
			words: [
				{ text: "echo", quote: null },
				{ text: "two words", quote: '"' },
				{ text: `and ${HOME}`, quote: "'" },
			],
		});
	});
});

// =============================================================================
// Fail open, always
// =============================================================================

describe("never throws — a throwing tool_call handler freezes every bash call", () => {
	// A `tool_call` handler that throws blocks the tool as a fail-safe, so one
	// command with an unbalanced quote would freeze the session's shell. Each shape
	// is run twice: once with a narrow root, where `allow` is the only acceptable
	// answer (a block there means the parse broke and something was guessed), and
	// once with a broad root, where a block is fine but an exception is not.
	const shapes: Array<[string, string]> = [
		["unterminated double quote", `find {R} -name "x`],
		["unterminated single quote", `find {R} -name 'x`],
		["unterminated substitution", `echo $(find {R} -name x`],
		["unterminated paren", `(find {R} -name x`],
		["unterminated here-doc", `python3 <<PY\nfind {R} -name x`],
		["unbalanced parens around it", `${"(".repeat(50)}find {R} -name x${")".repeat(49)}`],
		["deeply nested parens", `${"(".repeat(400)}find {R} -name x${")".repeat(400)}`],
		["find with no operand at all", "find"],
		["fd with no operand at all", "fd"],
		["bare dash", "find -"],
		["only a separator", ";"],
		["only a pipe", `find {R} -name x |`],
		["newline only", "\n\n"],
		["empty string", ""],
		["emoji and newline in a path", `find {R} -name "🔍\n.png"`],
		["nul and control characters", `find {R} -name "a\u0000b\u0001c"`],
		["maxdepth with no value", `find {R} -maxdepth`],
		["maxdepth that is not a number", `find {R} -maxdepth abc -name x`],
		["backslash at the end", `find {R} \\`],
		["a 20 KB command", `find {R} -name x ${"-iname y ".repeat(2000)}`],
		["40 KB of emoji", "🔍".repeat(20_000) + ` find {R} -name x`],
		["here-doc delimiter that is a quote", `cat <<'\nfind {R} -name x`],
	];

	for (const [name, shape] of shapes) {
		it(`allows, not guesses: ${name}`, () => {
			const v = verdict(shape.replaceAll("{R}", "/tmp"));
			assert.equal(v.action, "allow");
		});
		it(`never throws, however broad: ${name}`, () => {
			assert.doesNotThrow(() => verdict(shape.replaceAll("{R}", "~")));
		});
	}

	it("lets a malformed command go entirely rather than judging part of it", () => {
		// `bash -n` rejects this line outright — nothing in it runs, the scan
		// included — so refusing it would block a command that was never going to
		// walk anything. Fail open means open for the whole command, not per segment.
		assert.equal(verdict(`find ~ -name x; find ~ -name "y`).action, "allow");
	});

	it("returns allow for a command that is not a scan at all", () => {
		assert.deepEqual(verdict(`ls -la`), { action: "allow" });
		assert.deepEqual(verdict(`git commit -m "fix; the thing" && npm test`), { action: "allow" });
	});

	it("survives the shapes the corpus is full of: git commits with heredoc messages", () => {
		const cmd = `cd /repo && git commit -F - <<'MSG'\nfind the root cause\n\nThis commit does not find ~ anything.\nMSG\ngit log -1`;
		assert.equal(verdict(cmd).action, "allow");
	});

	it("ignores a cwd it was not given", () => {
		assert.equal(verdict(`find . -name x`, { cwd: "" }).action, "allow");
	});
});

// =============================================================================
// The compound case the block has to mention
// =============================================================================

describe("what did not run", () => {
	it("says nothing ran when a commit shared the command", () => {
		const v = verdict(`git add -A && git commit -m "x" && find ~ -name note.md`);
		assert.equal(v.action, "block");
		if (acted(v)) {
			assert.match(v.reason, /Nothing in this command ran/);
			assert.match(v.reason, /not the scan, and not the other commands/);
		}
	});

	it("does not claim a commit was skipped when the command was only a scan", () => {
		const v = verdict(`find ~ -name note.md`);
		assert.equal(v.action, "block");
		if (acted(v)) {
			assert.match(v.reason, /\nNothing ran\./);
			assert.doesNotMatch(v.reason, /Nothing in this command ran/);
		}
	});

	it("the reason always contains a command, the measured cost, and why it was not bounded", () => {
		const v = verdict(`find / -name x`, { cwd: `${HOME}/Projects/app` });
		assert.equal(v.action, "block");
		if (acted(v)) {
			assert.match(v.reason, /49 s/);
			assert.match(v.reason, /not found at depth 4/);
			assert.match(v.reason, /mdfind/);
			assert.match(v.reason, new RegExp(`\n  (fd|find) `), "ends with an indented command");
			assert.doesNotMatch(v.reason, /-maxdepth 4 .*(-name|knowledge)/, "the suggestion must not re-bound the search");
		}
	});
});

// =============================================================================
// Suggestions: roots
// =============================================================================

describe("suggested roots", () => {
	it("drops cwd when cwd is the home directory it just refused", () => {
		const roots = suggestionRoots(makeEnv({ cwd: HOME, scopedRoots: [HOME, `${HOME}/Projects`, `${HOME}/.pi`] }));
		assert.deepEqual(roots, ["~/Projects", "~/.pi"]);
	});

	it("drops a root another root already covers, so find does not print twice", () => {
		const roots = suggestionRoots(makeEnv({ cwd: `${HOME}/Projects/app` }));
		assert.ok(!roots.includes("~/Projects/app"), roots.join(" "));
		assert.ok(roots.includes("~/Projects"), roots.join(" "));
	});

	it("keeps a cwd that is nowhere near the others", () => {
		// The adapter puts cwd first in scopedRoots; the classifier does not add it.
		const roots = suggestionRoots(makeEnv({ cwd: `${HOME}/.emacs.d`, scopedRoots: [`${HOME}/.emacs.d`, `${HOME}/Projects`, `${HOME}/.pi`, `${HOME}/Downloads`] }));
		assert.deepEqual(roots, ["~/.emacs.d", "~/Projects", "~/.pi", "~/Downloads"]);
	});

	it("has nothing useful to say when every root is broad", () => {
		assert.deepEqual(suggestionRoots(makeEnv({ cwd: HOME, scopedRoots: [HOME, "/"] })), []);
	});
});

// =============================================================================
// Suggestions: they have to run
// =============================================================================

describe("every suggestion runs, and finds the file it is for", () => {
	let root: string;
	let env: ScanEnv;
	let fdAvailable: boolean;

	before(() => {
		root = mkdtempSync(join(tmpdir(), "scan-guard-"));
		// A miniature home: a project holding the file being hunted, a dot-dir, a
		// Downloads, and noise to walk through.
		mkdirSync(join(root, "home/Projects/app/src"), { recursive: true });
		mkdirSync(join(root, "home/.pi/memory3/knowledge"), { recursive: true });
		mkdirSync(join(root, "home/Downloads"), { recursive: true });
		mkdirSync(join(root, "home/Library/Caches/junk/deep/deeper/deepest"), { recursive: true });
		writeFileSync(join(root, "home/Projects/app/src/target.ts"), "the file\n");
		writeFileSync(join(root, "home/.pi/memory3/knowledge/note.md"), "the note\n");
		for (let i = 0; i < 300; i++) writeFileSync(join(root, `home/Library/Caches/junk/f${i}.tmp`), "x");
		env = {
			cwd: join(root, "home/Projects/app"),
			home: join(root, "home"),
			hasFd: true,
			scopedRoots: [join(root, "home/Projects/app"), join(root, "home/Projects"), join(root, "home/.pi"), join(root, "home/Downloads")],
		};
		try {
			execFileSync("fd", ["--version"], { stdio: "ignore" });
			fdAvailable = true;
		} catch {
			fdAvailable = false;
		}
	});

	after(() => rmSync(root, { recursive: true, force: true }));

	/** Run a suggestion the way the agent would: bash, in the session's cwd, with the session's HOME. */
	function run(suggestion: string): string {
		return execFileSync("/bin/bash", ["-lc", suggestion], {
			cwd: env.cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, HOME: env.home, PATH: process.env.PATH },
		}).toString();
	}

	const cases: Array<{ name: string; cmd: string; expect: string; cwd?: string }> = [
		{ name: "a volume hunt, by name", cmd: `find / -name 'target.ts' 2>/dev/null | head -3`, expect: "target.ts" },
		{ name: "a home hunt, by name", cmd: `find ~ -name 'note.md' -not -path '*/node_modules/*'`, expect: "note.md" },
		{ name: "a home hunt for a directory", cmd: `find ~ -type d -name knowledge`, expect: "knowledge" },
		{ name: "a home hunt with the pattern in a variable", cmd: `find ~ -name "$MAYBE" -type f`, expect: "" },
		{ name: "fd at the home root", cmd: `fd -H target ~`, expect: "target.ts" },
		{ name: "fd with no path, from a home cwd", cmd: `fd -H .`, expect: "", cwd: "home" },
		{ name: "a bounded home hunt (warn tier)", cmd: `find ~ -maxdepth 4 -name knowledge -type d`, expect: "knowledge" },
		{ name: "a delete (blocked, suggestion must not delete)", cmd: `find ~ -name target.ts -delete`, expect: "target.ts" },
	];

	for (const { name, cmd, expect } of cases) {
		it(name, () => {
			const caseEnv = cases.find((c) => c.name === name)?.cwd === "home" ? { ...env, cwd: join(root, "home") } : env;
			const v = verdictForCommand(cmd, caseEnv);
			assert.notEqual(v.action, "allow", "the case stopped being a scan");
			if (!acted(v)) return;
			const out = run(v.suggestion);
			if (expect) {
				assert.ok(out.includes(expect), `${v.suggestion}\n→ ${out.slice(0, 300)}`);
			} else {
				// A suggestion for a pattern the guard could not read still has to run:
				// it must not be a shell syntax error or a usage error.
				assert.ok(!/usage:|Unrecognized|null data|syntax error/i.test(out), out.slice(0, 300));
			}
			// A refused delete must stay a refusal: the suggestion never carries -delete.
			assert.ok(!v.suggestion.includes("-delete"), v.suggestion);
			// …and it never walks the root it just refused.
			assert.ok(!new RegExp(`(~|\\$HOME|${env.home})/?(\\s|$)`).test(v.suggestion), v.suggestion);
		});
	}

	it("falls back to find when fd is not installed, and the fallback runs", () => {
		const v = verdictForCommand(`find / -name 'target.ts'`, { ...env, hasFd: false });
		assert.equal(v.action, "block");
		if (!acted(v)) return;
		assert.ok(v.suggestion.startsWith("find "), v.suggestion);
		assert.match(run(v.suggestion), /target\.ts/);
	});

	it("offers fd only when fd is installed", () => {
		const withFd = verdictForCommand(`find / -name 'target.ts'`, env);
		const withoutFd = verdictForCommand(`find / -name 'target.ts'`, { ...env, hasFd: false });
		if (acted(withFd) && acted(withoutFd)) {
			assert.ok(withFd.suggestion.startsWith(fdAvailable ? "fd " : "find "), withFd.suggestion);
			assert.ok(withoutFd.suggestion.startsWith("find "), withoutFd.suggestion);
		}
	});

	it("keeps the original predicate when the question was not a plain name", () => {
		const v = verdictForCommand(`find ~ -type d -name knowledge -not -path '*/node_modules/*'`, { ...env, hasFd: false });
		if (v.action === "allow") throw new Error("expected a block");
		assert.ok(v.suggestion.includes("-type d"), v.suggestion);
		assert.ok(v.suggestion.includes("-not -path"), v.suggestion);
		assert.match(run(v.suggestion), /knowledge/);
	});

	it("still finds the thing that lives six directories down", () => {
		// Regression, from the first real run of these tests against the real disk:
		// `find / -maxdepth 8 -type d -name pi-vcc` hunts
		// ~/.pi/agent/npm/node_modules/@sting8k/pi-vcc, and a suggestion that capped
		// the depth at 4 reported nothing. Bounding the *suggested* search was the
		// bug; the guard's business is the root.
		mkdirSync(join(env.home, "Projects/deep/a/b/c/d/e"), { recursive: true });
		writeFileSync(join(env.home, "Projects/deep/a/b/c/d/e/pi-vcc.txt"), "deep\n");
		for (const hasFd of [true, false]) {
			const v = verdictForCommand(`find / -maxdepth 8 -name pi-vcc.txt`, { ...env, hasFd });
			if (!acted(v)) throw new Error("expected a block");
			assert.ok(!v.suggestion.includes("maxdepth") && !v.suggestion.includes("-d "), v.suggestion);
			assert.match(run(v.suggestion), /pi-vcc\.txt/, `${hasFd ? "fd" : "find"} suggestion missed it: ${v.suggestion}`);
		}
	});

	it("the target of a refused delete is still there afterwards", () => {
		const v = verdictForCommand(`find ~ -name target.ts -delete`, env);
		if (v.action === "allow") throw new Error("expected a block");
		run(v.suggestion);
		assert.ok(existsSync(join(env.home, "Projects/app/src/target.ts")));
	});
});

// =============================================================================
// The measured numbers stay measured
// =============================================================================

describe("the reason text quotes the measurements, not invented ones", () => {
	it("mentions 49 s / 1.3M entries, 5,550 s, and one in four", () => {
		const blocked = verdict(`find / -name x`);
		const warned = verdict(`find ~ -maxdepth 3 -name x`);
		assert.ok(acted(blocked) && acted(warned));
		if (acted(blocked)) assert.match(blocked.reason, /49 s over 1\.3M entries/);
		if (acted(warned)) assert.match(warned.reason, /5,550 s/);
	});
});
