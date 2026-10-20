# memory — budgeted, governed memory for Pi

Durable **rules**, domain **facts**, and the **daily log**. Nothing else. It is a
live component: enabled by a symlink at `~/.pi/agent/extensions/memory` (the
rl-extensions picker creates it).

Design inputs: [`design/intent.md`](design/intent.md) and
[`design/spec.md`](design/spec.md) (requirements `R1…R50`, decisions `D1…D19`).
This README is the operating contract: what injects, what waits, what is refused,
and what is deliberately not done.

---

## What it does

| Surface | Name | Notes |
|---|---|---|
| Read | `memory_read(path)` | Files inside the bank. A cut is announced, never silent. |
| Read | `memory_list(dir)` | Every file, its size, and how many claims it holds. |
| Read | `memory_search(query)` | BM25 over claims, **pending** claims, history, the daily archive and the migration archive. Each hit is labelled with where it came from. A candidate list, not an answer. |
| Write | `memory_log(section, text)` | One daily item. The extension stamps the date and time; the agent cannot set them. |
| Write | `memory_propose(…)` | A **pending** claim. The agent can never write an approved claim. |
| Write | `memory_archive(name, text)` | Read-only archive for prose that is neither a claim nor a daily item. |
| Command | `/memory …` | `status · preview · review · approve · reject · defer · edit · doctor · settings · paths · flag · flags · trial · migrate` — `config` still works as the old name for `settings`; review and the review actions take `--wave agent\|migration`. One table (`MEMORY_SUBCOMMANDS` in `implementation.ts`) renders `/memory help`, the line Pi lists, and the argument completions, so the list cannot fall behind the code (R50) |
| Hook | `session_start` | One review notice when anything waits. Never blocks. |
| Hook | `before_agent_start` | The budgeted injection, for user-started runs only. |

### Rename table (old callers)

| Old name | Now |
|---|---|
| `memory_append` | `memory_log` — the date is stamped for you |
| `memory_write`, `memory_update` | `memory_propose` — **one claim per call** |
| `memory_show` | `/memory status`, `/memory review`, `memory_read`, `memory_list` |
| `memory_doctor` | `/memory doctor` |
| `memory_pending`, `memory_resolve` | `/memory review` |
| auto-persist / session-summary lines, `core/` status files | gone; `memory_log` and the daily log |
| `# Memory Bank Context` injection | `## Memory — rules and facts for this context (project: …)` |

