# Design: what injection costs, and what it costs per turn

Status: **historical baseline measured 2026-11-04; §3.0/§3.1/§3.2 and the separate §3.5 are built.**
Some private-bank filenames below are pseudonyms; measurements are unchanged.
Current six-step implementation: [implementation-plan.md](implementation-plan.md).

Measurement correction, 2026-11-08: measure/replay now drive the actual injector, separate session
IDs and reset boundaries, and isolate unidentifiable legacy prompts. Replay no longer treats four
raw ranks (including core) as injection slots. The old tables below remain historical evidence,
not comparable to that corrected series. A 34-case frozen provisional corpus now exists; the
owner-reviewed real-bank labels and historical snapshots required to tune a default remain open. Section 6 is the baseline to beat — if a change cannot move those
numbers, it is not a change to injection.

Sources of every number in this file:

- `~/.pi/memory3/logs/usage-2026-10.jsonl` + `usage-2026-11.jsonl` — 294 events
  (117 `inject`, 97 `write`, 55 `session`, 19 `search`, 6 `index`, 2 refused writes).
- `~/.pi/agent/sessions/*/*.jsonl` — 233 files, of which **107 carry `memory-context`
  entries** (522 blocks, 3.73 MB injected at the time of writing; measuring it adds more). The
  token-share figures use the 63 of those that also carry per-request `usage` records. Token
  shares assume 3.6 characters per token, since the transcript stores text, not tokens.
