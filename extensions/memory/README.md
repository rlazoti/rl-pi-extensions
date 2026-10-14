# memory — entry-keyed memory bank with a conflict gate

**Status: Phases 1-5c of 6 — enabled and live.** Schema, resolver, admission gate,
injector, filesystem layer, pending queue, service layer and the Pi adapter are
done: four tools (`memory_write`, `memory_show`, `memory_search`, `memory_doctor`),
the `/memory` command, the per-turn injection hook and a single-instance guard.
Cutover happened on 2026-10-14: this directory is symlinked into
`~/.pi/agent/extensions/memory`, and the standalone extension it replaces is parked
at `~/.pi/agent/extensions-disabled/memory` (rename it back to roll back). The live
bank's `knowledge/` is an entry store — 23 claims, 0 violations, backup in
`~/.pi/backups`. Remaining: Phase 6, the daily-rollover fixes.

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

Resolution enforces it in two gates (`resolver.ts`), because an identity-level
gate alone is not enough:

1. **Within an identity (key + scope)** — stale (`superseded`/`withdrawn`) and
   malformed entries never surface. If the store is broken and holds two
   well-formed active claims on one identity, that identity **fails closed**:
   nothing is injected for it, and it is reported as a conflict for a human.
   Guessing the newest one would reproduce the exact ambiguity this extension
   exists to remove. The top-ranked claim travels with the report as
   `bestCandidate` — a suggestion to prefill the resolution, never an answer.
2. **Across scopes for one key** — a `project:` or `path:` rule *shadows* the
   `global` default for the same key, so one question gets one answer for the
   current context rather than a global rule plus an override the model has to
   referee. Non-applicable scopes are reported `out-of-scope`, never dropped.

`schema.ts` makes identity computable; `resolver.ts` makes it enforceable on the
read path; `gate.ts` makes a rival unenterable on the write path.

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
- supersededBy: knowledge/ui.md#ui.background
- supersedes: knowledge/palette.md#ui.background@2026-05-01
Use navy for the UI background.
```

Identity = **key + scope**, revision suffix ignored. One topic file holding an
active entry plus its supersede chain is the normal, healthy shape.

`supersedes:` / `supersededBy:` references are qualified `path#heading`, because
two topic files can hold the same heading — that collision is part of what broke
the appearance store, so an unqualified reference is only resolvable when it is
unique (otherwise the resolver reports `ambiguous-supersedes`).

**Provenance fields, written by the gate and never remembered by anyone:**

| Field | Written when |
|---|---|
| `supersedes` | an accepted claim replaced other claims |
| `supersededBy` | a claim was replaced; points at what took over |
| `amendedFrom` | an entry's text was rewritten and its `asOf` moved |
| `withdrawnOn` | a contest ended with nobody asserting anything |
| `resolution` | how a conflict was settled, plus the one-line "why" |
| `contestedWith` | `keep-both-flagged`: what it is contested with |

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
Two well-formed `active` entries on one identity in the same file are flagged
`duplicate-identity` (error) on **both** sides. A malformed sibling does **not**
trigger that flag: a typo in one entry must not silence a clean claim by making
it look duplicated.

## Authority order (`compareAuthority`)

A total, deterministic order — no similarity term appears in it:

