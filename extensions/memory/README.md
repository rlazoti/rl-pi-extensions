# memory

An entry-keyed memory bank for [pi](https://github.com/earendil-works/pi-coding-agent): one keyed claim per assertion, one authoritative claim per context, and a write that would create a second claim on the same assertion is **refused until a human decides** which one stands.

It replaces the usual "memory" arrangement — append a bullet to a prose block, inject the whole block, hope the model reconciles it — with a store that can be queried, adjudicated and audited.

## Why this exists

The bank this component replaced had three files, each asserting something about the UI background, each written months apart. All three were injected every turn. They produced the same prompt fragment, so **the model could not see that it was being handed a contradiction**, let alone resolve it. Nothing in the arrangement made one of those claims the authority, and nothing recorded which claim replaced which.

The invariant this component enforces:

> For every **assertion key**, exactly one **active** entry per **scope** can ever reach the model — enforced at write time, verified at read time, auditable across time.

Three parts make that hold: `schema.ts` makes identity computable, `resolver.ts` enforces it on the read path, and `gate.ts` makes a rival unenterable on the write path. Recall (`inject.ts`) picks candidates; **the resolver picks truth**.

## Requirements and enable

- pi (interactive, print, json and rpc modes are all supported — dialogs only in interactive).
- The bank: `~/.pi/memory` (override with `PI_MEMORY_DIR`). Never one file per claim — that shape is what makes collisions structurally inevitable.
- One runtime dependency of its own: **`minimatch`**, for `path:` scopes. Glob edge cases (dotfile paths, `**` crossing segments, `!`/`#`) misclassify a scope silently, which is exactly the failure class this component exists to remove.
- Enabled with `/rl-extensions` (it creates the symlink at `~/.pi/agent/extensions/memory`). If a **real directory** named `memory` is found there — another memory extension — this one registers nothing and says why at `session_start`: two injectors and two `memory_*` tool sets make the prompt unreproducible.

## What you get

| Surface | What it does |
|---|---|
| `memory_write` | Add or amend an entry. Clean write, amendment in place, or refusal with a `conflictId`. |
| `memory_show` | Every claim for one key: which is authoritative *here*, which are retired, which are shadowed by a narrower scope, and whether the key is contested (reported as an error, not as an answer). |
| `memory_search` | Ranked **candidates**, explicitly labelled as not answers. |
| `memory_doctor` | Entries by status, malformed entries, contested identities, headings that are not keys, unreadable files, empty stores, unanswered conflicts, daily-file freshness. `isError` when anything is wrong. |
| `/memory` | `doctor` \| `pending` \| `resolve <id>` \| `show <key>` \| `files` \| `daily` |
| `before_agent_start` | Injects the authorities that apply to this prompt and context, plus any unanswered conflict. Silent — no message, no tokens — when there is nothing to say. |

### What lands in the prompt

```markdown
## Memory — authoritative for this context (project: memory)
- [rule · global · 2026-10-14] pi-extension-runtime.one-dialog-slot: …
- [preference · project:.terminal · 2026-09-30] dotfiles.tmux-status-bar: …

Not injected this turn (token budget): ui.background, git.push.
Shadowed by a more specific scope: dotfiles.tmux-status-bar (out-of-scope).
```

- Recall is **BM25** over entries (`k1 = 1.2`, `b = 0.75`, key/heading terms ×3), with query terms treated as a set and `kind`/`scope`/`status` values never scored — so the words `rule`, `global` and `active` cannot drag an unrelated entry into your prompt. Measured with `scripts/bench-recall.mjs`: ~0.1 ms at 22 entries, 0.5 ms at 1 000, 2.6 ms at 5 000. That is why there is no search dependency and no on-disk index; corpus statistics are memoised against the store object, so there is no invalidation rule to get wrong.
- Budget: **900 tokens** of entry content by default (`tokens = ceil(chars / 4)`, an estimate, stated as one), with per-kind caps (`rule` 260, `procedure`/`decision`/`preference` 160, `gotcha` 140, `fact` 120) so a pile of facts cannot crowd out a rule. Entries that do not fit are **skipped, never truncated** — a truncated rule is a new rule — and named, so a missing memory is visible rather than silently absent.
- A hit on a **stale** claim is answered with the claim that replaced it, not with the dead rule; a claim that lost to a narrower scope is reported as shadowed rather than dropped. Nothing is discarded on the way to the prompt without being named.
- Presentation is canonical: kind, then key. Retrieval order decides what is *considered*, never what the model reads first, so output is byte-identical for a given store + query + context. Lines carry the fields that actually decided (`kind · scope · asOf`) and never a score.

## The bank on disk

```text
~/.pi/memory/
├── knowledge/*.md        entry stores — the authority surface
├── core/dailyContext.md  the day's working file (see Daily rollover)
├── history/daily/        archived daily files, never overwritten
└── .pending/*.json       unanswered conflicts
```

An entry is a `##` heading whose text is the **assertion key** (`^[a-z0-9][a-z0-9._-]*$`), followed by metadata lines and a body:

```markdown
# UI

## ui.background                        ← key: identity, not prose
- kind: preference                      ← rule | preference | decision | fact | procedure | gotcha
- scope: global                         ← global | project:<name> | path:<glob>
- asOf: 2026-10-02                      ← when the claim became true; never invented
- source: PR review rl-pi-extensions    ← who said it, where
- status: active                        ← active | superseded | withdrawn
Use dark grey for the UI background.

## ui.background@2026-06-14             ← revision suffix: same key, same identity
- kind: preference
- scope: global
- asOf: 2026-06-14
- status: superseded
- supersededBy: knowledge/ui.md#ui.background
- supersedes: knowledge/palette.md#ui.background@2026-05-01
Use navy for the UI background.
```

Identity is **key + scope** (the revision suffix is ignored). One topic file holding an active entry plus its supersede chain is the healthy shape. References are qualified `path#heading`, because two files can hold the same heading — that collision is part of what broke the old bank — and an ambiguous one is reported, not guessed.

**Identity- and authority-bearing fields are never silently normalized:**

| Field | Bad value → | Why |
|---|---|---|
| `key` | error `bad-key`, not injectable | a heading that isn't a key cannot be compared for conflicts |
| `scope` | error `bad-scope` — `host:work` does **not** become `global` | defaulting would silently merge two scopes |
| `status` | error `bad-status` | a typo must not resurrect a retired rule |
| `asOf` | error if malformed; **warning** if missing (sorts last) | a wrong date silently outranks a real one |
| `kind`, `source` | warning | annotation only |

Parsing never throws: a corrupt file still yields a report the doctor and the migration can act on, unknown fields are preserved verbatim, and a malformed sibling does **not** make a clean claim look duplicated.

## How a winner is chosen

Two gates, because an identity-level gate alone is not enough:

1. **Within one identity (key + scope).** Stale and malformed entries never surface. If the store genuinely holds two well-formed active claims on one identity, that identity **fails closed**: nothing is injected for it, and it is reported as a conflict for a human. Guessing the newest one would reproduce the ambiguity this component exists to remove — the top-ranked claim travels with the report as `bestCandidate`, a suggestion, never an answer.
2. **Across scopes for one key.** A `project:` or `path:` rule *shadows* the `global` default, so one question gets one answer for this context rather than a rule plus an override the model has to referee. Non-applicable scopes are reported `out-of-scope`, never dropped.

`compareAuthority` is total and deterministic — no similarity term appears in it:

1. scope specificity: `project` > `path` > `global`
2. `asOf` descending (an explicit date always beats a missing one)
3. key ascending, then heading ascending — independent of scan order

Nothing is dropped on the way to the prompt without a reason: a suppressed candidate is reported with the real cause (`superseded`, `withdrawn`, `invalid`, `conflict`, `unkeyed`). `resolveKey(key, context)` answers "what is the authority for this key *here*?" and reports everything it shadowed or excluded, so "why wasn't my note used?" is answerable from data.

## Conflicts: what happens, and how to answer

A write **amends in place** when its heading matches an entry in the target file — ordinary authoring, never gated. It is a **conflict** when the heading differs while `key` + `scope` match and a live claim exists in this file **or any other**; the check is store-wide. Rewording what you own is authoring; adding a second claim on one assertion is the act that breaks a memory bank, and that is what gets gated. An incoming entry whose own `status` is not `active` asserts nothing and cannot contest anything.

On a conflict: **nothing is written**, the refusal carries a `conflictId` derived from the identity, the live claims and the incoming text, and resolution is a second, explicit call carrying that id. If the store moved on in between, the id no longer matches and the write is refused again rather than applied to a state nobody reviewed.

| Resolve | Effect (and the provenance it writes) |
|---|---|
| `supersede` | incoming wins; rivals become `status: superseded` with `supersedes`/`supersededBy` — rewritten in **every file holding a rival**, applied together |
| `merge` | needs `mergedBody`; one claim replaces both, rivals superseded |
| `withdraw` | neither side asserts anything; `status: withdrawn`, `withdrawnOn` |
| `keep-both-flagged` | both stay live and the identity **goes dark** — nothing is injected for it — with `contestedWith` recorded and the doctor reporting it |
| `discard` | incoming dropped; nothing changes on disk |

`+ note` on any of them is recorded as `resolution:` provenance — how a contest was settled and why.

**In the terminal** the human is asked inside the same call, and the dialog opens with the whole contest — what the bank says now, what is being written, and the rule that refused it — before the five resolutions, each labelled with what it does. `merge` shows both claims while you type the replacement. The same rendering backs `/memory pending`, the tool result and the per-turn notice, so no surface is better informed than another.

**No timer.** A dialog that needs your decision waits as long as you need. Esc, or cancelling the tool call, says "not now".

**The contest is parked before the question is asked** (`~/.pi/memory/.pending/`), because the question can be lost: you step away, another extension's dialog takes the slot, the call is cancelled, the session ends. Answering clears the entry; everything else leaves it, and it is surfaced every turn until answered. A malformed answer is the opposite case — the question *was* answered — so the entry is cleared and the caller is told what was missing.

**One question at a time.** pi gives extensions a single dialog slot. A second `ui.select` displaces the first and can leave its caller awaiting a dialog nobody can see, so a second concurrent conflict is parked and reported instead of asked. Every dialog carries the tool call's abort signal, so cancelling the call closes the dialog rather than stranding it.

**Without a UI** (`pi -p`, json, rpc) the refusal is parked and the caller is told how to answer it: re-invoke with `resolve` + `conflictId`, or run `/memory resolve <id> --resolve=<…>` — which prints the full contest first, because choosing a resolution blind is not choosing. The refusal tells the agent not to retry the write and not to pick a winner.

## Daily rollover

At `session_start` (and via `/memory daily`, or `scripts/daily-rollover.mjs --force`) a `core/dailyContext.md` from an earlier day is archived to `history/daily/<YYYY-MM>/<date>-dailyContext.md` — byte-identical, never overwritten — and today's file is started with the open work carried forward. What was carried, what was not, and why are reported; a stale daily file is injected as a caveat rather than handed over as current fact.

```markdown
# Daily Context — 2026-10-16

- date: 2026-10-16
- carried from: 2026-10-15

## In Progress

### <project or origin grouping> — <source heading>

_(carried from 2026-10-15 — 1 day old)_

- (2026-10-15) verify the simulator build

## Completed

## Key Decisions

## Notes
```

- The `- date:` field is authoritative; an undated file is dated from its modification time and **labelled as inferred**, and the missing field is reported. A missing date is never a reason to do nothing.
- Open work is recognised by meaning (`Next Steps`, `In Progress`, `Handoff`, `Blocked`, `Todo`…), not by exact heading match, and settled work is reported rather than carried — durable things belong in `knowledge/`.
- **Items carry their own date** (`- (2026-10-15) …`). An undated item is stamped with the day *the file claims*, never today: dating Monday's intention on Tuesday launders it into fresh work.
- Ageing is per item: past `retireAfterDays` (default **21**) an item stops being carried, and a per-section cap (default **30**, newest survive) bounds a runaway list. **Undated items are never retired** — unknown age is not grounds to drop work. Every drop is counted in the notice and remains in the archive.
- The shape above is a contract: other tools (including pi's own memory tools) append under those top-level headings, so a format only the rollover can read would make the day's work unreadable to whatever writes it.

## Configuration

| Setting | Where | Default |
|---|---|---|
| Bank root | `PI_MEMORY_DIR` | `~/.pi/memory` |
| Extensions dir | `PI_CODING_AGENT_DIR` / `HOME` | `~/.pi/agent/extensions` |
| Injection budget | `inject(store, { budget })` | 900 tokens of entry content |
| Ageing | `rollDaily({ retireAfterDays, maxItems })` | 21 days, 30 items per section |

The ageing knobs are **module parameters, not settings**: the extension calls `rollDaily()` with no options, so retuning them means editing the defaults in `dailyItems.ts`. They are deliberately not a settings file until observed rollovers say what they should be.

## Module map

`implementation.ts` is an adapter — tools, the command, the hook, the dialogs — that decides nothing about memory beyond *who can be asked* and *whether to load at all*. `service.ts` holds the behaviour without pi types.

| Module | Role |
|---|---|
| `schema.ts` | entry grammar, validation that never silently defaults, `compareAuthority`, render↔parse idempotence |
| `markdown.ts` | one parser shared by the migration and the rollover (two parsers is how one format grows two meanings) |
| `resolver.ts` | the two gates, authority plan, shadowing, violation reporting |
| `gate.ts` | `decide(store, request)` — the only way an entry gets in; pure, no clock, no fs |
| `inject.ts` | BM25 recall, budget, canonical text |
| `fs-store.ts` | bank paths, atomic write-beside-then-rename, the collision guard |
| `pending.ts` | the conflict queue (JSON, because it must replay to the gate verbatim) and `formatContest` |
| `dailyItems.ts` / `rollover.ts` | item grammar, stamping, ageing; archive + reported carry |
| `migrate.ts` | prose → entries: proposals, cues, and what gets skipped |
| `service.ts` | use cases over all of it |

Scripts: `scripts/migrate-report.mjs` (dry run, one proposal per line), `scripts/migrate-apply.mjs` (`--only id,id`), `scripts/daily-rollover.mjs` (`--force` for a file whose mtime is today while its content is not — a human says so, the code never infers it), `scripts/bench-recall.mjs`.

## Limits, and what this deliberately is not

- **Not semantic search, and not a conflict detector for paraphrase.** Two claims about the same thing under different keys are two entries; the gate cannot see them as rivals. Keys are how you tell it what a claim is *about*.
- **No embeddings, no re-ranking, no auto-merge.** A similarity threshold is the same guess as an LLM "reconciling" the text — the old bank's three files produced an identical snippet, so nothing downstream could even see the contradiction.
- **The model never resolves a conflict.** It is told the identity is contested and to ask you.
- **Daily items written by other tools arrive undated** and get their date at the next session start, so their age is one day coarse. Closing that means owning the daily append path or agreeing the item grammar with whatever writes it.
- **Migration is a judgement call, made visible rather than automatic.** It proposes, the gate simulates each proposal, and `scripts/migrate-apply.mjs --only <id>` applies the ones you choose. The live bank's prose migration is done (23 claims, run 2026-10-14; the run log is in the CHANGELOG, not here).
- `asOf` is never defaulted, by anyone. A claim without a date sorts last and says so.

## Testing

245 colocated tests (`npm test` discovers them recursively). The load-bearing ones: parse↔render byte-idempotence with nothing dropped; authority total-order and four invariant sweeps over 200 generated stores; injection determinism and per-kind budgets; the gate's rival check across files, and a resolution applying only to the state its `conflictId` was derived from; the queue replaying to the same `conflictId`; the rollover round trip (a file the rollover wrote is understood by the next rollover); atomic writes with no temp-file leftovers and no path escape; and the Pi adapter driven through pi's own surface — dialog content, no timer, one dialog at a time, cancelled tool calls parking rather than hanging.

## History and rollback

Shipped in **v1.4.0**. It replaced the standalone memory extension: the old one is parked at `~/.pi/agent/extensions-disabled/memory`, and this one is a symlink. Roll back with `rm ~/.pi/agent/extensions/memory && mv ~/.pi/agent/extensions-disabled/memory ~/.pi/agent/extensions/memory`. The bank backup from before the content migration is `~/.pi/backups/memory-2026-10-14T19-14-41.tar.gz`.

## License

[MIT](../../LICENSE)
