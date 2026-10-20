# Spec: budgeted, governed memory for Pi
From: intent.md (Rodrigo Lazoti). Status: decisions applied 2026-10-16; ready for product owner review.
Skills applied: none matched (no memory or extension-design skill is installed). Inputs: intent.md only.
It points to two documents, which are followed where it does: rl-pi-extensions `AGENTS.md` (named
in its constraints) and Pi's extension API docs (`session_start` and `before_agent_start` hooks).

## Requirements

### Scope
- R1. The extension owns three kinds of memory: **rules** (preferences, how Rodrigo works),
  **facts** (domain facts and invariants) and the **daily log**. Nothing else.
- R2. Projects live outside memory (local directory, GitHub, any URI). A claim may link to one. No
  project list is stored or injected.
- R3. One machine. The extension has no sync logic and no sync-specific checks (D8).

### Storage and grammar
- R4. Rules and facts are markdown entries with a strict grammar.
  - Required fields: `key`, `kind` (`rule` | `fact`), `scope`, `asOf`, `source`.
  - Optional fields: `aliases`, `tags`, `links`, `origin` (`agent` | `migration`).
  - The body is plain prose of at most 600 characters.
- R5. `asOf` and `source` are never filled in by the extension. An entry without either is
  malformed: it is reported and not injected.
- R6. write → read → write is byte-stable for every file the extension writes.
- R7. Files are hand-editable. A hand edit that breaks the grammar is reported with file and line,
  and only that entry is excluded.

### Scope resolution
- R8. `scope` is `global`, `project:<id>` or `path:<glob>`. `<id>` is derived from the git remote,
  or else the repo root, of the session's working directory.
- R9. Out-of-scope claims are never injected or returned by automatic recall.
- R10. For one key, a narrower scope shadows a broader one (`path` > `project` > `global`). One
  question gets one answer.

### One current claim per key
- R11. An identity (`key` + `scope`) has at most one approved claim and at most one pending claim.
- R12. If an identity has two approved claims (for example after a hand edit), it is **contested**:
  nothing is injected for it, and it is listed in the session-start notice (R20).
- R13. Approving a pending claim replaces the approved one. The old claim moves word for word to
  `history/` with a `supersededAt` date. Nothing is deleted.
- R14. A body containing supersession prose ("superseded", "historical", "no longer", "replaced by")
  is refused at write time. The reason says to propose a new claim for the key instead.

### Writes (tiered)
- R15. `memory_log` appends one item to today's daily log. Sections: `completed`, `in_progress`,
  `decision`, `carry`, `note`. The extension stamps date and time, and the agent cannot set them.
- R16. The extension never writes auto-persist or session-summary lines.
- R17. `memory_propose` creates or replaces the pending claim for an identity. The agent cannot
  write approved claims.
- R18. `/memory review` lists pending claims in batches, each next to the approved claim it would
  replace. Actions per claim or per batch: approve, reject, edit, defer. Migration claims are
  reviewed as their own batch, by wave.
  - R18.1 A review shows the claim's **text**. In the TUI it is one card for the whole batch — the
    claim, its metadata, and the approved claim it would replace — with the decision keys beside
    it; a selector that shows only the key is not a review. In a non-TUI context the same listing
    is returned as text, and when it is long it is also written under `migration/` to be read.
  - R18.2 Edit closes the card before opening the editor: no dialog opens inside a dialog.
- R19. Config `inlineConflictDialog` (default `false`): when `true`, a proposal that would replace an
  approved claim opens a dialog right away. Dialogs are shown one at a time and cancel with the
  tool call.

### Review notice (D1)
- R20. On `session_start` for a new session, if anything waits for Rodrigo, the extension shows one
  notice with counts:
  - new proposals (`origin: agent`);
  - migration backlog (`origin: migration`), counted separately (D9);
  - contested identities (R12);
  - claims pending longer than `pendingFlagDays` (default 14).
  The notice names `/memory review`. It never blocks the session. With nothing pending, nothing is
  shown. Outside TUI mode it is written once to the log instead.
- R21. Claims are never dropped automatically, however long they wait.

### Status redirect (D2)
- R22. A proposal whose body reads as project status is refused, with a reason, and redirected to
  `memory_log`. Signals:
  - commit SHAs (7–40 hex);
  - PR, issue or run numbers;
  - CI or build URLs;
  - a date next to one of the verbs merged, pushed, deployed, published, ran, passed or failed.
