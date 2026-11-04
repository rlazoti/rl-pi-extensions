# context-viewer

`/context` — browse what is in the context window, what each part costs, and what
the model was actually told.

The status bar answers "how full". This answers the three questions that follow
it: **where did it go**, **what is the system prompt saying today**, and **which
message am I about to pay for again**.

## Command

```
/context            token cost per category, then the tabs
/context system     jump to a tab: system | tools | messages | raw
```

Five tabs, navigated with `Tab` / `Shift+Tab`:

| Tab | What is in it |
|---|---|
| `Overview` | Context size, usage bar, tokens per category, largest messages |
| `System` | The system prompt, line for line — with the cwd, context files, skills and tool guidelines it pulled in |
| `Tools` | Every tool declared to the model, with its parameter types and required-ness |
| `Messages` | Every message Pi would send, including thinking blocks, tool calls, tool results and summaries |
| `Raw` | The same facts as one JSON document per line, for copying out or diffing |

### Keys

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | One line |
| `PgUp` `PgDn` / `Ctrl+B` `Ctrl+F` | One page (one line of overlap) |
| `Ctrl+U` `Ctrl+D` | Half a page |
| `Home` `g` / `End` `G` | Top / bottom |
| `Tab` / `Shift+Tab` | Next / previous tab (works mid-search) |
| `/` | Search; typing it scrolls to the first match |
| `n` `N` | Next / previous match |
| `y` | Copy the **whole** tab, not the visible window |
| `Esc` | Leave search; a second `Esc` closes. `q` and `Ctrl+C` close outright |

## What the numbers mean

One measured number, many guesses — and the panel says which is which.

- **Context size** and **usage** are the provider's own: `ctx.getContextUsage()`,
  the same pair the status bar and the compaction code read. `tokens` is the size
  of the request the last response was generated from, so it is one response
  behind on purpose — it is what was actually sent.
- **The split between categories is estimated.** Providers bill the prompt as a
  whole; nothing in the API says how much of the bill was the system prompt. So
  each category's weight is measured by text size (one token per four characters,
  images at the ~1,200-token allowance compaction uses) and scaled to add up to
  the measured total. The `~est` column shows the raw estimate next to the scaled
  one: where they differ a lot, the API is charging for something text length does
  not see, and the split for that row is softer.
- **Before the first request there is nothing measured.** Every figure then comes
  with `not measured, estimated from text` rather than a number pretending to be a
  receipt.
- **Categories** are `System prompt`, `System tools`, `Your messages`, `Assistant
  text`, `Thinking`, `Tool calls`, `Tool results`, `Summaries`, `Other`. Anything
  the estimator does not recognise lands in `Other` instead of quietly disappearing.
- **Compaction** shows the point the window stops being yours to fill
  (`size - reserve`), and what is left before then.

## Limits

- **Estimates are not receipts.** Category rows are a guide to where to look, not
  an invoice from the provider.
- **The Raw tab is a reconstruction**, not the wire request: it renders what the
  session contains and what the host reports about the prompt and tools.
- **A very long system prompt is shown as the host assembled it.** If a plugin has
  rewritten it, `/context` shows the rewritten text — that is the point — but it
  will not tell you which plugin did it.
- **Nothing is hidden when it is big.** Rendering a 40,000-line tool result costs
  a moment; scroll or `y` it out.

## Files
- **One row is one row.** Content is laid out in terminal rows: newlines are split, tabs become spaces (one character here, up to eight columns there) and escape sequences are dropped rather than printed, because all three make a row longer than it measures. A row too wide for the frame is wrapped, not clipped, so `End` and `/search` reach the end of every tool result.

| File | What lives there |
|---|---|
| `tokens.ts` | Cost estimation and category attribution. Pure, and compared against pi's own estimator by a test that reads pi's code in a subprocess |
| `text.ts` | The text of every tab, the width rules that keep it in the frame, and `screenLines`/`breakLine`: text from outside arrives as rows, not paragraphs |
| `viewer.ts` | The overlay component: keys, scrolling, search, copy |
| `implementation.ts` | `/context` itself: reading the host, the `!hasUI` fallback, the clipboard seam |

Reading the host is deliberately narrow (`ContextHost`) and lazily loaded, so the
module loads without Pi and every read that fails becomes a line in the Overview
instead of a command that refuses to open.
