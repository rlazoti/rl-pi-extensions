# Cutover caller inventory (read-only)

Written once, before cutover (spec R40.0). It lists every caller found on this
machine that touches the memory extension, the memory feature it uses, and the
exact change needed. **It changes nothing.** The edits are Rodrigo's; the
extension never writes `AGENTS.md`, skills or any config outside `~/.pi/memory/`.

Machine facts, checked 2026-10-17:

| # | Caller | What it uses | Change needed |
|---|---|---|---|
| 1 | `~/.pi/agent/extensions/memory` → `~/Projects/Terminal/rl-pi-extensions/extensions/memory` | the symlink Pi loads | **This link already points at the new component.** On this machine the switch is not a link swap: `/reload` (or a restart) makes v2 live. To keep the old component running while the new one is reviewed, point the link at a checkout of the old code (`git stash`, or `git worktree add ../memory-v1 HEAD -- extensions/memory` then link that path) and reload. Rollback afterwards is the reverse. |
| 2 | `~/Projects/Terminal/rl-pi-extensions/AGENTS.md` (lines 82–87 quote block, § 4) | names `memory_write`, `memory_show`, `memory_search`, `memory_doctor`, `pending` claims, the write-time gate | updated with this change: the names are now `memory_log` / `memory_propose` / `memory_read` / `memory_list` / `memory_search` / `memory_archive`, and `/memory doctor` |
| 3 | `~/Projects/Github/pi-extensions/pi-extensions/memory/README.md` | documents the old write names for the *other* memory component | leave alone if that component stays installed; if it is retired, delete or annotate the README so it cannot be read as current |
| 4 | `~/.pi/agent/_extensions/memory/` (May 2026: `qmd-search.ts`, `search.ts`) | an old memory component, not loaded by Pi (Pi loads `~/.pi/agent/extensions/`) | no action; it is not a caller. Archive or delete at leisure |
| 5 | `~/.pi/agent/extensions-disabled/memory/` | the same old component, disabled | no action |
| 6 | `~/Projects/Swift/money_manager/AGENTS.md` | grep for `memory`, `memory_*`, `/memory` finds nothing | no action |
| 7 | `~/.pi/agent/snippets/`, prompt templates, skills | no snippet, template or skill references a memory tool; no `/morning`, `plan-day`, `briefing` or EOD command exists under `~/.pi/agent` | no action. If such commands live elsewhere, they need the rename table in `README.md` before cutover |

## Bank state the migration will meet

Checked read-only in `~/.pi/memory/`:

- `knowledge/` — 22 legacy files (`git-standards.md`, `macos.md`, `ledger.md`,
  `identity.md`, `assistant-conduct.md`, …): the rules and facts waves.
- `core/activeProjects.md`, `core/dailyContext.md` — working state: their open
  items become daily-log items, not claims.
- `claims/rules/`, `claims/facts/` — **empty**: nothing has been approved yet, so
  the first injection after cutover is empty until the migration is reviewed.
- `history/daily/`, `archive/`, `metrics/` — present; `archive/` and `metrics/`
  are empty.
- Expected plan: 22 `knowledge/` files plus 2 `core/` files, waves
  `rules → facts:<domain> → daily`.

## Baseline: measured, from the real session files

`/memory trial baseline` with `--sessions-dir ~/.pi/agent/sessions`, run 2026-10-17
(read-only; nothing was written):

| `--marker` | median tokens / user turn | samples | range |
|---|---|---|---|
| `# Memory Bank Context` (the spec's default — the *other* component) | **880** | 159 | 2026-10-04 → 2026-10-14 |
| `## Memory — authoritative for this context` (the component being replaced here) | **512** | 74 | 2026-10-14 → 2026-10-17 |

Pick the marker of the extension actually being replaced. Against 512 the trial's
go bar (R45) is a median of **≤ 128 tokens per turn** with zero stale/rival flags;
against 880 it is ≤ 220. Record the chosen one with:

```
/memory trial baseline --days 14 --marker "## Memory — authoritative for this context"
```

## Steps, in order (spec R40)

1. Make every change above (rows 1–3 are the only ones needing action).
2. Remove by hand any `~/.pi/agent/extensions/memory` link the picker did not
   create — row 1 says what is there now.
3. Enable `memory` in the rl-extensions picker.
4. `/memory migrate backup` → `/memory migrate plan` → `/memory migrate draft`
   wave by wave → `/memory review --wave migration`.
5. Trial for a week (`/memory trial`), then `/memory migrate cutover` — the
   sources move to the read-only archive, never deleted.
6. Rollback: remove the link, restore the old one.
