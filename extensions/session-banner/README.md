# session-banner

Persistent visual identity for Pi sessions — and automatic session naming so `/resume`, terminal tabs, and your session name always show something meaningful.

## What it does

Shows a colored banner widget above the input editor:

```text
──────────────────────────────────────────────────
  🔮  │  fix checkout tax bug
──────────────────────────────────────────────────
```

Three layers of identification:

| Layer | Where visible | What it shows |
|-------|--------------|---------------|
| **Banner widget** | Above the editor (always visible once labeled) | emoji │ name |
| **Terminal title** | Terminal tab bar + Cmd+Tab | `π root //areas/core — 🔮 fix bug` |
| **Session name** | `/resume` session list | `🔮 fix checkout tax bug` |

The banner stays hidden until a label is set, keeping the UI clean for quick one-off sessions. To drop the above-editor banner entirely and keep just the terminal/tab title and pi session name, set `PI_SESSION_BANNER_WIDGET=off` (see [Configuration](#configuration)).

## Auto-naming (background, no agent involvement)

While the session is still unnamed, the extension sends a compressed snippet of the conversation (first 2 + last 3 user messages, plus the most recent assistant reply) to Claude Haiku and sets the session name from the response. Before sending, it reduces GitHub PR/issue links to their numeric IDs and omits opaque Slack links from the naming context; other URLs remain when their paths may carry useful topic context. Haiku also picks the emoji: it's asked to start the title with whatever single emoji best captures the session, so the banner's emoji reflects what the session is about instead of being random. When the model omits or garbles the emoji, we fall back to a random one from the pool, so the banner always has one.

**The first confident name wins and locks in.** Once Haiku returns a real (non-`SKIP`) title, the extension stops auto-naming for that session. This keeps the title reflecting the session's *original* intent — usually your opening prompt — instead of churning across the first few turns and drifting toward whatever a follow-up happens to be about. Use `/title` if you want to rename after that.

Until that first name lands, there are two attempts per turn:

- **Early** — fires on `before_agent_start`, the moment the user submits, in parallel with the agent loop. A specific opening prompt ("fix flaky test in checkout.test.ts") becomes the session name in ~1–2s, not 20 minutes later when a long-running turn finally finishes. If it lands a name, the session is named and locked — the late backstop below is skipped.
- **Late** — fires on `agent_end` as a backstop *only when the session is still unnamed* (the early call returned `SKIP`, failed, or hadn't returned yet). By this point the assistant's reply is in scope, which is often what unblocks naming a vague opening prompt.

If the conversation still lacks specificity ("hi", "?", "help me") Haiku returns `SKIP` on the early call and naming defers to the next turn. The late call uses a SKIP-suppressed system prompt — by then there's an assistant response in context, so the model is required to emit a title. We keep retrying only while the session is unnamed, and give up after 3 user turns to avoid ongoing token spend.

This happens entirely in the background — no tool the main agent has to remember to call, no prompt-engineering pressure, no race with the main model. The two hooks share an in-flight flag so the early and late attempts of the same turn never run concurrently.

Manual renames always win:

- If `pi.getSessionName()` differs from the exact name this extension last wrote (e.g. the user ran `/name`, cleared the title, or `/resume` loaded a previously named session), we back off permanently for that session.
- `/title <text>` is treated as a manual Pi session rename, so it cancels any in-flight background request and stops further auto-naming for that session.

## Commands

### `/title [text]`

- **With args**: set the session name directly (e.g., `/title fix checkout tax bug`). Re-rolls the emoji and title color so the change is visually obvious, cancels any in-flight background request, and stops further auto-naming for that session.
- **Without args**: regenerate the name and its contextual emoji from the current conversation via Haiku (the title color is kept). Cancels any in-flight background request so stale results cannot overwrite the command's result.

## Configuration

| Env var | Default | Notes |
|---------|---------|-------|
| `PI_SESSION_BANNER_PROVIDER` | `anthropic` | Model provider for auto-naming |
| `PI_SESSION_BANNER_MODEL` | `claude-haiku-4-5` | Model id for auto-naming |
| `PI_SESSION_BANNER_WIDGET` | `on` | Set to `off`/`0`/`false` to hide the above-editor banner widget. The terminal/tab title, pi session name, auto-naming all keep working — you just lose the colored banner above the editor. |
| `PI_SESSION_BANNER_TITLE_ORDER` | `zone-first` | Terminal-title segment order. `zone-first` renders `π root //areas/core — 🔮 fix bug`; `label-first` renders `π 🔮 fix bug — root //areas/core`, leading with the session name so it survives tab-title truncation (handy when many tabs share the same zone). Unnamed sessions render `π root //areas/core` in both orders. Unrecognized values fall back to `zone-first`. |

## Enable/Disable

This extension is part of the [rl-pi-extensions](..) monorepo. Run `/rl-extensions` to toggle it on/off. Changes apply after `/reload`.

## World monorepo support

Auto-detects the worktree name (`root`, `t1`, `t2`, …) and zone path from the cwd for the terminal title. Each new session gets a random emoji and title color for quick visual identification across multiple windows. The emoji is persisted inside the session name itself; the title color is deliberately **not** persisted — it re-rolls on every session restore or switch, so a restored session keeps its name and emoji but may render in a different color.

## Relation to `retitle`

This extension supersedes the [`retitle`](../retitle/) extension. `retitle` does the same Haiku-based background auto-naming but without the banner, terminal title, or world-context support. **Don't enable both** — they'd both call `pi.setSessionName` on `agent_end` and race.