- A replay of the logged prompts against the live bank (43 documents) with the extension's
  own `MemoryIndex`, loaded through jiti. Harness in [Appendix A](#appendix-a-the-replay-harness).

## 1. What actually goes into a prompt

`before_agent_start` returns a `custom_message` entry, and pi treats those as permanent
context — they are never retracted, so they accumulate for the life of the session.
Measured over 117 logged prompts:

| | |
|---|---|
| Block size | median 19,000 chars, p90 30,006, max 36,545 |
| Composition (511 blocks) | knowledge + history 59 %, `dailyContext.md` 35 %, `activeProjects.md` 6 % |
| Prompts that found nothing | 5 / 117 |
| Search time | p50 3 ms — never the problem |
| Cumulative cost | 6.2 % of billed prompt tokens across injection sessions, weighted; **median 11 % per session, p90 38 %**, max 58 % |
| Peak memory context in one window | median 4,469 tokens, p90 24,332, max 110,603 |
| Worst session measured | 31 blocks, 807,751 bytes injected |

Roughly one 20 KB block per user prompt, and it stays.

## 2. Four measured problems

### 2.1 Re-injection, not selection, is the largest single cost

Over 522 blocks (3.73 MB injected):

| | | |
|---|---|---|
| Blocks whose core was **byte-identical to the previous block** | 300 / 522 = 57 % | 696 KB |
| Blocks whose knowledge file **set** equalled the previous block's | 236 / 522 = 45 % | 762 KB |
| **Together** | | **1.46 MB of 3.73 MB = 39 %** |

39 % of everything injected was identical to what was sent one turn earlier. The looser
measure — content already injected somewhere in the same session — is 76 %, measured over
the 40 most recent sessions (129 blocks). Both are defensible; the design below budgets
against the strict one.

`core/dailyContext.md` was written 22 times and `core/activeProjects.md` 20 times across the
whole logging period, against 117 prompts — the core files do not change as fast as they are
sent.

### 2.2 There is still no relevance floor, and the noise has names

326 file-slots went in: 22 scored **exactly 0**, 66 scored under 5. Rank-relative to the
top hit: rank 2 median 0.58 (p10 0.20), rank 3 median 0.41 (p10 0.00). The
half-of-top-score rule applies to history only, so a knowledge file at score 0 is admitted
by rule.

The cost is concentrated in four files written during this extension's own development:

| File | Injected | Chars |
|---|---|---|
| `knowledge/broad-fs-scans.md` | 27× | 180,657 |
| `history/daily/2026-10/2026-10-27-dailyContext.md` | 31× | 138,477 |
| `knowledge/stale-index.md` | 32× | 85,664 |
| `knowledge/project-scope.md` | 25× | 48,375 |

Those four are 453 KB of the 1,372 KB of knowledge and history ever injected — **33 %** —
and they arrive in sessions about other projects, because their alias lists are built from
words any agent prompt contains: `index`, `session`, `write`, `file`, `search`, `change`,
`project`, `memory`. The README already names this suspect ("the second and third are often
filler"); this is the name on it.

### 2.3 Absolute score has no scale; per-term score does

Scores from real prompts span **0 to 779,977**, because MiniSearch normalizes by document
length but not by query length. That is why "use a minimum score" was rejected in
`injection-eval.test.ts` (39 in a one-file bank, 176 in a sixty-file bank) and it is still
correct for absolute scores. It is not correct for scores divided by distinct content
terms in the query. Replay over 96 distinct logged prompts:

| Rank | norm p25 | p50 | p75 |
|---|---|---|---|
| 1 | 14.5 | 27.8 | 48.8 |
| 2 | 10.3 | 18.0 | 31.0 |
| 3 | 7.0 | 15.6 | 24.3 |

Median query in that replay had 8 distinct content terms. A cut on
`score ≥ A × terms && score ≥ B × top` removes a tunable share of slots 2–3 and leaves
rank 1 nearly untouched:

| A | B | Slots 2–3 kept | Cut |
|---|---|---|---|
| 2 | 0.20 | 257 / 284 | 10 % |
| 3 | 0.25 | 236 / 284 | 17 % |
| 5 | 0.30 | 204 / 284 | 28 % |
| 4 | 0.40 | 188 / 284 | 34 % |
| 8 | 0.30 | 188 / 284 | 34 % |

Caveats that belong with the table, not under the rug: the replay ranks against **today's**
43-document bank, not the bank as it stood when each prompt was typed, and it evaluates all
candidates rather than only those the old code injected. It sizes the cut; it does not
certify the constant.

### 2.4 Short prompts get a fresh, near-noise ranking that overwrites a good one

22 of 117 prompts (19 %) had two content words or fewer — "do it", "try again", "yes",
"you stopped again". 17 of them still pulled files in; 28 of their 41 slots scored under 5.
These are topic *continuations*, and the previous turn usually already chose the right
files. A floor alone would fix the cost and make the quality worse in exactly these turns,
which is why 3.3 pairs a floor with keeping the previous turn's choice.

## 3. The plan

Ordered by value over risk. Each step is a separate commit with its replay numbers.

**3.0 The measurement loop, first — built 2026-11-04.** `npm run replay`
(`scripts/replay-injection.mjs`) prices candidate floors against the logged prompts, and
`summarizeLog` grew two numbers: bytes this session already paid for one prompt ago, and the
per-term filler distribution. The second half needed two new fields on the `inject` line — the
core section's size and hash, and a process id, because two sessions append to one log file and
a line from the other one is not "the previous prompt". Lines written before those fields exist
are counted as `legacy` rather than silently read as "the core changed". Without this loop every
change below is argued from fixtures again, and the last three rejected fixes were only rejected
because someone measured.

**3.1 Delta injection — built 2026-11-04.** Per-session state holds the text of every
section this session was shown. A section whose text is unchanged is shown as a pointer;
a knowledge file that changed anywhere on disk is shown again in full, because a pointer to
a stale copy is a worse outcome than the bytes it saved. State is dropped on `session_start`,
`session_compact` and `session_tree`, the three events after which the earlier copy may not
be in the transcript any more. A pointer is only used when it saves at least 200 characters,
because a pointer to a two-line file makes the prompt longer.

Measured by `npm run measure` over the bank's own 140 logged prompts in 47 sessions, with the
pointer turned off for one run and left on for the other — same script, same bank copy, same
session boundaries:

| | pointer off | pointer on |
|---|---|---|
| characters sent | 3,037,134 | **1,549,933** (−49 %) |
| of which the session already had | 1,494,441 (49 %) | **54,988 (4 %)** |
| median prompt | 22,518 | **9,442** (−58 %) |

`npm run measure -- --control` reproduces the left column.

What a skipped section looks like in the block:

```
`core/dailyContext.md` unchanged since earlier in this session — it is above in this
conversation; memory_read "core/dailyContext.md" for it
```

It decides nothing about relevance, so it cannot make relevance worse: the same files are
chosen by the same rule, and only the copy of a copy is withheld.

**3.2 A character cap on injected knowledge — built 2026-11-04.** Knowledge and history files
are now capped at 6,000 characters as well as 100 lines, whichever bites first, with the cut
described in the unit that caused it and the character count kept in the log (`cu`). The
threshold is above the median file in this bank (2,576) and its mean (4,209): the target is
the 6.7–8.5 KB files, not ordinary ones. A cut under 500 characters is not made at all, which was found by watching a real prompt pay
44 characters of note for 44 characters of cut. The line cap stays: it is the rule the writing
guideline is stated against, and a file that trips only the line cap is a file whose lines are
long, which is the same problem in another unit.

**3.3 A floor that has a scale, and topic stickiness.** Adopt
`score ≥ A × distinctContentTerms(query) && score ≥ 0.25 × top` with A from the table in
2.3 (start at 5, i.e. 24 % of the tail removed, rank 1 intact), and for queries below three
content terms do not re-rank at all: keep the previous turn's files. Both halves need
fixtures, and the fixtures should be the logged prompts, which is why 3.0 comes first.

**3.4 Bank hygiene — aliases rewritten 2026-11-04, the rest open.** The alias lists of
`stale-index.md`, `project-scope.md` and `broad-fs-scans.md` were rewritten to drop the words
any agent prompt contains (`session`, `write`, `file`, `note`, `search`, `noise`) and keep the
phrases a prompt about *that* file would use. In the replay afterwards, `stale-index.md` left
the most-kept list entirely; `project-scope.md` stayed in it, because its H1 title — not only
its alias list — is made of `project`, `knowledge` and `files`, and a title cannot be rewritten
without renaming what the file is about. That is the honest limit of this lever: aliases move
a file down the ranking, they do not make it stop matching a bank full of projects.

Two parts of this step are deliberately not done. `### Carried Forward` is 15 items and
3,783 characters, so every prompt pays 2,500 of them (the section cap) and loses the rest
behind a marker — but the items are live work in four other projects, and pruning them is a
decision about that work, not about injection cost. And the three files at or past the
100-line guideline (`record-alpha.md` 125, `record-beta.md` 103,
`record-gamma.md` 100) are still three files, because splitting them changes every
reference to them and §3.2 already bounds what they cost a prompt.

## 4. Deferred, with the reason

**One rolling block instead of an append-only pile.** pi exposes `context` and
`context_with_system`, fired before every LLM call, and either can return a replacement
message list; `context_edit` entries can retire an earlier entry outright
(`replacement: null` omits its target from model context). So memory could be one
freshly-built block per request rather than a pile that never shrinks — the real fix for
the 110,603-token window. It is deferred because: the block leaves the transcript, and the
transcript is the audit trail the usage log was built to protect; `docs/extensions.md` warns
that a changed message list costs the cached prefix that an unchanged list keeps; and the
handler shares the hook with any other extension that prunes context. Do it after 3.1 and
3.0 exist — 3.1 takes most of the win at a fraction of the exposure.

**Project scoping.** Designed, measured, and measured as orthogonal (see the link above).
Approve it for cross-project privacy, not for cost.

**Recency in ranking.** A real defect — the 47 injected history files had a median age of
4 days, and `2026-10-27-dailyContext.md` won 31 times because a week-old task list is a
word sponge. But BM25 has no time term and every decay constant is currently a guess the
replay cannot refute. Record it as a follow-up to 3.3, once the replay separates the two.

**Fuzzy and prefix.** Already measured and left alone; see the comment in
`search.ts:MemoryIndex.makeIndex` and the README's limits table.

## 5. What is working and should not be touched

`memory_update` refused two stale writes and said why; `index` events (6) show the
`write`/`edit` watcher doing the job that fixed the staleness defect
(`knowledge/stale-index.md` in the bank is one of the four noise magnets — its content is
sound, its alias list is not); the per-section cap on `dailyContext.md` is
visible in real prompts trimming `### Carried Forward` while leaving sibling sections
whole; log volume is 68 KB for a month of heavy use against a 5 MB stop.

## 6. Baseline to beat

Re-measure with `npm run measure` (cost), `npm run replay` (a candidate rule), and
`/memory log stats` (what the last weeks actually did). Measured 2026-11-04, same bank:

| Metric | Baseline | after 3.1 | after 3.2 | target after 3.3 |
|---|---|---|---|---|
| Injected bytes already sent earlier in the session | 39 % | **4 %** | 4 % | ≤ 5 % |
| Characters per prompt, median | 22,518 (measured, not 19,000) | 9,442 | 9,442 | ≤ 9,000 |
| Slots scored 0 | 22 / 326 | 22 | 22 | 0 |
| Slots under 5 | 66 / 326 | 66 | 66 | < 20 |
| Slots 2–3 cut by floor | 0 % | 0 % | 0 % | ~25 % |
| Wanted file still injected (fixture set) | unchanged | unchanged | unchanged | unchanged |
| Rank-1 survivors under the floor | — | — | — | ≥ 95 % |

Read it with two things in mind. The 4 % is not zero: it is the same pointer line repeated in
prompts whose entire content was pointers, 1.2 KB a prompt instead of tens of KB, and it shows
up as the largest re-send when you run the measure. And the rows §3.1 and §3.2 did not move —
they are §3.3's and §3.4's rows, and neither has shipped. Those two made the prompt cheaper,
not the selection better, which is the distinction the whole document is organised around.

The last two rows are the veto: a step that reaches the cost targets by losing files the
fixture set says must arrive does not ship.

## Appendix A: the replay harness

`scripts/replay-injection.mjs`, run with `npm run replay` (`-- --bank <dir>` to point it at
another bank, `-- --cuts 3,5,8` to price other constants). It loads the real `search.ts` so a
replay cannot drift from the shipped scorer — `jiti` is a declared `devDependency` for that
reason, not a borrowed copy under `node_modules` that belongs to vitest — reads every
`usage-*.jsonl` in the bank, deduplicates prompts by text, ranks them, and prints the score
distribution and the candidate floor table. Its own header records the three limits worth
repeating: the bank is today's, retried prompts are one question, and it prices rules without
judging them.

Real output of `npm run replay`, 2026-11-04 — 130 inject events, 99 distinct prompts, a
44-document bank, 287 tail slots:

```
Score per distinct content term, by rank — absolute score has no scale, this has one:
  rank 1  n=97   p25 14.6  p50 27.8  p75 48.7   | distinct terms p50 8.0
  rank 2  n=96   p25 10.4  p50 18.2  p75 31.1   | distinct terms p50 8.0
  rank 3  n=96   p25  7.0  p50 15.7  p75 24.5   | distinct terms p50 8.0

Candidate floor — score >= A x terms AND score >= 0.25 x top — priced on the 287 tail slots,
which is where the filler lives (rank 1 is what a prompt asked for, and is never cut):

  A=3  keeps 239/287  (17% of the tail removed)
     most removed: 2026-10-31-dailyContext.md 6, record-beta.md 4,
                   2026-10-29-dailyContext.md 4, local-llm-thinking-turn-cutoff.md 3
  A=5  keeps 217/287  (24% of the tail removed)
  A=8  keeps 198/287  (31% of the tail removed)
     most kept at every A: record-gamma.md, 2026-10-31-dailyContext.md,
                           stale-index.md, project-scope.md
```

Read the last block before approving any A. The floor trims the long tail, and it barely
touches `stale-index.md` and `project-scope.md` — two of the four files §2.2 named as buying a
third of all injected bytes together. They are the most-kept files at every candidate: 12 and 11
slots at A=3, still 10 and 9 at A=8. They score well because their aliases are the words real
prompts use, which is exactly the problem a score rule cannot solve. A floor and clean alias
lists are two different fixes, and 3.3 does not substitute for 3.4.

The two things the script must gain before 3.3 is shippable: the fixture set of
`(prompt -> file that must arrive)` pairs, and a re-measure against a bank snapshot from each
prompt's own date, so this table stops being retrospective.

## Appendix B: where each number came from

| Number | Method |
|---|---|
| Block size, 5 empty injects, score histogram, rank ratios | `inject` events in both monthly log files |
| 4-file share of injected bytes, mean 4,209 chars, 6 % hitting the line cap | `inject` events joined to file sizes on disk, capped at 100 lines as the code does |
| Composition by section (59 / 35 / 6 %) | same corpus of files, a second scan minutes earlier over 511 blocks — the two whole-corpus scans differ by a dozen blocks because measuring sessions inject too |
| 57 % / 45 % / 39 % re-send, 522 blocks, 3.73 MB | `custom_message` entries with `customType: "memory-context"` in `~/.pi/agent/sessions`, compared to the previous block in the same file |
| 76 % not-new-in-session | same, over the 40 most recent session files |
| Token share, peak window tokens | `usage` on assistant messages, summed over requests, with the memory blocks live at that request reset at each `compaction` entry; 3.6 chars/token |
| History age distribution | date parsed out of `history/daily/YYYY-MM/YYYY-MM-DD-dailyContext.md` paths |
| Norm tables and cut table | Appendix A |