`memory_read`, `memory_search` and `memory_list` keep their names and read
behaviour. The extension never edits `AGENTS.md` or skills: updating callers is a
manual cutover step (see [Cutover](#cutover)).

---

## Authority, in one place

1. **Approved claims inject.** One approved claim per identity (`key` + `scope`).
2. **A pending change to an existing identity never injects.** The approved claim
   stays in force until Rodrigo approves the replacement; the old one then moves
   word for word to `history/<key>.md` with a `supersededAt` date. Nothing is
   deleted.
3. **A pending claim for a new identity injects as `[unapproved]`**, below the
   approved ones, until it is older than `pendingFlagDays` (14) — then it stops
   injecting but is never dropped. *New identity* means new **for that key**: a
   pending `project:` claim beside an approved `global` one waits too (D25),
   because a narrower scope shadows (rule 6) and an unreviewed claim must not be
   what stands in place of one that was approved. The approved claim keeps
   answering; the proposal waits in `/memory status`.
4. **A pending claim with `origin: migration` never injects** until approved
   (D9): a migrated bank cannot silently become the truth.
5. **Two approved claims for one identity is *contested*: nothing injects for it**
   (fail closed). It is listed in the session-start notice and in `/memory review`.
6. **Scope shadows scope**: `path:` > `project:` > `global`. One question, one
   answer. Out-of-scope claims never inject.
7. **History and archives are searchable and readable, never injected** (D12).

A rule tagged `always` is injected every turn in the core section. Every other
rule is injected only when the request relates to it. **Rules are context, not
enforcement** (D3): the extension registers no `tool_call` handler and blocks
nothing. It ships no built-in rules — these two are examples you may add
yourself:

```markdown
## git.no-push-without-approval
- kind: rule
- scope: global
- asOf: 2026-10-16
- source: Rodrigo, in session
- tags: always

Never push to a remote, or open a pull request, without Rodrigo's explicit
confirmation in this session.

## files.no-user-files-in-tmp
- kind: rule
- scope: global
- asOf: 2026-10-16
- source: Rodrigo, in session
- tags: always

Never create user-facing files under /tmp. Scratch files are fine; deliverables
are not.
```

---

## Bank layout (`~/.pi/memory/`)

```
claims/rules/*.md, claims/facts/*.md     approved + pending entries (pending carry state: pending)
history/<key>.md                         superseded and rejected claims, append-only
daily/today.md, daily/archive/YYYY-MM/   the daily log; rolled over once per session
archive/                                 read-only migrated prose and status text
migration/state.json                     resumable migration progress, plus the verified backup
metrics/turns.jsonl, flags.jsonl, baseline.json, overrides.jsonl   trial metrics (never any prompt text)
config.json                              the settings below — hand-editable; the next turn reads it
```

`write → read → write` is byte-stable for every file this component writes, and a
hand edit that breaks the grammar is reported with file and line while only that
entry is excluded.

---

## Injection

`before_agent_start` for **user-started runs only** (R25) — a run started by an
extension message is not a question, so it gets nothing.

Budget `budgetTokens` (default **2000**), and the total never exceeds it:

1. **Always-on core** — approved, in-scope rules tagged `always`, at most `coreTokens` (600).
2. **Daily open items** — `in_progress` and `carry`, at most `dailyTokens` (500).
3. **Retrieved claims** — the remainder, BM25-ranked against the prompt, at most
   `maxRetrievedClaims` of them (6; `0` disables the cap).

Unused budget from 1 and 2 flows to 3. The count cap exists because the token
budget alone does not bound the block: once the bank holds dozens of claims the
remainder is always spent, and a turn then costs the budget rather than the work
in front of it. Nothing is cut silently: an entry is never split, and if anything
is dropped the block ends with how many, of which kind, which limit stopped them,
and to use `memory_search`. A read error **fails open**: no injection, one visible
warning, the turn proceeds.

**What one conversation carries** (R25.1, D24). The block is stored in the
session, and every later model call resends it — so before this, a nine-turn
session of this project sent **10,255 tokens** of memory blocks on every call,
where the newest block alone was 1,085. A `context` handler now keeps only the
newest block, and when that block recalled nothing (you typed "yes"), the newest
block that did recall comes along marked `[memory: carried from an earlier turn…]`,
so the claims you are working with do not vanish mid-task. Two blocks, never more.
The **session file keeps every block**: this bounds the request, not the record,
and `/memory trial` reports the tokens carried per model call from
`metrics/context.jsonl`.

**What a match is** (R32.1, R32.2). The ranker compares *terms*: English function
words ("is", "the", "what", "do") are dropped from the prompt and from the claims,
and one word's inflections are folded together, so "branch" finds a claim that
says "Branches" and "wire transfers" finds one that says "wire transfer". Before
this, "what is the branch naming rule" was a query about "is", and it ranked a
wire-transfer fact above the branch rule. A prompt made only of small talk
("yes", "ok do it") has no term left and recalls nothing — which is right: it asks
for nothing. A claim also has to come within **25% of the best hit** to be
injected, so the weak tail stays out of the block; `memory_search` keeps showing
it, because there you asked for it and it costs no budget.

`/memory preview [prompt]` prints the exact block a turn would get, with tokens
per section and what was dropped.

---

## A writer never deletes what it cannot read

A claim store and the daily log are hand-editable, so they can hold text the
grammar cannot read: an entry with a bad field, a heading that is not a key, a
paragraph between sections, a section the tool does not know.

- **A claim store write refuses.** `memory_propose` and `/memory approve|reject|
  defer|edit` name the file and the line, and write nothing. The unreadable text
  stays on disk. `/memory doctor` and `/memory status` list the same lines, so you
  learn them before a proposal wastes a turn. Fix the line, and the write goes
  through.
- **A daily-log write inserts one line.** `memory_log` puts the item under its own
  section heading and rewrites nothing else, so hand-written prose and unknown
  sections keep their bytes and their place. The archive keeps the day's own bytes
  for the same reason.

The rule behind both: a writer may rewrite only what it can reproduce.

## One writer at a time

More than one Pi session can have the same bank open. Every write is read-modify-
write, so a session that reads a file, changes it, and writes it back can overwrite
a claim another session wrote in between.

- Every mutation holds an advisory lock on the file it rewrites, taken before the
  read and released after the rename. A lock older than the stale window belongs to
  a session that died mid-write, so it is taken over, not waited on.
- A claim-store write waits a moment for a live lock, then refuses and names the
  session holding it. Nothing is written and nothing is lost.
- A daily rollover that finds the log being written does nothing this time and says
  so. The next turn tries again.
- History and archive records take their slot under the slot's own lock, so two
  sessions superseding the same key write two records instead of one.

## Writes, and the status redirect

`memory_propose` refuses bodies that read as project status — commit SHAs (7–40
hex), PR/issue/run numbers, CI or build URLs, or a date next to *merged, pushed,
deployed, published, ran, passed, failed* — and points at `memory_log` instead
(D2). The detector reads the **body only**; `source` and `links` may carry
evidence. A proposal containing supersession prose ("superseded", "historical",
"no longer", "replaced by") is refused for the same reason: propose the new claim
for the key and let the store move the old one.

A genuine false positive can be resubmitted with `overrideStatusCheck: true` plus
`overrideReason`; the override is stored on the claim, shown in review, and
counted in the trial metrics so the detector's strictness is measurable.

`asOf` and `source` are never filled in for you. A claim without either is
malformed: reported, not injected.

---

## Review

`session_start` for a new session shows **one** notice when anything waits —
agent proposals, the migration backlog (counted separately), contested identities,
and claims pending longer than `pendingFlagDays` — naming `/memory review`. With
nothing waiting, nothing is shown; outside the TUI it is logged once. Claims are
never dropped automatically, however long they wait.

`/memory review` in the TUI opens **one card for the whole batch**, and the card
shows the claim's own words: key, scope, kind, date, age, origin, source, tags,
the approved claim it would replace, and the body — a selector that shows only
the key is not a review (R18.1). Keys: `a` approve, `x` reject, `d` defer,
`e` edit the wording, `n`/`p` move without deciding, `Esc` stop. `e` closes the
card and opens the editor with the current text, because no dialog opens inside
a dialog (R18.2); the review then reopens where you left off. Anywhere else the
same listing comes back as text, with the exact commands to act on it. Past a
dozen claims it is also written to
`migration/review-<wave>-<day>.md`, because a queue you must read is a document,
not a scrollback. A whole batch is decided with
`/memory approve|reject|defer --wave agent|migration`; wording changes stay per
claim (`/memory edit <key> [scope] <new body>`).

`inlineConflictDialog` (default `false`): when `true`, a proposal that would
replace an approved claim opens a dialog right away, inside the tool call, so
cancelling the call cancels the ask. Anything other than an explicit choice
leaves the claim pending.

---

## Config (`~/.pi/memory/config.json`)

```json
{
  "budgetTokens": 2000,
  "coreTokens": 600,
  "dailyTokens": 500,
  "maxRetrievedClaims": 6,
  "pendingFlagDays": 14,
  "inlineConflictDialog": false,
  "ranker": "bm25",
  "searchLimit": 12
}
```

Unknown or mistyped keys fall back to the default **with a warning**, never
silently. `ranker` accepts only implemented rankers: `bm25`. The `Ranker`
interface (`rank(query, entries) → scored[]`) is the only hook for a future one;
this component deliberately builds no semantic ranker.

### Seeing and changing them (R48–R49)

`/memory settings` (the old name `/memory config` still works) lists every
setting with the value in use, its default, the range the validator enforces, and
where the value came from:

```
setting                current  default     allowed  in use   what it decides
budgetTokens              2000     2000  200..20000  default  the whole block one turn receives
maxRetrievedClaims           6        6      0..200  default  claims one turn may recall, whatever the budget leaves; 0 means no cap
retrieved                  900      900           —  derived  what is left for recall after core and daily
```

Three things that listing exists to make visible:

- **`in use` says where a value came from**: `file` (you set it), `default`, or
  `capped` — the section interlock moved it, because `coreTokens + dailyTokens`
  cannot exceed `budgetTokens`. A refused value never reads as set.
- **`retrieved` is derived, not a setting.** It is the recall the caps actually
  leave, and it is the number the trial's lever sits on.
- **No knob is a bare number.** Without its range, a wrong value and an unusual
  one look identical.

The table and the validator read the same data (`SETTINGS` in `config.ts`), so a
listing cannot drift from what is enforced. Nothing on screen carries a requirement
ID: `R…` numbers belong in tests, commits and this README, and each row keeps its
number in a `spec` field that is never rendered (R49.2).

With no file yet, the listing also prints a paste-ready block — every key at its
default, valid JSON as written, generated from that same table. It **writes
nothing**: create the file with one key if one key is what you want, since a key
you leave out keeps its default and a one-key file is complete. A file naming
every key is a file pinning every default as of the day it was written, and that
is your decision, not the listing's.

`config.json` is hand-editable on the same terms as the claim stores: an edit
reaches the **next turn** of a running session, no restart. A value outside its
range falls back to its default, says so, and the turn proceeds. The TUI editor
for these values is deliberately not built yet (D19): a settings panel is only
worth having when it can show a knob beside the effect it has, and that effect is
what the trial is measuring now.

---

## Trial

The component is measured, not assumed (D6):

- every injected turn appends one line to `metrics/turns.jsonl` — timestamp,
  tokens per section, entries dropped, and **how many approved claims the bank
  held**, which is what starts the clock. **No prompt text.**
- `/memory flag <key> stale|rival` records what the injection got wrong.
- a `memory_propose` that had to override the status detector appends **one** line
  to `metrics/overrides.jsonl`, at the proposal it belongs to. That is D14's number.
- `/memory trial baseline [--days 14] [--marker "# Memory Bank Context"] [--sessions-dir path]`
  measures the *previous* extension's injected block per user turn from Pi session
  files, with the same token estimator, and writes the median to
  `metrics/baseline.json`. If the block is not found it says so and writes
  nothing — the baseline is measured, never estimated.
- `/memory preview` measures nothing. It runs the same code and writes no metric
  line, because two previews would otherwise move the median they are judging.

`/memory trial [days]` prints what it measured and every reason a `go` is not yet
allowed, and **go needs all of them**:

| Gate | Value | Why it is there |
|---|---|---|
| clock | the bank held **3** approved claims at a recorded turn | an empty bank injects almost nothing and can offend nobody (D22) |
| window | **7 days** since that turn, and at least **4** of them carrying turns | three turns in one evening are not a week (D21) |
| recall used | **5** recorded turns got at least one claim back from the ranker | a block of always-on rules alone measures the caps, not the memory (D22) |
| size | median ≤ **25%** of the baseline **and** ≤ **1,200** tokens | against a 17,232-token baseline the 2,000-token budget is 12%, so the ratio alone can never fail (D23) |
| flags | **0** stale or rival flags | the honest signal that a claim was wrong |

Overrides are reported, never gated: a gate there would reward never overriding a
detector that was wrong.

Not measured, by decision (R46): recall (missing notes) and a head-to-head with
rl memory.

---

## Migration and cutover

```
/memory migrate backup                     tarball of the bank, listed back to prove it
/memory migrate plan                       waves from the files that really exist, rules first
/memory migrate status                     progress, resumable
/memory migrate apply [--wave w | --all]   draft a whole wave in one pass, through the gate
/memory migrate draft [--wave w] [--file f] [--batch n]   one file, verbatim, for rewriting by hand
/memory migrate drafted <file> <n>         record one file as drafted
/memory migrate daily                      the working-state wave, with the items' own dates
/memory migrate cutover                    archive the sources — never delete them
```

### Migrating a whole bank in one sitting

```
/memory migrate backup
/memory migrate plan
/memory migrate apply --all      every live entry becomes a pending claim; refusals are listed with reasons
/memory migrate daily            open items from the old daily-context file, dated as they were
/memory review --wave migration  the queue, and a full listing written beside it
/memory approve --wave migration the batch decided at once
```

Nothing injected changes during any of it: a migrated claim is `origin: migration`
and never injects until approved (D9), so the migration can be run, reviewed and
rejected without the model ever seeing a draft. After the batch is approved,
what is wrong is fixed where it lives — `claims/rules/*.md` and
`claims/facts/*.md` are hand-editable, and an edit is picked up by the next turn
(no restart). To drop one: `/memory reject <key> [scope]`.

`apply` carries entry text over verbatim and runs it through the same gate a
hand-written proposal passes: an entry with no `asOf`, a body that reads as
status, supersession prose, or an already-retired entry is **not** proposed and
is reported with its reason. Use `migrate draft` for a file whose entries need
rewriting into tighter claims.

`migrate daily` converts only the daily-context file. A file that is project
status (release state, SHAs, tool lists) is reported as such and carried by
nothing: projects live outside memory (R2).

Every step except `backup` refuses to run without a verified backup. Source files
are untouched until cutover. Migration claims carry `origin: migration` and never
inject until approved; review them as their own batch
(`/memory review --wave migration`).

### Cutover

The order is fixed (R40). The read-only caller inventory is
[`cutover-callers.md`](cutover-callers.md): every caller found in the agent
configuration, the memory feature it uses, and the exact change needed. It edits
nothing — the edits are Rodrigo's.

1. Make every change in the inventory, including the new tool names.
2. Remove any `~/.pi/agent/extensions/memory` link the picker did not create.
3. Enable `memory` in the picker.
4. Rollback is the reverse: remove the link, restore the old one.

The picker **never replaces or removes a symlink it did not create**: a taken
name is reported with the manual step named, and the link is left alone (R42).

---

## Deliberate non-goals

- No sync, no multi-machine logic, no sync-specific checks (D8: one machine).
- No project list stored or injected; a claim may link to a project (R2).
- No semantic/LLM ranker, no embedding store, no reranker.
- No automatic approval, no automatic drop, no auto-persist or session-summary
  lines, no writing of `AGENTS.md` or skills.
- No tool-call blocking or policy enforcement (D3).
- No replay benchmark; the trial measures what the injection costs (D6).

## Dependencies

`minimatch` is the only runtime dependency: `path:<glob>` scopes (R8–R10) need a
glob matcher whose semantics are pinned by tests — `dot: true` (a scope must see
`.terminal/`), `nonegate: true` and `nocomment: true` (a glob that starts with
`!` or `#` is a scope, not an option). Node has none.

## Tests

236 tests, one file per module (`time · grammar · scope · store · queue · gate ·
daily · rank · context · inject · notice · config · trial · migrate · index`). `index.test.ts`
drives the real Pi surface — tool registrations, all three hooks, `/memory` — against a
scratch bank with an injected clock and git probe, so no test touches
`~/.pi/memory`. `bank.ts` is the use-case layer between the modules and that
adapter, which is why every decision above is testable without a Pi process.