- R23. The detector reads the body only. `source` and `links` may carry PR, commit and run
  references, because they are evidence.
- R24. A refused proposal can be resubmitted with `overrideStatusCheck: true` and a reason. The
  override is stored on the claim and shown in review. Each override is recorded **once**, as its own
  event line in `metrics/overrides.jsonl`, at the proposal it belongs to, and the trial reports the
  count (R43, D14). It is never a per-turn running total, and it is never a gate on the go: a gate
  there would reward never overriding a detector that was wrong.

### Injection
- R25. Injection happens in `before_agent_start` for runs started by the user. It returns one
  added `message`. Runs started by extension messages are skipped.
- R26. Hard budget `budgetTokens`, default 2000, configurable. The total never exceeds it.
- R27. Budget order (all configurable; tuned from trial metrics, D11):
  1. **Always-on core:** approved in-scope rules tagged `always`, at most 600 tokens.
  2. **Daily open items:** `in_progress` and `carry`, at most 500 tokens.
  3. **Retrieved claims:** the remainder.
  Unused budget from 1 and 2 flows to 3.
  4. **A count cap on retrieval (D18):** at most `maxRetrievedClaims` retrieved claims per turn
     (default 6; `0` disables the cap). The token budget alone does not bound the block: once the
     bank holds dozens of claims the remainder is always spent, so a turn's cost tracks the budget
     rather than the work in front of it. Claims the cap stops are counted and named like any other
     cut (R29), and the drop line says which limit stopped them.
- R28. Which claims may be injected (D1, D9):
  - approved claims: yes;
  - a pending claim whose identity has an approved claim: no, only the approved claim is injected;
  - a pending claim for a new identity with `origin: agent`: yes, labelled `[unapproved]` and ranked
    below approved claims, until it is flagged as old (R20); then no (D13);
  - a pending claim with `origin: migration`: no, until approved;
  - a contested identity (R12): nothing.
- R29. Nothing is cut silently. A cut never splits an entry. If entries are dropped, a final line
  says how many, of which kind, and to use `memory_search` to find them.
- R30. Read errors fail open: no injection, one visible warning, and the turn proceeds.
- R31. `/memory preview [prompt]` shows the exact block that would be injected, with tokens per
  section. It **records nothing**: a preview is a question about the measurement, not a sample of it.
  Two previews used to append two turn metrics and move the median the trial reports (F2-b).

### Retrieval
- R32. The default ranker is BM25 over key, aliases, tags and body. Rankers implement
  `rank(query, entries) → scored[]`. This spec builds no semantic ranker. The interface is the only
  hook for one.
  - R32.1. A ranker compares **terms**, never words as typed (D20). An English stopword list is
    dropped from the query and from the claims, and inflections are folded (plural `-s`/`-es`,
    `-ies`, `-ing`, `-ed`, doubled final consonant, a silent final `e`). A query left with no term
    after that retrieves nothing: "yes" asks for nothing, so it recalls nothing. Left unsaid, this
    is what the bank is ranked by — "what is the branch naming rule" is a query about "is", and a
    claim about wire transfers answers it.
  - R32.2. A claim is a **hit** when it scores at least `MIN_SCORE_SHARE` (25%) of the best hit
    (D20). A share, never an absolute score: BM25 scores scale with the size of the bank, so a fixed
    number rots as the bank grows, and one hit on its own always survives. Automatic recall applies
    it, because a turn pays tokens for what it is given. `memory_search` does not (R33): the human
    asked, the count is bounded, and a claim matching one of two words is a candidate there.
- R33. `memory_search` covers approved claims, pending claims (including migration backlog),
  history, the daily-log archive and the migration archive, with each result labelled by origin.
  History and archives are never injected (D12). `memory_read` can open them by path.

### Rules as context (D3)
- R34. Rules are context only. The extension registers no `tool_call` handler and blocks nothing.
- R35. A rule tagged `always` is injected every turn in the core section (R27.1). Every other rule is
  injected only when the ranker relates it to the request (R27.3).