1. **scope specificity** — `project` > `path` > `global` (exercised at Gate 2: an
   entry's own identity always has a fixed scope)
2. **`asOf` descending** — an explicit date always beats a missing one
3. **key ascending, then heading ascending** — the result is independent of scan
   order, which is what makes golden-file injection tests possible

`resolveKey(key, context)` answers "what is the authority for this key *here*?"
and reports everything it shadowed or excluded, so "why wasn't my note used?" is
answerable from data rather than vibes.

## Injection plan (`planInjection`)

Candidates in (any retrieval order) → plan out:

- `inject` — at most one entry per assertion key, in retrieval order.
- `redirectedFrom` — a hit on a **stale** claim is answered with the authority
  that replaced it, instead of going silent or quoting the dead rule.
- `suppressed` — nothing was injectable for that candidate, with the real reason
  (`superseded` / `withdrawn` / `invalid` / `conflict` / `unkeyed`).
- `shadowed` — a real authority that lost to a more specific scope, or fell
  outside the context. Recorded, never silently discarded.
- `conflicts` — identities needing a human, each carrying its `bestCandidate`.

Scope matching is **minimatch** with the options pinned so a scope behaves as a
matcher and not an ignore file: `dot: true` (paths under `.github/` must not fail
silently), `nonegate`, `nocomment`, case-sensitive. Worth knowing: `src/ui/**`
matches paths *under* `src/ui/` but not the bare `src/ui`; `src/**/x.ts` matches
at any depth including zero; there is no implicit leading `**` (`*.ts` does not
match `src/a.ts`).

## Injection (Phase 4): recall, budget, text

`inject(store, { query, context, budget })` → `{ text, injected, redirected, conflicts, dropped, outOfScope, entryTokens, tokens }`. Still pure: no fs, no clock, no pi — `implementation.ts` is the hook that calls it.

**Retrieval picks candidates; the resolver picks truth.** Recall never decides
what is correct, and it deliberately keeps stale claims as candidates — a hit on
a superseded rule must still reach the model, as the rule that replaced it. A
contested identity is reported even when recall only found one side, because
authority is a property of the store, not of what retrieval happened to surface.

**Recall is BM25 over entries** (`recall`), with the parameters pinned rather than
tuned per query: `k1 = 1.2`, `b = 0.75`, heading/key terms weighted ×3. Query
terms are a **set** — repeating a word in a prompt must not make an entry look
more relevant. `kind`/`scope`/`status` values are **not** scored, so the words
`rule`, `global` and `active` cannot drag an unrelated entry into the prompt. No
stemming: a wrong stem is invisible in the output.

**The index decision, made with numbers instead of vibes** (`scripts/bench-recall.mjs`):

| Entries | Recall per turn |
|---|---|
| 22 (this bank today) | ~0.1 ms |
| 200 | 0.09 ms |
| 1 000 | 0.50 ms |
| 5 000 | 2.6 ms |

So: **no search dependency and no on-disk index.** Corpus statistics are memoised
in a `WeakMap` keyed by the store object — a new store is a new key, so there is
no invalidation rule to get wrong and no stale index to blame later. That is the
whole trade: 8–14× faster than a cold scan, at zero staleness risk. MiniSearch
(the live extension's choice) buys nothing at this size, and qmd's hybrid search
(1–2 s) is already known too slow for per-turn injection — the live extension
uses it only for explicit `memory_search` calls for exactly that reason.

**Budget.** `tokens = ceil(chars / 4)`, stated as an estimate, never a real
tokenizer. Default 900 tokens of entry content, with per-kind caps (`rule` 260,
`procedure`/`decision`/`preference` 160, `gotcha` 140, `fact` 120) so a pile of
facts cannot crowd out a rule. Entries that do not fit are **skipped, not
truncated** — a truncated rule is a new rule — and named in the text ("Not
injected this turn (token budget): …") so a missing memory is visible instead of
silently absent. Selection keeps looking after a skip, so one long rule cannot
delete everything behind it.

**Presentation is canonical: kind, then key.** Retrieval order decides what is
*considered*; it never decides the order the model reads them in, so a scorer
tweak cannot reshuffle the prompt. Output is byte-identical for a given store +
query + context. Each line carries the fields that actually decided — `kind ·
scope · asOf` — and never a score; the old `(score: 2176)` label read as authority
and measured nothing of the kind. A contested identity renders as an explicit
"ask the human, do not pick one" line rather than a silent hole.

## Dependencies

Justified against AGENTS.md §6:

- **`minimatch`** (runtime, used today) — path-scope matching. Glob edge cases
  (dotfile paths, `**` crossing segments, `!`/`#` characters) misclassify a
  scope *silently*, which is the exact failure class this component exists to
  remove; a hand-rolled matcher would be surface to defend rather than a
  smaller one. The option choices are pinned by tests, not just the happy path.
- **No retrieval dependency.** Recall is ~40 lines of BM25 over entries, memoised
  against the store object; measured cost is 0.1 ms at this bank's size and 2.6 ms
  at 5 000 entries (`scripts/bench-recall.mjs`). MiniSearch would be a second
  memory implementation to keep straight for no measured gain; qmd is an external
  binary at 1–2 s, already too slow for per-turn injection in the live extension.

## Write path: the admission gate

`decide(store, request)` is the only way an entry gets into the store. It is pure
— it takes parsed topic files and returns rendered file contents; it never writes
and never reads a clock, because a hidden clock makes every write test
unreproducible and invents provenance. It returns one of:

| Result | Meaning |
|---|---|
| `plan` | The file contents to write. Nothing is written before this exists. |
| `unchanged` | Same heading, same text: no write, no churn. |
| `conflict` | A rival live claim exists. **Nothing was written.** |
| `discarded` | `resolve: "discard"`: nothing written, the rival stands. |
| `reject` | The request itself is malformed: bad path, no `asOf`, unknown `resolve`, stale `conflictId`. |

**What counts as a rival.** If the incoming heading matches an entry in the
target file, the write **amends it in place** — ordinary authoring, never gated.
If it differs while `key` + `scope` match and a live claim already exists — in
this file **or any other** — it is a **conflict** and is refused. Rewording what
you own is authoring; adding a second claim on one assertion is the act that
broke the appearance store, and that is what gets gated. The check is across the
whole store, not per file: three files each holding `ui.background` is one
identity with three claims. An incoming entry whose own `status` is not `active`
(a tombstone, a migration record) asserts nothing and cannot contest anything.

**Resolving is a second, explicit call.** The refusal carries a `conflictId`
derived from the identity, the live claims and the incoming text, and the second
call must carry it. If the store moved on in between, the id no longer matches and
the write is refused again rather than applied to a state nobody reviewed. A
resolution never executes inside a write.

```
resolve: "supersede"          incoming wins; rivals become status: superseded
resolve: "merge"              needs mergedBody; rivals become superseded
resolve: "withdraw"           both sides stop asserting; status: withdrawn, nothing new
resolve: "keep-both-flagged"  both stay live: the identity goes dark (the read path
                              returns nothing for it) and the doctor reports it
resolve: "discard"            incoming is dropped; nothing changes on disk
+ conflictId                  required, and must match the state you were shown
+ note                        one line of "why", recorded as `resolution:` provenance
```

`supersede` rewrites **every file holding a rival**, so tombstones stay where the
claims they retire live — one write per affected file, applied together.

**The dialog sits on top of this, not inside it** (implemented in
`implementation.ts`). The refusal already carries everything a dialog needs —
incoming versus candidate bodies, `asOf`, `source`, and a suggestion — so the ask
is a UI over the refusal, and the gate's contract is identical in every Pi mode:
a human answer becomes a second `decide` call with `resolve` + `conflictId`; a
dismissal, a timeout or no UI at all parks the refusal in the pending queue.

## Component API

### `schema.ts`

| Export | Purpose |
|---|---|
| `parseTopicFile(text, path)` | Text → `TopicFile`: title, entries, parse issues. Never throws. |
| `renderTopicFile(file)` / `renderEntry(entry)` | Canonical rendering: fixed field order, unknown fields preserved verbatim, malformed scopes re-emitted unchanged (a report must not launder the field under investigation). |
| `parseScope(raw)` / `scopeKey(scope)` / `scopeRank(scope)` | Scope grammar (`global` \| `project:<name>` \| `path:<glob>`), comparable identity key, specificity rank. Invalid scopes never fall back to `global`. |
| `compareAuthority(a, b)` | Total order: specificity → recency → key → heading. No similarity term. |
| `identityOf(entry)` | `key + NUL + scopeKey` — the identity every gate compares. |
| `isEntryStatus` / `isEntryKind` / `isAssertionKey` / `splitRevision` | Schema predicates — the same ones the write gate uses, so accept/reject cannot drift from the parser. |
| `parseRefs(value)` / `isSupersedeRef(ref)` | Split and validate `supersedes:` references (`heading`, `heading@date`, `path#heading`). |

### `resolver.ts`

| Export | Purpose |
|---|---|
| `buildStore(files)` | Parse results → indexed store: entries by identity and by key, parsed files **by path** (the gate needs to rewrite a rival's home file), plus violations. |
| `resolveIdentity(store, identity)` | Gate 1: one authority per identity, or `ambiguous` with `bestCandidate`. |
| `resolveKey(store, key, context)` | Gate 2: the authority for a key in a context, with `shadowed` and `outOfScope` traces. |
| `rankAuthorities(entries, context)` | Gate 2 without store knowledge — for callers holding ad-hoc candidates. |
| `planInjection(store, candidates, context)` | The injection contract: injectable entries, redirects, suppressions, conflicts. |
| `globMatches(glob, path)` | Glob matcher with `**` support (posix semantics; no deps). |

### `inject.ts`

| Export | Purpose |
|---|---|
| `inject(store, { query, context, budget })` | Recall → resolver → budget → rendered prompt text, with everything not injected accounted for. |
| `recall(store, query, limit)` | BM25 candidates, deterministic order, stale claims kept so redirects can fire. |
| `tokenize` / `estimateTokens` | The scorer's tokenizer and the stated char/4 token estimate. |
| `DEFAULT_BUDGET` / `PRESENTATION_ORDER` | Token caps and the canonical kind-then-key presentation order. |

### `fs-store.ts`

| Export | Purpose |
|---|---|
| `memoryPaths(env)` | Where the bank is (`PI_MEMORY_DIR`, default `~/.pi/memory` — the live bank's location, because cutover replaces it rather than moving it) and where extensions live. |
| `loadKnowledgeStore(paths)` | Parse every `knowledge/*.md` into a store, with raw text and unreadable files reported. |
| `applyEdits(paths, edits)` | Write the gate's rendered bytes, temp-file + rename, refusing anything outside the bank. |
| `foreignMemoryExtension(paths)` | The single-instance guard's check. |

### `markdown.ts`

One section parser for the whole component — the migration and the rollover read the
same structure, and a second parser is how one format grows two meanings. Fenced
blocks are content, never structure; `sectionText` re-renders a section with
everything nested under it.

### `dailyItems.ts`

| Export | Purpose |
|---|---|
| `parseDailyItems` | Items and prose in a section body. An item is an unindented bullet; a deeper bullet belongs to the item above it. |
| `stampDailyItems` / `stampDailyFile` | Give undated items the day **the file** claims, never today — a rollover must not launder yesterday's intention into fresh work. `stampDailyFile` edits open sections in place and leaves everything else byte for byte. |
| `ageItems` | Retirement by age (default 21 days) and a per-section carry cap (default 30, newest survive). Undated items are never retired. |
| `pruneDailyBody` | Stamp + age + cap in one pass, returning the rewritten body **and** everything dropped, so the caller reports every loss. |

### `rollover.ts`

| Export | Purpose |
|---|---|
| `dailyDate` / `dailyFreshness` | What day a daily file claims to be (`- date:` field, then a heading date, then file mtime as labelled evidence), how old it is, and whether it needs a date field. |
| `planDailyRollover(file, today, { force })` | The archive path, the archive text (byte-identical), the fresh file, what was carried and with what age, and everything not carried with a reason. `force` is for a file whose mtime is today while its content is not — a human says so, the code never infers it. |
| `isOpenHeading` / `isSettledHeading` | Normalised alias sets, so carrying depends on meaning rather than on one exact heading. |
| `renderRolloverNotice` | The one-paragraph notice a session prints, including what did not make it. |

### `migrate.ts`

| Export | Purpose |
|---|---|
| `prepareMigrationStore(store, paths)` | Reduce the files being rewritten to their keyed entries, reporting the prose consumed and the claims preserved. |
| `proposeMigration(sources)` | Read prose `SourceFile[]`, return proposals + every skip with its reason. Deterministic, so a reviewed plan can be re-run and stays line-for-line the same. |
| `migrationRequests(report, accept?)` | Proposals expressed as gate `WriteRequest`s, tagged `migratedFrom: <file>#<heading>`. |
| `simulateMigration(store, requests)` | Fold them through `decide`; returns accepted / unchanged / refused / rejected / collided, the would-be file contents, and violations split by cause. |
| `renderMigrationReport(report)` | The human-facing plan: flags, skips, provenance folding, per-proposal "why". |

### `pending.ts` / `service.ts`

| Export | Purpose |
|---|---|
| `saveConflict` / `listConflicts` / `loadConflict` / `deleteConflict` | The queue of unanswered refusals, as JSON records that replay through the gate verbatim. |
| `renderConflict` | The human-facing view of one queued refusal. |
| `createService(paths, { ask, now })` | Write / resolveQueued / show / search / injection / doctor / pending, with no pi types. `ask` is how a human answers; without it, refusals are parked. |
| `collisionReport(paths)` | Load-time guard result. |

### `gate.ts`

| Export | Purpose |
|---|---|
| `decide(store, request)` | The admission gate: `plan` \| `unchanged` \| `conflict` \| `discarded` \| `reject`. |
| `WriteRequest` | `file, key, scope, kind, body, asOf` (required), `source, revision, status, fields, resolve, conflictId, mergedBody, note`. |
| `EditPlan` | `files[{path, content, changes[]}], summary, warnings[]`. The caller writes these contents verbatim. |
| `RESOLUTIONS` | `supersede, merge, withdraw, keep-both-flagged, discard`. |

## Pi surface (Phase 5a)

`implementation.ts` is an adapter: tools, the `/memory` command, the injection
hook — all delegating to `service.ts`, which holds the behaviour without pi types.
The adapter decides nothing about memory; its only two decisions are *who can be
asked* and *whether to load at all*.

| Surface | What it does |
|---|---|
| `memory_write` | The gate: clean write, amendment, or refusal with a `conflictId`. `promptGuidelines` teach the protocol — never invent `asOf`, never pick a winner yourself. |
| `memory_show` | Every claim for a key: which is authoritative here, which are retired, which are shadowed by a narrower scope, whether the key is contested (reported as an error, not as an answer). |
| `memory_search` | Ranked **candidates**, labelled as not answers. |
| `memory_doctor` | Entries by status, violations, contested identities, headings that are not keys, unreadable files, empty stores, unanswered conflicts. `isError` when anything is wrong. |
| `/memory` | `doctor \| pending \| resolve <id> \| show <key> \| files`. |
| `before_agent_start` | The `inject()` text for the prompt plus the pending-conflict notice. Silent — no message, no tokens — when there is nothing to say. |

**Asking.** With a dialog available, the human is asked inside the same call:
`ctx.ui.select` for the resolution, `ctx.ui.input` for merged text when the answer
is `merge`, and one line of "why" that becomes `resolution:` provenance. Dialogs
carry a 2-minute timeout and the abort signal, because a dialog nobody dismisses
must not hang a turn; timeout, dismiss and abort all park the refusal, which is
the same outcome as having no UI. In `print`/`json`/`rpc` the refusal is parked
and the caller is told how to answer it; `/memory resolve <id>` there requires an
explicit `--resolve=`, and a suggestion is never applied by default.

**The queue is surfaced every turn**, so the agent can raise an unanswered
conflict with the human, and `/memory pending` shows it on demand.

**Single-instance guard.** A real directory named `memory` in the extensions
directory is another memory extension (ours is enabled by symlink, so the two are
distinguishable). This factory then registers nothing and says why at
`session_start`: two injectors and two `memory_*` tool sets make the prompt
unreproducible and the tool names ambiguous. Observed in a real Pi session before
cutover, standing down correctly against the live standalone extension; the tools
work now that only one of them is loaded.

## Migration (Phase 5b): prose to entries

The old bank is prose, and its `##` headings are section titles rather than
assertions — so migration is a judgement call, and the job of this code is to
*propose* with every inference labelled. Nothing in `migrate.ts` writes.

Three rules:

1. **Nothing is dropped silently.** Skipped files and skipped sections are
   reported with the reason, so "why isn't my note in the store?" has an answer.
2. **Inferred provenance says it is inferred.** A date taken from a file's mtime
   is not a claim about when the claim became true; it is the best evidence
   available and the report prints it that way — because an `asOf` that looks
   authoritative decides authority.
3. **Every inference carries its cue**: `kind=rule from modal obligation: "Never"`,
   `the text says "this repo" but the repo is not named — set project:<name> by hand`.

What does **not** become an entry: paths outside `knowledge/` (core/ and history/
are working state and dated history); files that read as status snapshots (phases,
`COMPLETE`, branch names — that belongs in `core/activeProjects.md`, where
staleness is expected); headings that organise a document rather than assert
something, matched against the **whole** heading so `## Notes` is scaffolding while
`## Background colour` is a claim (a prefix match ate the latter in the first
draft); sections with no body; and `## Source`, which is folded into the entries'
`source:` field instead of becoming a claim about attribution.

**Keys** are `<file-topic>.<slug(heading)>`. Apostrophes are not word boundaries
(`Don't push` → `dont-push`, not `don-t-push`). Two headings slugging to one key are
reported as a collision for a human to name — never auto-renamed, because a
generated `-2` is a key nobody chose.

**Bullet-heavy sections are split into one entry per claim.** The asymmetry decides
it: an over-granular entry is visible, reviewable and mergeable later, while a
section holding four claims behind one heading makes the conflict gate blind — one
authority for four assertions, and a rival that touches any of them looks like an
amendment. Examples and definitions (`Example: …`, a short bullet built around a
code token) qualify the claim above them and are merged into it. Fenced code stays
with the block it documents. Each claim is judged on its own for `kind` and `scope`,
so a modal bullet becomes a rule and its descriptive neighbour stays a fact.

**Naming a split claim.** A key is an identity: it is what `memory_show` takes and
what provenance points at. So the name comes from the thing the claim is about —
usually an inline code token — then from the significant words with connectives
dropped, and otherwise from the position in the section (`claim-3`). The first forty
characters of a sentence are never a key: `smoke-test-recipe-cd` is a name a human
can rename, `a-missing-named-export-nope-from` is a fake that will be typed into a
tool by someone giving up.

**Two claims that read alike are flagged, because the gate cannot see them.** Sibling
claims with the same leading words get *different* keys, so they are not rivals by
identity and a bank quietly ends up with two versions of one rule drifting apart.
`similar-claim` is the net for that gap, and the report prints the family.

**A half-migrated bank is not re-mined.** A heading that is already an assertion key
is a migrated claim, not prose: its `- kind:` and `- asOf:` lines are metadata. Read
as bullet text they invent claims out of an entry's own fields — which is exactly
what a second dry run does if this check is missing. A keyed heading whose body is
*not* entry-shaped is reported as a broken entry instead of being migrated around.

**In-place rewrite consumes the prose** (`prepareMigrationStore`). The prose these
proposals came from is also sitting in the store as unkeyed headings, and the
renderer would serialize it back in entry shape — turning `## Applies to` into a
claim with a `kind:` field. For the files being migrated, unkeyed headings are the
*input* and are dropped; the file keeps its title. **Entries with real assertion keys
are preserved**: someone may have written a claim by hand in the same file, and a
migration that quietly deleted it would be the worst bug this component could have.
The report separates headings that became entries from prose that is not carried
over, so approving the plan means seeing exactly what disappears.

**A migrated claim that lands on a hand-written claim is stopped, not applied.** The
gate allows a write to amend an entry it already owns, and same key + same heading
looks exactly like that. A migration does not own the claim, so the collision guard
stops it before the gate sees it — the same rule that stops two prose sections from
overwriting each other, applied to the store's existing content.

**The dry run is the gate, not a preview of it.** `simulateMigration` folds the
proposals through `decide` against a store that grows as each write is accepted, so
the report answers the only question that matters — *would these writes be
admitted?* — and the rendered bytes come from the store's own renderer rather than a
serializer invented for migration day. Re-applying an applied plan stops as
collisions and rewrites nothing; re-reading a migrated file proposes nothing,
because everything in it is already an entry.

`scripts/migrate-report.mjs [--bank <dir>] [--out <file>] [--preview <dir>]
[--move "a => b"] [--no-split]` prints the plan for a real bank, and `--preview`
writes the **exact bytes** the gate would write into a scratch directory. Reading
the migrated file is the only review that counts: a table of proposals is a summary
of the decision, not the decision. There is no `--apply` flag on purpose — a report
script that can also overwrite your bank is a tool you will eventually run by habit.

**Decisions taken on 2026-10-14** (the first dry run of the live bank, before any of
this code existed): split bullet-heavy sections; replace the prose in place, with a
backup mandatory and rollback = restore; `knowledge/implementation-plan.md` is not
knowledge — move it to `core/`. **Current dry run**: 8 files read, 23 claims from 10
sections, 0 conflicts, 0 collisions, 0 rejected, no new store violations; 4 files and
9 sections skipped with reasons; 7 prose sections not carried over (3 structural, 4
folded into `source:`). **Still judgement calls**: nine `fact`-by-default kinds, two
sections that say "this repo" without naming it, and `git-standards.md` dated
2026-05-02 by mtime when the rule inside it is older.

## Applying (Phase 5b-2)

`scripts/migrate-apply.mjs --yes [--bank <dir>] [--move "a => b"] [--no-split]`.
Guardrails, in the order that matters:

- **No `--yes`, no write.** The report script is the review tool; this one is the
  write tool, and they are separate files so a review cannot become a write by
  adding a flag from memory.
- **A dirty plan is not applied at all.** Any collision, refusal or schema
  rejection aborts before the first byte: half-applying a migration is how a bank
  ends up with two accounts of itself.
- **The backup exists before the first write**, and the rollback command is printed
  before anything changes. If the backup fails, nothing is written.
- **Verification re-reads the bank from disk**, not the in-memory plan: entries,
  parse errors, store violations.
- **Moves are contained but not entry-shaped** (`resolveAnyInBank`): the entry-path
  rule (markdown, directly under `knowledge/`) guards writes to claims, while a
  decided file move crosses directories on purpose. Both refuse to leave the bank,
  and a move refuses an existing target rather than overwriting it.

Applied to the live bank on 2026-10-14: 23 claims from 10 sections across 5 files,
0 conflicts, 0 collisions, 0 rejected; `knowledge/implementation-plan.md` moved to
`core/`. Result: 23 entries in 5 stores, 0 parse errors, 0 store violations.
Backup `~/.pi/backups/memory-2026-10-14T19-14-41.tar.gz`; rollback is
`tar xzf <that file> -C ~/.pi/memory`. Re-running the dry run on the migrated bank
proposes **0** entries (everything is already an entry), which is the proof that the
migration is idempotent rather than merely finished. The live standalone extension
was left enabled and still reads the migrated bank — verified by real searches that
find migrated content by title — so the migration did not depend on the cutover.

## Daily rollover (Phase 6)

The daily working file (`core/dailyContext.md`) is the part of the bank that ages
fastest, and the shipped rollover was quietly broken in three ways, all silent:

1. **The archive never fired.** It read the date from an optional heading matching
   `YYYY-MM-DD`; the real file had none, so the code concluded it was current forever.
   Measured on the live bank: `history/daily/` held **zero archives since May**, while
   one daily file accumulated weeks of two projects under a title naming only one.
2. **Carry-forward was an exact heading match** (`Context for Tomorrow`). Every
   heading an agent actually writes — `Next Steps`, `In Progress`, `Handoff` — was
   dropped with no report.
3. **It wrote a shape agents do not use** (`## <date>` + `### Current Session`), so
   scaffolding and content drifted apart immediately.

The rules now: a **missing date is a defect to report**, never a reason to do nothing
(an undated file is normalised in one pass and gets a real `- date:` field); open work
is carried **by meaning** across a normalised set of aliases, with no prefix matching
(`Carried away from home` is not `Carried Forward`); settled work is **not** carried,
and the reason is stated — anything durable belongs in the entry store, which is what
the gate and authority machinery are for; an **unrecognised heading is named**, with
the alternatives offered, rather than dropped; **project grouping survives**, with
only the open parts of each project carried, which is what stops one project's title
from speaking for another; carried work shows **the day it came from** (`from
2026-10-03, 11 days old`), because an intention that is eleven days old should look
eleven days old; and an archive is written **byte for byte, never overwritten** — a
collision stops the rollover instead of rewriting a record.

It runs at `session_start` (with the notice surfaced in the UI), on demand via
`/memory daily`, and as an operator command via `scripts/daily-rollover.mjs`
(`--force` for the case no date check can see: content from earlier days, touched
today). A stale daily file is also injected as a standing caveat, so a model reading
a three-day-old intention is told it is three days old instead of being handed it as
current fact.

**Items carry their own day.** Carrying whole sections proved inadequate on the first
rehearsal: a `Next Steps` list is intentions written on different days, and a rollover
that cannot tell them apart either keeps all of them forever or drops all of them. Re-
running on the live bank carried 13 intentions, most already finished. So an open item
is written as:

```markdown
- (2026-10-11) verify the simulator build
```

An undated item is stamped with **the day the file claims, never today** — a rollover
running on Tuesday must not turn Monday's intention into fresh work by dating it
Tuesday. Stamping happens either while carrying or, when nothing rolled over, as a
separate pass over the open sections; it leaves settled work and prose byte for byte.
Ageing then applies per item: past `retireAfterDays` (default 21) an item stops being
carried, and a per-section cap (default 30, newest survive) bounds a runaway list. A
section whose items have all aged out is **not carried as an empty shell** — it is
dropped and reported with the counts — and prose under an open heading is carried even
without bullets, because "run the gate:" plus a command block is open work.
**Undated items are never retired** — an unknown age is not an excuse to drop work.
Everything dropped is counted in the rollover notice and stays in the archive.

The two defaults are conservative on purpose: retiring too early loses real work, so
the safe failure is keeping too much for one more cycle and saying so. They are
parameters on `planDailyRollover` / `ageItems`, not constants in behaviour.

**The rollover has to read its own output.** An early version wrote the annotation
*inside the heading* (`### Next Steps (from 2026-10-13, 11 days old)`), and the next
pass no longer recognised that as open work — the file went unreadable to the tool that
wrote it, and the stamp pass silently did nothing. Annotations now live in the body as
one line, stripped and rewritten each rollover (otherwise provenance stacks up one line
per day like a game of telephone), and heading normalisation also tolerates the old
format and hand-edited variants. Verified on the live bank: the session after cutover
dated **17 open items** in a single pass, including under a heading the earlier format
had written.

**Still open, stated plainly:** items written by *other* tools — including the harness's
own memory tools — arrive undated, and get their date at the next session start rather
than at writing time, which makes their age one day coarse. Fixing that means either
owning the daily append path or agreeing the item grammar with whatever writes it. **The fresh file's shape is a contract, not a preference.** It is written by the
rollover but read and appended to by other tools — the harness's own memory tools
append under `## Completed`, and when the rollover produced a file without those
headings they failed outright. So the output is fixed and documented:

```markdown
# Daily Context — <date>

- date: <date>
- carried from: <day> (and how that day was recovered, if it was inferred)

## In Progress

### <project or origin grouping> — <source heading>

_(carried from <day> — N days old)_

- (<day the item was written>) the item itself

## Completed

## Key Decisions

## Notes
```

`## In Progress` is a heading the classifier already treats as open work, and grouping
lives one level down, so the familiar top-level names stay appendable.

## Cutover (Phase 5c) — performed 2026-10-14

- `~/.pi/agent/extensions/memory` was a **real directory**, not a symlink, so the
  picker cannot disable it and `enableExtension` correctly refuses to clobber it.
  Cutover was a manual move-aside, out of the scanned directory entirely:
  `mv ~/.pi/agent/extensions/memory ~/.pi/agent/extensions-disabled/memory`, then
  `enableExtension("memory", "extensions/memory")` — the picker's own code path, so
  the link is the one the manager would have made.
- **Rollback** is the reverse: `rm ~/.pi/agent/extensions/memory` (the symlink only)
  then `mv ~/.pi/agent/extensions-disabled/memory ~/.pi/agent/extensions/memory`.
  Nothing else has to be undone: the extension holds no state outside the bank, and
  the bank migration has its own backup.
- **Verified in a real session after cutover**: `memory_show` resolved a migrated
  claim with its authority (`rule · global · 2026-05-02`); `memory_doctor` reported 5
  stores, 23 entries, no structural problems, no pending conflicts; the injection
  block was in the prompt (the model quoted it, with `kind · scope · asOf`, without
  calling a tool). `pi -p` load failures: 0.
- Two memory extensions loaded at once means two injectors and duplicate tool names,
  which is what the guard is for. It stood down correctly while they coexisted, and
  passes now.
- Development never touches the live bank: validation runs under `PI_MEMORY_DIR` +
  `PI_CODING_AGENT_DIR` overrides. Migration and cutover were separate approved
  steps, and the migration was rehearsed on a copy of the bank first.

## Build order

| Phase | Deliverable | Status |
|---|---|---|
| 1 | entry schema + tolerant topic-file parser + authority order | ✅ `schema.ts` |
| 2 | resolver: two gates, one authority per key per context, conflict reporting | ✅ `resolver.ts` |
| 3 | admission gate: refuse rivals, pure resolutions, provenance | ✅ `gate.ts` |
| 3b | TUI ask + pending queue (dialog on top of the gate's refusal) | ⬜ |
| 4 | recall + budget + deterministic prompt text | ✅ `inject.ts` |
| 5a | tools, `/memory`, injection hook, pending queue, single-instance guard | ✅ `implementation.ts` `service.ts` `pending.ts` `fs-store.ts` |
| 5b-1 | migration tooling + dry run of the live bank | ✅ `migrate.ts` `scripts/migrate-report.mjs` |
| 5b-2 | apply the migration + cutover of the live extension | ⬜ (decisions taken; needs the go-ahead) |
| 6 | daily rollover: archive, reported carry, item dates, ageing, cap, staleness surfacing | ✅ `rollover.ts` `dailyItems.ts` `markdown.ts` |

## Testing map

239 tests in `extensions/memory/`:

- `schema.test.ts` (31): grammar and scope parsing; metadata vs body boundaries;
  fenced `##` is body; CRLF; unclosed fence; legacy prose headings flagged
  `bad-key`; defaults vs errors; unknown-field preservation; duplicate-identity
  in all three directions (chain OK, two actives flagged, a malformed sibling
  does not trigger it); `compareAuthority` specificity/recency/tie-break
  totality; render↔parse byte-idempotence with nothing dropped.
- `resolver.test.ts` (36): store construction and every violation code
  (duplicate-identity, invalid-entry, unkeyed-entry, dangling, ambiguous and
  cyclic supersedes); Gate 1 fail-closed behaviour with `bestCandidate`; a
  malformed sibling not poisoning an identity; glob and scope applicability;
  Gate 2 shadowing across scopes with the trace kept; redirect-on-stale-hit;
  suppression reasons; and four invariant sweeps over 200 generated stores — at
  most one injectable authority per identity, every entry accounted for exactly
  once, injection never containing a non-authority or two entries for one key,
  and the injected set never depending on candidate order.
- `gate.test.ts` (21): uncontested add and file creation; refusal of a rival in
  the same file **and in a different file** (the three-file bug), with no plan
  attached; suggestion direction from dates; `conflictId` stability, sensitivity
  and staleness; every resolution applied, re-parsed and re-resolved — supersede
  across three files leaves exactly one authority and zero violations,
  keep-both-flagged leaves a `duplicate-identity` violation and makes the read
  path go dark, withdraw asserts nothing new, merge needs `mergedBody`, discard
  writes nothing; amend-vs-rival boundary (same heading amends, a new revision is
  gated); backwards `asOf` allowed with a warning; required `asOf`; malformed
  incoming refused with the parser's own issue codes; path allowlist; and the
  gate/resolver agreement check — a rival the gate accepts never reaches the read
  path.
- `inject.test.ts` (26): tokenization and stopword handling; recall ranking
  (key match beats prose match), set-semantics on query terms, metadata words not
  scored, stale claims kept as candidates, deterministic tie-breaking independent
  of scan order, the memoised corpus cannot change an answer; one line per key
  regardless of how many claims were recalled; asking about a retired claim
  answers with its replacement and never quotes the dead wording; a contested
  identity injects nothing and says to ask — including when recall only found one
  side; broken entries reported as `unkeyed` / `unknown-identity` and never
  injected; scope context excluding and shadowing; token budget and per-kind caps
  trimming the tail while naming what was cut; no score ever rendered; long bodies
  collapsed not truncated; byte-identical output; and an end-to-end check that a
  resolution accepted by the gate changes what the prompt says.
- `fs-store.test.ts` (12): the bank lives where the live one lives, and
  `PI_MEMORY_DIR` / `PI_CODING_AGENT_DIR` / `HOME` overrides are honoured so no
  test can reach the real bank; writes are the gate's rendered bytes with no
  temp-file leftovers and no path escape; a disk round trip loses nothing
  (provenance included); the guard tells our symlink from a foreign real directory.
- `pending.test.ts` (9): the request round-trips without losing a field; the
  stored request replays to the same `conflictId`, so the queue cannot drift from
  the gate; re-refusing one contest updates one record; unreadable queue files are
  reported rather than guessed at; ids are validated before reaching the
  filesystem; the queue is oldest-first.
- `dailyItems.test.ts` (10): the item grammar (`- (YYYY-MM-DD) …`), sub-bullets belonging to their parent item, fence awareness; stamping from the file's date rather than today; already-dated items untouched; `stampDailyFile` touching only open sections and leaving everything else byte for byte; retirement by age; **undated items never retired** (unknown age is not an excuse to drop work); the per-section cap keeping the newest and naming the overflow; every drop reported.
- `rollover.test.ts` (21): rollover happens exactly when the day changed and not when it did not; date-field precedence; mtime recovery labelled as such; an undated file normalised instead of sitting undated forever; alias recognition for open work (`Next Steps` / `Handoff` / `Blocked` / `Todo` …) with no prefix matching; settled work reported rather than carried; unrecognised headings named with the alternatives offered; project groups preserved with only their open parts; a group with nothing open reported; age markers so a carried intention looks as old as it is; nothing-carried stated out loud; fenced code preserved; archives byte-identical; no churn on a second pass; undated archive naming; the fresh file keeps the top-level section names other tools append to; **round trip** — a file the rollover wrote is understood by the next rollover: annotation in the body, item dates kept, aged items retired without leaving an empty section or a stack of provenance notes.
- `migrate.test.ts` (27): proposals and their cues; what is skipped and why (structural headings matched whole, status snapshots, non-`knowledge/` paths, bodyless sections, `## Source` folded into provenance); split families, qualifier merging, fence attachment, per-claim `kind`, placeholder-degrading keys, `similar-claim`; already-entry skip and the broken-entry report; prose consumption with hand-written claims preserved and a colliding proposal stopped; batch collisions; determinism and re-application idempotence; the report's own text.
- `service.test.ts` (19): write / resolveQueued / show / search / injection /
  doctor against a scratch bank — a parked refusal leaves the bank byte-identical;
  an answered contest clears its queue entry; a queue entry resolved after the
  store moved on is re-parked, not applied; a malformed human answer is a
  rejection, not a refusal.
- `index.test.ts` (18): the extension driven through Pi's own surface — a fake
  `pi` capturing registrations, a fake context carrying the dialogs — against a
  scratch bank: the registration set; the guard standing down and notifying; a
  clean write; a rival refused with nothing written and the queue filled; the same
  write in a session with a UI going to the human **and clearing the record the
  headless attempt parked**; a write that already carries a resolution applying
  without a second dialog; a dismissed dialog parking instead of writing;
  malformed entries refused with the parser's own codes; `memory_show` authority,
  chain, shadowing, contested-as-error; `memory_search` labelled as candidates;
  `memory_doctor` dirty vs clean; `/memory pending|doctor|resolve|nonsense`;
  `/memory resolve` with a dialog and with `--resolve=` where there is no UI; the
  hook injecting authorities, surfacing the queue, and staying silent when there
  is nothing to say.
- Catalog pins in `tests/symlink-manager.test.ts` and count pins in
  `tests/picker.test.ts` derive from the live catalog instead of a literal 5.

## Deliberate non-goals

Embeddings/qmd as a conflict fix (re-ranks indistinguishable text). Asking the
model to reconcile (it can't even see it: all three conflicting files produce the
identical snippet `# UI Background Color`). More BM25 knobs. One file per claim.
The legacy `knowledge/index.csv` trigger words.
