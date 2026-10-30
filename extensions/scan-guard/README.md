# scan-guard

A `tool_call` guard on `bash` that refuses a command whose purpose is a filesystem
walk of the whole machine or the whole home directory, and answers the question that
walk was asking with a scoped command that fits in a second.

It exists because agents that lose a file search `/`. Measured below: 29 of 13,084
recorded `bash` calls did it, and those calls were **9.4% of all bash wall time on
this machine**. Median bash call: 0.1 s.

## Enable

`/rl-extensions` → `scan-guard`. Off until symlinked, like everything here.

| `PI_SCAN_GUARD` | behaviour |
|---|---|
| unset, `log` | **default.** Notify the human, write a log line, let the command run. The agent is not told anything, because nothing happened to it. |
| `block` | Refuse the ones classified as a hunt, with the scoped command in the reason the agent reads. |
| `off` | Do nothing, without uninstalling. |

`PI_SCAN_GUARD_LOG=full` also records the command text (see [The log](#the-log)).
`PI_SCAN_GUARD_DIR` moves the log.

There is no in-command marker, no "just this once" token, and no environment
variable a command can set for itself. `co-authored-by-ai`'s README is the story of
a guard that stood down for a string an agent typed, and went silent for twelve
commits. An off-switch has to live somewhere the model is not typing per call.

## The measurements

Taken on this machine (warm cache, idle, `2>/dev/null`), 2026-10-29, entry counts
from the same runs:

| command | time | entries |
|---|---|---|
| `find ~ -maxdepth 1 / 2 / 3 / 4` | 12 ms / 21 ms / 75 ms / 1,090 ms | 76 / 778 / 5,484 / 18,734 |
| **`find ~` unbounded** | **49 s** | **1,307,850** |
| `find / -maxdepth 3` | 166 ms | 2,934 |
| `fd -H . ~` | 3,331 ms | 962,310 |
| `fd -H . ~/Projects` | 1,088 ms | 299,067 |
| `fd -H <name> ~/.pi` | 130 ms | — |
| `mdfind -name <name>` | 300 ms | **0 — dot-directories are outside the Spotlight index** |

That last row is why the guard is worth having: `mdfind` is the right tool and it is
blind exactly where an agent looks (`~/.pi`, a project's dot-dirs), so the agent
concludes the disk is the only option and walks it. The refusal says so, or the next
attempt is `mdfind` followed by `find /`.

## The rule

| | |
|---|---|
| **block** | root is broad **and** depth is unbounded, past `MAX_CHEAP_DEPTH` (4), or not a literal the guard can read (`-maxdepth $d`) |
| **block** | `-delete`, `fd --delete`, or `fd -exec` at a broad root, whatever the depth |
| **warn** | root is broad and depth is bounded and ≤ 4 — the walk runs, the human hears about it |
| allow | everything else, including every root inside `$HOME`: `fd -H x ~/.pi` is 0.13 s |

Broad roots: `/`, `/Users`, `/Volumes`, `/System`, `/Library`, `/private`, `/net`,
`/usr`, `/opt`, `/var`, `/etc`, `$HOME` in any spelling (`~`, `~/`, `$HOME`,
`${HOME}`, the absolute path), and `.` when the working directory is `$HOME` —
including a `cd ~` earlier in the same command, which is how three of the recorded
ones were home walks with no home in them.

**Why a `warn` tier at all.** Depth bounds cost well, so a bounded walk is allowed
to run. But the most expensive call in this machine's session logs was
`find ~ -maxdepth 4`, twice in one command, at **5,550 s** against a warm ~1 s for
that exact predicate. Depth does not bound the tail, and silence about a shape that
once cost 92 minutes would be a claim the data does not support. `warn` is the
honest verdict, and it is also the reason the guard should not promise "bounded
means fast" anywhere.

## What the refusal says

The message is the product. A refusal that only says "too broad" costs the agent
another 20 s on a slightly narrower root, so this one names the roots, states the
cost, and states what did not run:

```
scan-guard: refused `find / -name 'jogoforca-port.md' -not -path '*/Library/*' 2>/dev/null` — an unbounded walk of the volume root.
Measured here: `find ~` unbounded is 49 s over 1.3M entries, and `find /` walks the volume twice. Walks like this were 9.4% of all bash wall time in 13,000 recorded commands; of the four `find /` that were scored by hand, one found the file it was looking for.
Nothing in this command ran — not the scan, and not the other commands beside it. Cutting the scan out and running the rest would be editing what you asked for.
It was not bounded for you either: `-maxdepth 4` turns "not found" into "not found at depth 4", and you would report the second one as a fact.
The same search, scoped to where the file can be:
  fd -H -F jogoforca-port.md ~/Projects ~/.pi ~/Downloads
(mdfind is 0.3 s but does not index dot-directories, so it cannot see anything under ~/.pi — that is what sends agents to `find /`.)
```

Three points that are easy to get wrong and are pinned in tests:

- **It never rewrites the command.** Refuse and offer; never silently add
  `-maxdepth`. Bounding a walk changes the meaning of an empty result from "not
  there" to "not found at depth 4", which the agent then reports as a fact.
- **The suggestion carries no depth flag.** It was going to, until the first run of
  the suggestion tests found the target of a real recorded hunt (`~/.pi/agent/npm/
  node_modules/@sting8k/pi-vcc`, five directories down) missing. At project scale an
  unbounded search is ~1 s, and a wrong "nothing" is the failure this component
  exists to prevent.
- **Roots that overlap are dropped.** `cwd` first, then `~/Projects ~/.pi
  ~/Downloads`; a cwd inside `~/Projects` is not listed twice, because `find` would
  print every file in it twice.

## Non-goals

- **Not a security boundary.** `bash -c "find /"`, a script file, `xargs`, backticks,
  and `python -c 'os.walk("/")'` all walk untouched, and each is a test that records
  the limit rather than a comment claiming one. This targets a habit visible in
  13,000 commands, not an adversary.
- **Not `du`, `grep -r`, `rg --files`, or pi's own tools.** One recorded `du -sh /`
  and one `grep -r /` in 13,084 calls: real, rare, and better added once `find`'s
  false-positive rate is known in use.
- **Not a resolver of `..`.** Reading it properly is a filesystem question (is any
  part a symlink?), and a guard that guessed would be wrong the other way. So
  `/Users/me/..` is not recognised as `/`.
- **Not blocking.** In `log` mode nothing is blocked at all, which is the shipping
  default; `block` is a decision the human makes after reading the log.

## Fail open, everywhere

A `tool_call` handler that throws **blocks the tool as a fail-safe** (Pi 1.4.0
`docs/extensions.md`: "A `tool_call` handler failure blocks the tool as a
fail-safe"). A bug in this extension would therefore freeze every `bash` call in the
session, not just scans. So every path that is not sure returns "allow" —
unbalanced quotes, unbalanced parens, a here-document with no terminator, a root
that is really `$( … )`, a command it cannot segment — and the logging and the UI
notification are wrapped separately, because a log directory that cannot be written
is not a reason to block a command. The tests run 22 malformed shapes (unterminated
`$( `, 40 KB of emoji, `find` with no operand, an empty string) twice each: once
with a narrow root, where anything but `allow` fails, and once with a broad one,
where an exception fails.

## The numbers

`extensions/scan-guard/corpus.test.ts` runs every command this machine's Pi sessions
actually ran against the classifier:

```
corpus: 12763 unique commands (12734 ordinary) · false positives 0/12734 · recall 29/29 (13 blocked, 16 warned) · 0.4 s
```

Precision is the number that matters: **a guard with one false positive in 13,000
commands gets switched off within a day.** If precision and recall ever fight,
precision wins and this README gets updated to say so.

Reproduce and stay current:

```bash
node scripts/export-bash-corpus.mjs                # regenerate the corpus fixture
node scripts/export-bash-corpus.mjs --candidates   # commands that look broad and are not labelled
```

The corpus (`tests/fixtures/bash-commands.jsonl`) is **git-ignored** — it is
whatever those sessions typed. `tests/fixtures/scan-guard-labels.json` is committed,
because the answer key is a judgement: 29 commands labelled by hand against the raw
session records, with the cost of each in the note. A test that skips when its
fixture is absent is honest; one that goes red on a fresh checkout is noise.

## `/scan-guard status`

Mode, calls read and scans seen this session, whether `fd` was found, where the log
is and whether it is capped, whether command text is being kept, and the last three
of both this session and the log.

## The log

`~/.pi/scan-guard/log.jsonl`, one line per event, per
`knowledge/telemetry-defaults.md`: off by default for contents (the decision —
`root`, `tool`, `depth`, `suggestion` — is recorded, the command is not unless
`PI_SCAN_GUARD_LOG=full`), small lines, **a cap rather than rotation** (stops
writing at 256 KB and `status` says so), never throws, and inside a directory the
human already manages so it can be deleted with the rest of it.

The point of the log is the flip from `log` to `block`: the corpus measures
precision on history, and only the log measures what comes next.
