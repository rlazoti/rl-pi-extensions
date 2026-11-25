# co-authored-by-ai

Adds a `Co-authored-by:` trailer to the commits **Pi** creates, naming the model
that made them.

```console
$ git log -1
commit 9f2a1c4 (HEAD -> main)
Author: Rodrigo Lazoti <…>

    fix: keep the separator inside quoted messages

    Co-authored-by: AI (Pi/Claude Opus 4.6) <noreply@pi.dev>
```

## What it does

Hooks `tool_call`, looks at `bash` commands before they run, and appends
`--trailer "…"` to the ones that are `git commit` — unless that exact trailer is
already there. It patches the command the agent is about to run — it never runs
anything itself, and it cannot see a commit you make in another terminal, so
human commits stay unattributed by construction. A second hook, `tool_result`,
exists only to undo the damage the flag does to empty messages
([see below](#the-empty-message-hazard-why-there-are-two-hooks)).

| Command | Becomes |
|---|---|
| `git commit -m "fix bug"` | `git commit -m "fix bug" --trailer "Co-authored-by: AI (Pi/<model>) <noreply@pi.dev>"` |
| `git add -A && git commit -m "x"` | `git add -A && git commit -m "x" --trailer "…"` (only the commit segment) |
| `git commit -F /tmp/m` `⏎` `rm /tmp/m` | trailer on the commit line only — the `rm` stays a `rm` |
| `git commit -m "a; b && c \|\| d \| e"` | trailer appended; the message keeps every one of those characters |
| `git commit -m "x" --trailer "Co-authored-by: Human <h@x>"` | `… --trailer "Co-authored-by: Human <h@x>" --trailer "…"` — theirs **and** ours, both true |
| `git commit -F m.txt --trailer "Co-authored-by: AI"` | `… --trailer "Co-authored-by: AI" --trailer "…"` — a lookalike is not attribution |
| `git commit -m "x" --trailer "Co-authored-by: AI (Pi/<model>) <noreply@pi.dev>"` | untouched — that *is* the trailer, whatever model it names |
| `echo "git commit -m x"`, `node -e '…git commit…'` | untouched — the match has to be outside the quotes |
| `git commit -m ""` | **untouched on purpose** — see [the empty-message hazard](#the-empty-message-hazard-why-there-are-two-hooks) |

The trailer is **git's own `--trailer` flag**, so git parses it, git places it,
and git deduplicates it: amending the same commit three times leaves exactly one
trailer line, and a trailer whose value is already in the message is not added
twice (measured on git 2.56.0 and pinned by tests that run real git). Two
different values both land, which is why a human `Co-authored-by:` no longer
makes the extension stand down — see
[why only its own trailer stops it](#why-only-its-own-trailer-stops-it).

`--trailer` needs git ≥ 2.32 (May 2021). On older git the commit still happens
and git reports the unknown option — the extension does not detect the version.

## The empty-message hazard (why there are two hooks)

`--trailer` is message content. That means it also defeats the check git runs
for free: an empty message no longer fails. Measured on git 2.56.0, with and
without the flag this extension adds:

| message source | without `--trailer` | with `--trailer` |
|---|---|---|
| `-m ""` | `Aborting commit due to empty commit message`, exit 1 | committed, message **is** the trailer |
| `-m "   "` | exit 1 | committed, trailer only |
| `-m "$MSG"` with `$MSG` empty | exit 1 | committed, trailer only |
| `-F -` with empty stdin | exit 1 | committed, trailer only |

Silently turning "loud authoring mistake" into "a commit whose whole message is
attribution" is not an acceptable trade, and it is not hypothetical: this is
what the first release commit of this extension looked like (subject line = the
trailer, body = nothing), after a mistyped here-document. So:

1. **`tool_call` refuses to patch what it can see is empty** — a commit whose
   only message is a blank literal (`-m ""`, `-m ''`, `-m "   "`, `--message ""`)
   is left exactly as the agent wrote it, git rejects it, and the failure stays
   where it belongs. A warning says why nothing was added.
2. **`tool_result` checks the commit it caused** — for `-m "$MSG"`, `-F -`, or
   anything else whose emptiness is invisible before execution, HEAD is recorded
   before the command runs and read back after: same sha means no commit
   happened, and a message that is nothing but this extension's trailer means
   the author's message was empty. The warning then goes to **both** audiences:
   appended to the tool result, so the agent reads it in the result it is about
   to act on and can `git commit --amend`, and `notify(…, "error")` for the
   human.

   "Nothing but the trailer" is read as *nothing but `Co-authored-by:` lines*,
   ours or anybody's: since a lookalike no longer stops the patching, a message
   whose every line is attribution is a commit this hook just helped make, and
   it needs the same warning whoever's name is on it.

Only commits **this hook patched** are ever inspected, by tool call id; git is
never run for anyone else's call, and if `git log` fails or exec throws, the
hook says nothing rather than guessing. A commit whose message is fine produces
no output of any kind from the second hook.

## Requirements

- [Pi](https://github.com/earendil-works/pi-coding-agent) coding agent.
- git ≥ 2.32 for `git commit --trailer`.

## Enable/Disable

Run `/rl-extensions` to toggle this extension on/off. Changes apply after `/reload`.

## Configuration

None. The trailer text is fixed:

```text
Co-authored-by: AI (Pi/<model name>) <noreply@pi.dev>
Co-authored-by: AI (Pi) <noreply@pi.dev>          ← when no model is selected
```

`Co-authored-by: AI` is the stable half — the thing a `git log --grep` or a
history query keys on. The parenthetical is the detail: which tool, which model.
The model name comes from `ctx.model.name`, so the same person's commits name
whatever model they actually used.

## Limits, stated

- **An empty message is caught after the commit, not before, when nothing can
  see it coming.** `-m "$MSG"` and `-F -` are patchable and `$MSG` may be empty
  by the time git runs; the trailer then lets the commit through (see
  [the hazard](#the-empty-message-hazard-why-there-are-two-hooks)). Detection is
  immediate and loud, but the commit does exist until someone amends it — by
  then it is one `git commit --amend -m "…"` away, usually done by the agent that
  read the warning.
- **`git commit` only, written that way.** `git -c user.name=x commit …`,
  `git --git-dir=… commit …` and any other global option between `git` and
  `commit` do not match, and neither does a commit inside `$(…)` or a backtick.
  The matcher is deliberately narrow: injecting into a command it misread is
  worse than missing one.
- **A commit inside a here-document is only seen when a shell runs the body.**
  `bash <<EOF`, `sh -s <<EOF` and `cat <<EOF | bash` count; `ssh host <<EOF`,
  `docker exec -i … sh <<EOF` (the shell is not the first word) and anything
  else that runs commands from stdin are read as data, so a commit there goes
  unattributed rather than risk patching a script.
- **`gt` (Graphite) is not supported.** The extension this was ported from also
  patched `gt cc -m "…"` by rewriting the quoted message, because Graphite has
  no `--trailer`. That rewriting path is where the interesting bugs lived (a
  message containing `$&` was expanded by `String.replace`; a `-am` cluster got
  no trailer at all and nothing said so). `gt` is not installed here, so the
  path is gone rather than ported.
- **A commit whose message already names a human is still attributed to the AI
  as well.** That is the intent — both contributed — but it does mean the
  trailer is not a claim about who typed the message.
- **A sentence that quotes the trailer counts as carrying it.** `hasOurTrailer`
  looks at the value of a `--trailer` argument and at *whole lines* of message
  text inside the command, so prose that mentions the trailer mid-sentence does
  not stop the injection, while a message that really ends with it does. A
  here-document that quotes the trailer on a line of its own is indistinguishable
  from one that uses it, and errs toward leaving one trailer instead of adding a
  second. A `\n` typed as two characters (`-m "subject\n\n…"`) is not a line
  break — for this check or for git — so it is not read as a trailer either.
- **No `--no-verify` bypass and no per-project opt-out.** Toggling the extension
  off is the opt-out.

## Design notes

**The shell-aware part is the whole extension.** Naively appending
`--trailer "…"` to the end of the command string breaks in four ways, each of
which is a test: it lands on the wrong command in `… | tail -5`; it lands on the
`rm` of a newline-separated cleanup; it slices a `git commit -m "fix; thing"`
message in half; and it matches the `git commit` inside
`node -e 'const c = "git commit"'`. `splitShellCommand` splits on `&&`, `||`,
`|`, `;` and newline while respecting `'…'`, `"…"` (with `\` escapes, as bash
does) and unterminated quotes, and `containsUnquoted` refuses any match that
overlaps a quoted region.

**Here-document bodies are data.** The body of `cmd <<TAG … TAG` (and `<<-`,
`<<'TAG'`, `<<"TAG"`, `<<\TAG`) is what `cmd` reads on stdin, so it is never a
segment and nothing in it counts as unquoted. The case that forced this: a
Python script fed through `python3 - <<'PYEOF'` had a `\'` inside a
single-quoted Python string. Shell quote rules read that as the end of a quote,
the tracking flipped, and a `git commit` inside a later Python string got
`--trailer` pasted into the script, a syntax error (Nov 25 2026, kept as
`fixtures/python-heredoc-2026-11-25.sh`). The exception is a body that a shell
runs as commands (`bash <<EOF`, `sh -s <<'EOF'`, `cat <<EOF | bash`): those
lines are scanned like any other. `$((1<<2))` and `<<<` here-strings are not
here-documents.

### Why only its own trailer stops it

The guard used to be `co-authored-by:` anywhere in the command, case-insensitive,
and that is how the extension missed twelve commits in a row without a word. The
agent was typing its own `--trailer "Co-authored-by: AI"` — which names no
address, so it is not a trailer a host renders as co-authorship, and no model,
which is the one thing this extension exists to record — and the guard read the
lookalike as the real thing and stood down. Nothing was logged, because from the
extension's side nothing had happened. It surfaced only because someone read
`git log` expecting the model name and found `AI`.

So the rule is now exactly one line: **only a trailer this extension could have
written counts as its own.** Any other `Co-authored-by:` is somebody else's true
statement and gets ours added beside it. A guard that stands down on a
*lookalike* is a guard an agent can switch off by accident, in a session that
will never see the difference.

**Amending is attributed.** An earlier version skipped `git commit --amend
--no-edit` as having "no message to attach to". There is a message — the reused
one — and `--trailer` is idempotent against it, so skipping only dropped
attribution from the commit-then-amend flow that agents run constantly. Two
consequences worth knowing: an AI-performed amend of a *human* commit adds the
AI trailer, and re-running the injection never stacks a second copy.

## Testing

Two colocated files, 92 tests.

`implementation.test.ts` (70) is the machinery: the trailer contract, the
quote-aware splitter and matcher (including the four append-to-the-wrong-place
regressions), here-document bodies (the Nov 25 2026 Python script fixture,
every tag quoting, `<<-`, two per line, unterminated, shell-fed bodies, shifts
and here-strings), `hasOurTrailer` — including the lookalike that started the
incident, a human trailer, and a sentence that merely quotes the trailer —
`hasOnlyEmptyMessageLiteral`, `messageIsOnlyTrailer`, and **eleven tests that run
real git** in a temp repo — the patched command string is handed to `bash`, then
the recorded commit message is read back with `git log --format=%B`. The
extension produces a command, so that is what gets tested, not the string it
built. Those eleven verify the trailer appears exactly once, that a message full of
`; && || |` survives intact, that three amends still leave one trailer, that a
newline-separated cleanup after the commit still runs, that a human trailer is
appended to, that the recorded real-world command — here-document message file,
`git commit -F`, the agent's own `--trailer "Co-authored-by: AI"` already on it
— now comes out with both attributions and its subject intact, that a
here-document message mentioning `git commit` survives and its commit is
attributed, that a commit `bash` runs from a here-document is attributed, that a message
carrying this extension's own trailer is not given a second copy, and that the
four empty-message shapes in the table above really do commit once `--trailer`
is present — the hazard is pinned against git itself, not against this file's
opinion of it.

`hooks.test.ts` (22) drives the extension through its own registration surface
with a fake Pi, because the interesting behaviour is a sequence: patch or refuse
at `tool_call`, report or stay silent at `tool_result`. It pins the refusal list,
the flags that mean "unknown, do not refuse", the exact patched form of the
command that started the incident, a script fed on stdin left alone, that only this extension's own trailer makes
it stand down (and that standing down means never touching git at all), the
warning reaching both the tool result and the notification, silence when the
message is fine, when nothing was committed, when the call was not ours, and when
git cannot answer, and that the bookkeeping stays bounded when tool calls are
abandoned.

## License

[MIT](../../LICENSE)
