# memory — entry-keyed memory bank with a conflict gate

**Status: Phase 1 of 6. Not enabled, registers nothing.** The directory is listed
in the picker catalog so it stays manageable, but `implementation.ts` registers
no tools, commands, or hooks, and it is not symlinked into
`~/.pi/agent/extensions`. The memory bank you are actually using is still the
standalone `memory` extension at `~/.pi/agent/extensions/memory` (a plain
directory, not a symlink — see § Cutover).

## Why this exists

Knowledge files retrieved by similarity cannot settle disagreements between
themselves. Measured with the old extension's exact index config, three files
claiming different UI background colors score `14.40 / 14.40 / 14.30` — the
conflict is invisible to ranking, and `limit: 3` then injects **all three**, so
which policy the agent follows depends on the user's phrasing that turn. No
embedding model, re-ranker, or limit tuning fixes this: the fact "which claim is
current" is not in the text, it is a relationship between files.

So retrieval stops arbitrating. Claims get identity, and identity gets a gate.

## The invariant

> For every **assertion key**, exactly one **active** entry per **scope** can
> ever reach the model — enforced at write time, verified at read time,
> auditable across time.

`schema.ts` (Phase 1) is the foundation: it makes identity computable.

## Store layout and entry schema

The **topic file** is the authority surface; the **entry** is the unit of
indexing, injection, precedence, and diffing. Never one file per claim — that is
what made the collision above structurally inevitable.

```markdown
<!-- knowledge/ui.md -->
# UI

## ui.background                          ← assertion key: identity, not prose
- kind: preference                        ← rule | preference | decision | fact | procedure | gotcha
- scope: global                           ← global | project:<name> | path:<glob>
- asOf: 2026-10-02                        ← required for tie-breaks; never invented
- source: PR review rl-pi-extensions      ← who/when/where
- status: active                          ← active | superseded | withdrawn
Use dark grey for the UI background.

## ui.background@2026-06-14               ← revision suffix; same key, same identity
- kind: preference
- scope: global
- asOf: 2026-06-14
- source: Slack
- status: superseded
- supersedes: ui.background@2026-05-01
Use navy for the UI background.
```

Identity = **key + scope**, revision suffix ignored. One topic file holding an
active entry plus its supersede chain is the normal, healthy shape.

**Validation rule: identity- and authority-bearing fields are never silently
normalized.**

| Field | Bad value → | Why |
|---|---|---|
| `key` | **error** `bad-key`, entry not injectable | a heading that isn't a key cannot be compared for conflicts |
| `scope` | **error** `bad-scope`; `host:work` does **not** become `global` | defaulting would silently merge two different scopes |
| `status` | **error** `bad-status` | a typo in `status` must not resurrect a retired rule |
| `asOf` | **error** `bad-asOf`; missing → warning, sorts last | a wrong date silently outranks a real one |
| `kind` | warning, defaults to `fact` | annotation only |
| `source` | warning | annotation only |

`parseTopicFile` never throws: a corrupt file still yields a report the doctor
and the migration can act on. Unknown fields are kept verbatim with a warning.
Two `active` entries on one identity in the same file are flagged
`duplicate-identity` (error) on **both** sides, and both become non-injectable.

## Authority order (`compareAuthority`)

A total, deterministic order — no similarity term appears in it:

1. **scope specificity** — `project` > `path` > `global` (a project rule is more
   specific than a global one, so a stale global rule cannot beat a deliberate
   local override)
2. **`asOf` descending** — an explicit date always beats a missing one
3. **key ascending, then heading ascending** — makes the result independent of
   input order, which is what makes golden-file injection tests possible

## Conflict protocol (Phase 3)

The write tool is the admission gate, and it is two-phase so it works in every
Pi mode:

- `memory_write(file, key, body, meta)` → **clean:** writes, reindexes, returns
  the entry.
- → **conflict:** writes **nothing**, returns `CONFLICT key=… scope=…`, the
  existing body + `asOf` + `source`, the incoming body, and a `conflictId`.
- Re-invoke with `resolve:` `supersede` | `merge` | `withdraw` | `keep-both-flagged`.
  `keep-both-flagged` is the only escape hatch and leaves a permanent `doctor`
  violation.
- **In TUI mode the human is asked immediately**, while the context is fresh
  (`ctx.ui.select` for the resolution, `ctx.ui.input` for a one-line "why" that
  becomes the `source:` line). Dialogs support `{ signal, timeout }`; on
  dismiss/timeout/abort, or in `print`/`json`/`rpc`, the full diff is persisted
  to `~/.pi/memory/.pending/<conflictId>.md`.
- The queue is surfaced every turn (so the agent can act on it too), notified at
  `session_start`, and walked by `/memory resolve`.
- The human's choice is echoed in the tool result, so the transcript never
  disagrees with the store.

## Injection contract (Phase 4)

Candidate recall (MiniSearch BM25, kept as the one runtime dependency) → drop
`superseded`/`withdrawn` and error-flagged entries → resolve to one authority per
identity → inject **entries, not files**, under a per-kind token budget. Output
is byte-identical for a given store + prompt. The old `(score: 2176)` labels are
gone: they read as authority and measure nothing of the kind. Replaced by
`kind` / `scope` / `asOf`, which are what actually decides.

## Cutover hazards (Phase 5)

- `~/.pi/agent/extensions/memory` is a **real directory**, not a symlink, so the
  picker cannot disable it, and `enableExtension` correctly refuses to clobber
  it. Cutover is a manual move-aside, with a backup.
- Two memory extensions loaded at once means two injectors and duplicate tool
  names. The new extension carries a single-instance guard: detect another memory
  extension in the extensions dir, notify loudly, and stand down.
- Development never touches the live bank: nothing is symlinked while building,
  and validation runs under `PI_CODING_AGENT_DIR` + `PI_MEMORY_DIR` overrides.

## Build order

| Phase | Deliverable | Status |
|---|---|---|
| 1 | entry schema + tolerant topic-file parser + authority order | ✅ `schema.ts` |
| 2 | resolver: recall → one authority per identity | ⬜ |
| 3 | admission gate + conflict protocol + pending queue | ⬜ |
| 4 | injector (entry-level, deterministic, budgeted) | ⬜ |
| 5 | tools, `/memory` + `doctor` + `migrate`, single-instance guard | ⬜ |
| 6 | daily-rollover fixes (archive never fires, `Carried Forward` vs `Context for Tomorrow`) | ⬜ |

## Testing map

- `extensions/memory/schema.test.ts` (31): grammar and scope parsing; metadata
  vs body boundaries; fenced `##` is body; CRLF; unclosed fence; legacy prose
  headings flagged `bad-key`; defaults vs errors; unknown-field preservation;
  duplicate-identity in both directions (chain OK, two-actives not);
  `compareAuthority` specificity/recency/tie-break totality; render↔parse
  byte-idempotence; a pin that recency beats term density.
- `extensions/memory/index.test.ts` (1): the unfinished extension registers
  **nothing**, so it cannot compete with the live memory extension.
- Catalog pins in `tests/symlink-manager.test.ts` and count pins in
  `tests/picker.test.ts` now derive from the live catalog instead of a literal 5.

## Deliberate non-goals

Embeddings/qmd as a conflict fix (re-ranks indistinguishable text). Asking the
model to reconcile (it can't even see it: all three conflicting files produce the
identical snippet `# UI Background Color`). More BM25 knobs. One file per claim.
The legacy `knowledge/index.csv` trigger words.
