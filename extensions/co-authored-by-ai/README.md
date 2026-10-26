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
`--trailer "…"` to the ones that are `git commit`. It patches the command the
agent is about to run — it never runs anything itself, and it cannot see a
commit you make in another terminal, so human commits stay unattributed by
construction.

| Command | Becomes |
|---|---|
| `git commit -m "fix bug"` | `git commit -m "fix bug" --trailer "Co-authored-by: AI (Pi/<model>) <noreply@pi.dev>"` |
| `git add -A && git commit -m "x"` | `git add -A && git commit -m "x" --trailer "…"` (only the commit segment) |
| `git commit -F /tmp/m` `⏎` `rm /tmp/m` | trailer on the commit line only — the `rm` stays a `rm` |
| `git commit -m "a; b && c \|\| d \| e"` | trailer appended; the message keeps every one of those characters |
| `git commit -m "x" --trailer "Co-authored-by: Human"` | untouched |
| `echo "git commit -m x"`, `node -e '…git commit…'` | untouched — the match has to be outside the quotes |

The trailer is **git's own `--trailer` flag**, so git parses it, git places it,
and git deduplicates it: amending the same commit three times leaves exactly one
trailer line (measured on git 2.56.0 and pinned by a test that runs real git).
Existing trailers in the message are appended to, never replaced.

`--trailer` needs git ≥ 2.32 (May 2021). On older git the commit still happens
and git reports the unknown option — the extension does not detect the version.

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

- **`git commit` only, written that way.** `git -c user.name=x commit …`,
  `git --git-dir=… commit …` and any other global option between `git` and
  `commit` do not match, and neither does a commit inside `$(…)` or a backtick.
  The matcher is deliberately narrow: injecting into a command it misread is
  worse than missing one.
- **`gt` (Graphite) is not supported.** The extension this was ported from also
  patched `gt cc -m "…"` by rewriting the quoted message, because Graphite has
  no `--trailer`. That rewriting path is where the interesting bugs lived (a
  message containing `$&` was expanded by `String.replace`; a `-am` cluster got
  no trailer at all and nothing said so). `gt` is not installed here, so the
  path is gone rather than ported.
- **A commit whose message already names a human is still attributed to the AI
  as well.** That is the intent — both contributed — but it does mean the
  trailer is not a claim about who typed the message.
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

**Amending is attributed.** An earlier version skipped `git commit --amend
--no-edit` as having "no message to attach to". There is a message — the reused
one — and `--trailer` is idempotent against it, so skipping only dropped
attribution from the commit-then-amend flow that agents run constantly. Two
consequences worth knowing: an AI-performed amend of a *human* commit adds the
AI trailer, and re-running the injection never stacks a second copy.

## Testing

`npm test` runs `implementation.test.ts`: the trailer contract, the quote-aware
splitter and matcher (including the four regressions above), the handler's skip
rules through a fake Pi, and **five tests that run real git** in a temp repo —
the patched command string is handed to `bash`, then the recorded commit message
is read back with `git log --format=%B`. The extension produces a command, so
that is what gets tested, not the string it built. Those tests verify the trailer
appears exactly once, that a message full of `; && || |` survives intact, that
three amends still leave one trailer, and that a newline-separated cleanup after
the commit still runs.

## License

[MIT](../../LICENSE)