- R36. The extension ships no built-in rules. The README shows two example rules ("no push without
  approval", "no user-facing files under `/tmp`") as claims Rodrigo may add himself.

### Migration and cutover (D5, D7, D9)
- R37. `/memory migrate backup` writes a timestamped tarball of `~/.pi/memory` and verifies that
  it can be listed. Every other migration step refuses to run without a verified backup.
- R38. `/memory migrate draft --wave <rules|facts:<domain>> [--file <name> | --batch <n>]` runs one
  agent turn per existing knowledge file.
  - Waves: rules and preferences first, then facts one domain at a time.
  - The agent proposes claims with `memory_propose`; each one carries `origin: migration`.
  - Leftover status text is moved to the read-only archive with `memory_archive`.
  - Progress is saved in `migration/state.json`, so the step can resume.
- R39. Source files are not modified until cutover. At cutover they move to the archive and are
  never deleted.
- R40. Cutover is a single switch, done only after the trial (R45) reports go. Checklist, in order:
  0. The assistant writes a one-time, read-only caller inventory (`cutover-callers.md`): each
     caller in `~/.pi/agent/AGENTS.md` and the skills, the memory feature it uses (tool names,
     project list, auto-persist lines, moved paths), and the exact change needed (D15). It edits
     nothing.
  1. Rodrigo has made every change in the inventory, including the new tool names (R41).
  2. Rodrigo removes the old `~/.pi/agent/extensions/memory` link by hand.
  3. The picker links the new component as `memory`.
  4. Rollback is the reverse: remove the new link and restore the old one.

### Compatibility (D4, D5, D7)
- R41. Tool names:
  - `memory_read`, `memory_search` and `memory_list` keep their names and read behaviour.
  - Writes exist only as `memory_log` and `memory_propose`. Old write names (`memory_append`,
    `memory_update`) are not registered.
  - The README has the rename table: `memory_append` → `memory_log`; `memory_update` →
    `memory_propose`, one claim per call.
  - The extension never edits AGENTS.md or skills. Updating them is Rodrigo's manual cutover gate.
- R42. The component is named `memory`. The picker never replaces a symlink it did not create. If
  `memory` is taken, it reports this, names the manual step (R40.2), and stops.

### Success measure: one-week trial (D6)
- R43. The extension appends one line per injected turn to `metrics/turns.jsonl`: timestamp, tokens
  per section, entries dropped, and the number of approved claims the bank held (which starts the
  clock, R45). No prompt text is stored. `/memory preview` appends nothing (R31). Status-check
  overrides are not a field on this line — they belong to a proposal, not to a turn — and are one
  line each in `metrics/overrides.jsonl` (R24).
- R44. `/memory flag <key> stale|rival` records a flag in `metrics/flags.jsonl` with the injected
  claim and the session id.
- R45. `/memory trial` reports the trial result after 7 days of use. It prints what it measured and
  **every** unmet gate; a gate is never reported and then overwritten by the next verdict (D21).
  Go needs all of them:
  - **clock:** a recorded turn saw at least `MIN_APPROVED_CLAIMS` (3) approved claims — with nothing
    to inject, a trial proves nothing (D22);
  - **window:** the span from that first turn to today is at least `days` (7), and at least half of
    those days carry a turn (D21). Coverage is measured from the first recorded turn, never from the
    window it is handed, which is what made the old check impossible to fail;
  - **recall used:** at least `MIN_RETRIEVED_TURNS` (5) recorded turns got at least one claim back
    from the ranker (D22);
  - **size:** median at most 25% of the baseline **and** at most `MAX_MEDIAN_TOKENS` (1,200) tokens
    (D23);
  - **flags:** zero stale or rival flags.
  Overrides are reported on the same screen and gate nothing (R24).
- R46. Recall (missing notes) and a comparison with rl memory are not measured. This is accepted.
- R47. `/memory trial baseline` computes the baseline from Pi session files (D10):
  - reads `~/.pi/agent/sessions/**/*.jsonl` from the 14 days before the command;
  - takes the current extension's injected block (`# Memory Bank Context`) once per user turn;
  - counts it with the same token estimator that R43 uses;
  - writes the median, sample size and date range to `metrics/baseline.json`.
  If the block is not found, the command reports this and writes nothing. It never estimates.

### Settings (D19)
- R48. `config.json` is hand-editable on the same terms as the claim stores: a change reaches the
  next turn of a running session, with no restart. A value outside its range falls back to its
  default and the fallback is reported (R30); it never stops the turn.
- R49. `/memory settings` (the old name `config` keeps working) lists every setting with the value
  in use, its default, the range the validator enforces, and where that value came from: the file, a
  default, or the section interlock. It also shows the recall size the caps leave, marked as derived.
  The listing and the validator read the same table, so a listing cannot drift from what is enforced.
  A knob never appears as a plain number: without its range the reader cannot tell a wrong value
  from an unusual one.
- R49.1. With no config file, the listing also carries a paste-ready template generated from that same
  table, and **writes nothing**: a key the file names is a choice, so a file naming every key pins
  every default as of the day it was written, and that is Rodrigo's decision. A file naming one key is
  complete — an absent key keeps its default, and an unknown or out-of-range key is reported, never
  swallowed (R30, D19).
- R49.2. Nothing a person reads carries a requirement ID. The mapping from a setting to the requirement
  it serves lives in a `spec` field on the same table row, rendered nowhere. (Tests, commits and this
  spec keep citing IDs.)
- R50. One table lists the subcommands (`MEMORY_SUBCOMMANDS`), and it renders `/memory help`, the line
  Pi shows in its command list, and the argument completions for the first word after the command. A
  name the table lists but the code does not handle is reported as our bug, not as the reader's typo. A
  hand-written list drifted when `settings` was added; the list and the code that answers it share one
  source now. The README's command list is checked against the table.

## Design

### Placement
- A new component written from scratch in `rl-pi-extensions/extensions/memory/`. No code, file
  format or behaviour is carried over from either earlier extension.
- The entry point `index.ts` re-exports `implementation.ts`, following the repo's pattern.
  `README.md` is the component's user documentation, including the rename table, the cutover
  checklist and the example rules.

### Modules
| Module | Responsibility |
|---|---|
| `grammar.ts` | Entry schema, parse, render, validation (R4–R7). Pure functions. |
| `scope.ts` | Project-id derivation, glob matching, shadowing (R8–R10). |
| `store.ts` | File layout, atomic writes, history moves, archive, backup (R6, R13, R37, R39). |
| `queue.ts` | Pending claims, one per identity, origin, ageing, batch operations (R11–R12, R17–R19, R21). |
| `gate.ts` | Write-time checks: grammar, supersession prose, status detector, override (R14, R22–R24). |
| `daily.ts` | `memory_log`, stamping, open-item selection, date rollover into the archive (R15–R16). |
| `rank.ts` | `Ranker` interface and BM25 (R32). |
| `inject.ts` | Budget sections, injection eligibility, `[unapproved]` labels, truncation notice, preview (R25–R31, R35). |
| `notice.ts` | Session-start review notice and its counts (R20). |
| `trial.ts` | Turn metrics, flags, baseline from session files, trial report (R43–R47). |
| `migrate.ts` | Backup gate, waves, per-file draft turns, resumable state (R37–R39). |
| `config.ts` | `~/.pi/memory/config.json` with validated defaults, the settings table the validator and the listing share, `/memory settings` text (R48–R49). Invalid config falls back to defaults with a warning. |
| `implementation.ts` | Registers tools, commands and both hooks; the subcommand table that renders help, the command-list line and the completions (R25, R41, R50). |

### Bank layout (`~/.pi/memory/`)
```
claims/rules/*.md, claims/facts/*.md   approved + pending entries (pending carry `state: pending`)
history/<key>.md                       superseded claims, append-only
daily/today.md, daily/archive/YYYY-MM/ the daily log and its archive
archive/                               read-only migrated prose and status text
migration/state.json                   resumable migration progress
metrics/turns.jsonl, metrics/flags.jsonl, metrics/baseline.json  trial metrics
metrics/overrides.jsonl                one line per status-check override (R24)
config.json
```

### Flow
```mermaid
flowchart LR
  A[memory_propose] --> G{gate}
  G -- refused --> L[reason: use memory_log]
  G -- ok --> P[pending claim]
  P --> R["/memory review"]
  R -- approve --> C[approved claim]
  C -- old version --> H[history]
  C --> I[before_agent_start: budgeted inject]
  P -- new key, origin agent --> I
  P & K[contested] --> N[session_start: review notice]
  D[memory_log] --> Y[daily log] --> I
  I --> M[metrics]
```

### Tests (per rl-pi-extensions `AGENTS.md` § 5)
- **Grammar:** second-pass byte stability for every field and file kind; malformed entries reported
  and excluded.
- **Identity:**
  - two approved claims on one identity inject nothing and appear in the notice;
  - approval moves the old claim to history, byte for byte.
- **Eligibility (R28):** a table covering each row, including pending-over-approved (approved only),
  new-key agent pending (labelled, ranked below), new-key pending older than 14 days (excluded),
  and migration pending (excluded).
- **Retrieval (R32):** the probe table — a query and the keys it must return, in order — with chat
  queries ("yes", "ok do it") returning nothing; word families folding onto one term while "status",
  "alias" and "class" keep theirs; the stopword list checked for holes in the words a prompt really
  says; and the score floor holding at a share of the top hit, with a lone weak hit surviving.
- **Notice:** counts per category; nothing shown when empty; never blocks; non-TUI path logs once.
- **Gate:** a table of status and non-status bodies; source/links exemption; override path;
  supersession-prose refusal.
- **Budget:** invariant sweep over generated stores (tokens ≤ budget, always); section caps;
  flow-through; notice text; no split entries; `always` rules in core, other rules only by rank.
- **No blocking:** the extension registers no `tool_call` handler.
- **Trial:** metrics lines carry no prompt text and name the bank they were injected into; a preview
  writes none; a flag records the claim; an override is one event line and is reported, not gated;
  report arithmetic and every gate (clock, window and coverage, retrieved turns, ratio, absolute
  ceiling, flags) with a one-day burst held out as not-a-week and an empty bank held out as no-verdict;
  baseline from fixture session files (one block per user turn, same estimator, missing block
  reported with nothing written).
- **Migration:** refused without a backup; waves; resumes from state; source files untouched before
  cutover.
- **Compatibility:** read names registered; old write names not registered; picker stops on a
  foreign `memory` link.
- **Settings (R48–R49):** the table covers every setting exactly once, and each row's range is the
  range the validator enforces (accept at both bounds, refuse just outside, name the fallback);
  a value the file set, a default, and a value the interlock moved read differently in the listing;
  the template parses as accepted config with every key at its default, one key in the file leaves the
  rest default, and the listing writes no file; no rendered line carries a requirement ID; in one
  running session a config edit changes the next turn's injection, and a bad value falls back without
  stopping it.
- **Command surface (R50):** every name in the subcommand table appears in the command-list line, in
  `/memory help` and in the completions, and none of them reports "not implemented"; an unlisted name is
  reported as unknown; the README's command list agrees with the table in both directions.

## How each constraint in the intent is met
| Constraint | Met by |
| :---- | :---- |
| Lives in rl-pi-extensions and follows its AGENTS.md | New component under `extensions/memory/`. Strip-compatible TS, a test file per module, `npm test` and `npm run typecheck` gates. |
| No new runtime dependency without a README justification | BM25, metrics and the backup use Node built-ins. Path globs need a glob matcher. It is the only candidate dependency, and it gets a README justification line. |
| Must not block Pi startup | Startup only registers tools and hooks. The notice reads queue counts only; the bank is fully read on the first `before_agent_start`. |
| Fails closed on two approved claims for one key | R12. |
| Fails open on read errors | R30. |
| No silent loss; nothing cut from the bottom without notice | R13 history, R21 no auto-drop, R29 notice with whole entries only, R39 archive instead of delete. |
| Read names keep working; writes renamed with a documented path; callers updated by hand | R41, R40.1. |
| Name `memory`; never overwrites a foreign symlink | R42, R40.2–3. |
| One machine | R3. |
| Defaults: 2k budget, no tool blocking, inline dialog off, all configurable | R19, R26, R34, R48–R49, `config.ts`. |

## Open questions from the intent
- **Always-on core versus retrieved, and the split of 2k?** Answered: R27, 600 / 500 / remainder,
  tuned from `metrics/turns.jsonl` during the trial (D11).
- **Is history searchable only, or ever injected?** Answered: R33, search only (D12).
- **What changes in `/morning`, briefing, plan-day and EOD?** Answered by process: a read-only
  caller inventory before cutover (R40.0); Rodrigo makes the edits (R40.1) (D15).
- **How long may a claim stay pending?** Answered: flagged at 14 days (R20), then no longer
  injected (R28), never dropped (R21) (D13).
- **Which signals count as "status"?** Answered: the four signals in R22; overrides counted in the
  trial metrics to measure false positives (D14).
- **How is the current extension's token baseline measured?** Answered: R47, from the last 14 days
  of Pi session files (D10).

## Decisions (Rodrigo, 2026-10-16)
| # | Conflict | Decision | Requirements |
|---|---|---|---|
| D1 | Pending claims vs. fail closed | Approved wins while a change is pending. New-key pending claims are injected as `[unapproved]`. New sessions show a review notice. | R12, R20, R28 |
| D2 | Status detector vs. `source` | Body only. `source` and `links` exempt. Override with a reason. | R22–R24 |
| D3 | Enforcement rules | Rules are context only, and nothing is blocked. Push and `/tmp` rules are README examples, not built in. | R34–R36 |
| — | Fail open vs. enforcement | Removed by D3: no enforcement hook exists. | — |
| D4 | Tool names | Keep read names. Writes are only `memory_log` / `memory_propose`. | R41 |
| D5 | External callers | Rodrigo edits AGENTS.md and skills by hand before cutover. | R40.1, R41 |
| D6 | Success measure | The replay is replaced by a one-week trial. Go: median tokens ≤ 25% of baseline, zero stale/rival flags. Recall and the rl comparison are not measured. | R43–R46 |
| D7 | Component name | `memory`. Rodrigo removes the old link by hand at cutover. | R40, R42 |
| D8 | Two machines | One machine. Sync is out of scope. | R3 |
| D9 | Migration load | Migrated claims are not injected until approved. Waves, rules first. The notice counts the backlog separately. | R20, R28, R38 |
| D10 | Token baseline | Median of the current extension's injected block per user turn, from the last 14 days of Pi session files, counted with the same estimator. | R47 |
| D11 | Budget split | Core 600, daily 500, retrieved the rest. Tuned from trial metrics. | R27 |
| D12 | History | Search and read only, never injected. | R33 |
| D13 | Old pending claims | Flagged at 14 days, then no longer injected. Never dropped. | R20, R21, R28 |
| D14 | Status signals | The four proposed signals. Overrides counted in trial metrics. | R22, R24, R43 |
| D15 | Caller changes | One-time read-only inventory by the assistant before cutover; Rodrigo edits. | R40.0, R40.1 |
| D16 | Migration effort | A whole wave is drafted by one command (`/memory migrate apply`) and reviewed as a batch (`--wave`), because one entry per turn would spend a day on migration. Refusals are reported, never quietly kept. | R18, R25, R37, R38 |
| D17 | Review surface | A custom card, not `ui.select`: the claim's own words and its rival are on screen, and the whole batch is one dialog. | R18.1, R18.2 |
| D18 | Recall size | Retrieved claims are capped per turn (default 6), not bounded by tokens alone: with the bank at 54 approved claims every prompt spent the whole 2000-token budget, so the trial's go bar (25% of an 880-token baseline) was unreachable by construction. | R27.4, R45 |
| D19 | Settings surface | A text listing (`/memory settings`) plus live reload of a hand-edited config, now. The TUI editor waits until the trial has a week of measurements, because the panel's value is showing a knob beside the effect it has, and that effect is not measured yet. | R48, R49 |
| D20 | What counts as a retrieved claim | Stopwords dropped from query and claims, light suffix folding, and a hit must score at least 25% of the top hit (a share, not an absolute score, and not applied to `memory_search`). Chosen over "any non-stopword match" and an absolute floor after measuring 12 queries against a 20-claim bank: every second-place claim a reader wanted scored 25% or more, the noise sat between 14% and 23%, and a 40% floor dropped a claim that was the right answer. | R32.1, R32.2, R33 |
| D21 | A trial that cannot fail | Coverage is measured from the first recorded turn's day, not from the window handed to the report (the old check compared a window against itself and could never fire), and the verdict lists every unmet gate instead of letting a later one overwrite the coverage reason. Go also needs the window spanned and at least half its days carrying turns. | R45 |
| D22 | A trial with nothing to inject | Both gates: the clock starts at 3 approved claims, and a go needs 5 recorded turns that retrieved at least one claim. Measured on this bank: 48% of injected turns retrieve something, so 5 costs about 10 turns and one evening cannot fake it. Counts approved claims of any origin and never calls the migration code. | R45 |
| D23 | The size gate | Keep the 25% ratio **and** add an absolute ceiling of 1,200 tokens on the median, measured from 25 real injections (median 1,077, p90 1,646). Against a 17,232-token baseline the whole 2,000-token budget is 12%, so the ratio alone passes for ever. | R45 |
