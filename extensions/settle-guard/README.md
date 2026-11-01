# settle-guard

Retry a model turn that ended with **no answer and no tool call**.

A reasoning model can finish its thinking block and emit end-of-turn before
writing anything. The provider reports reasoning plus `finish_reason: stop` with
no content, Pi records a thinking-only assistant message, the agent loop has
nothing left to execute, and the session stops and waits for a keystroke. That
is what this catches: the settle boundary sees an empty turn, asks Pi for one
more model request, and asks for it with reasoning off, because that is what the
measurement says works.

## Enable

`/rl-extensions` → `settle-guard`. Off until symlinked, like everything here.

| Variable | Default | Effect |
|---|---|---|
| `PI_SETTLE_GUARD` | on | `off` (or `0`, `false`) makes the extension inert. Not in the transcript: the model is not the one who decides whether the guard runs. |
| `PI_SETTLE_GUARD_RETRIES` | `2` | Empty turns retried per streak, clamped to 0-5. `0` disables retrying without uninstalling. |
| `PI_SETTLE_GUARD_THINKING` | `off` | `off` asks the retry with reasoning disabled; `keep` retries at your level. |
| `PI_SETTLE_GUARD_DIR` | `~/.pi/settle-guard` | Log location. `off` or `none` switches logging off; a relative path is refused rather than guessed, since it would mean a different log per directory. Logging stops at 256 KB and `/settle-guard` says so. |

`/settle-guard` prints mode, streak, what it caught this session, and the log path.

## The measurement that picked the defaults

A session on a local Qwen build through llama.cpp kept stopping mid-run. 33
controlled probes came back clean, so the trigger was not the request shape;
replaying **the real conversation** reproduced it. Same transcript, same server,
only the thinking flag moved:

| condition | replays | ended with no tool call |
|---|---|---|
| reasoning requested (`reasoning_effort: medium`) | 9 | **8** |
| reasoning off (`reasoning_effort: none`) | 3 | **0** |

Reasoning length was not the discriminator (failures ran 127 to 2,236 characters
of thinking, successes 1,380 to 1,963), and the delimiter tags people blame are
not it either: in 12 probes they were delivered intact inside `content` and never
stopped generation. Retrying without reasoning is the default because it is the
one variable that changed the outcome.

## What it treats as empty

No non-whitespace text block **and** no tool call in the finished assistant
message, with `stopReason: "stop"`. Model-agnostic on purpose: an agent that
says nothing and does nothing is stuck whatever produced it, and a model that
never does it never triggers this.

A whole turn that is only the engine's own marker — `[refusal]`, a server's
content-filter notice — counts as empty too. A model that declines in a sentence
and then gets on with it does not: the marker has to be the entire answer.

It deliberately leaves alone: an aborted run (you pressed Escape), an error run
(Pi reports those), and a `length` stop (a budget the model used up, and retrying
doubles a long generation).

## Where the hook goes, which is not where it looks

`turn_end` is the intuitive place and is wrong. By the time it fires, Pi has
already decided the run is over: asking there, in exactly this state, is refused
with `Extension error (<boundary>): turn_end requested continuation without
runnable model context`. So is a bare `{ continue: true }` at the settle
boundary. What works is `agent_before_settle` returning a proposed
`custom_message` plus `continue: true` — the entry is what makes the request
runnable. Both errors are measured on Pi 1.4.0, and the nudge it sends is one
line, hidden from the transcript (`display: false`).

`context.canContinue` is `false` in exactly this state and stays `false` when the
continuation is accepted, so nothing here reads it. A retry starts a new agent
run, and a new run clears the streak — except when it is our own retry, which is
what `awaitingRetry` is for. Without that flag a stub that always answered empty
was retried 1,102 times, every one logged as attempt 1.

## The thinking level, and why it is touched at all

`PI_SETTLE_GUARD_THINKING=off` sets the level to `off` for the request that
replaces the empty turn and puts your level back when that request ends, or when
the run ends. It is restored **only if it is still `off`**, so a level you change
by hand during the retry wins and survives. The level change is visible in the
TUI for those seconds; if that is too noisy, set `keep`.

## Limits

- **It cannot tell an empty turn from a model that genuinely had nothing to say.**
  The cost is one bounded retry; the budget is per streak, so it cannot loop.
- **Each retry adds one hidden message to the transcript**, because Pi will not
  take the continuation without one. It is one line and not displayed, but it is
  there, and it is re-sent with every later request.
- **The retry re-reads the whole prompt.** At 40k tokens of context that is not
  free. `PI_SETTLE_GUARD_RETRIES=1` halves it.
- **A model that answers in reasoning only every time will exhaust the budget and
  warn you once per streak.** It will not keep trying, and it will not nag.
- **It cannot fix the cause.** The cause is the checkpoint ending its turn early;
  this recovers from it.

## Files

- `rule.ts` — the pure decision (`decide`). No Pi, no fs, no clock.
- `implementation.ts` — the settle-boundary hook, the thinking-level bookkeeping,
  the capped log, `/settle-guard`. Each record carries a stable `code`
  (`reasoned-empty`, `empty-content`, `refusal`, `budget`, …) next to the prose,
  for the day a parser wants to count what this actually catches.
- Every path is wrapped in `try`/`catch`: a handler that throws at a boundary
  spoils the boundary, so the worst this file can do is stay quiet.

## Source

- Rodrigo + AI, 2026-11-02. Diagnosis from session `01a194ed-4e43-74c9-9a5b-2317d4d80ba7`
  (MMEX local-LLM work) and the probe/replay harness in `/tmp/probe` (throwaway):
  Pi's own provider module driven with an instrumented `fetch` to capture requests
  and raw SSE, and the real transcript replayed with one variable changed at a
  time. Rules in `knowledge/local-llm-thinking-turn-cutoff.md`. The boundary
  behaviour — what Pi accepts, and what it refuses — was measured with a throwaway
  stub provider that answers empty on demand (`/tmp/sg-e2e`), because no fake Pi
  enforces it: the first version of this extension hooked `turn_end`, passed 46
  tests, and did nothing at all.
