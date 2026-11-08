# Design: three things worth porting from the entry-keyed memory extension

Status: **§3.5 shipped 2026-11-04; §3.6 and §3.7 planned, nothing built.** These are §3.5–§3.7 of
[`injection-cost-design.md`](injection-cost-design.md) §3, written here because they come from a
different component and one of them is not about cost at all. The queue itself stays in that document
— one order, not two — and it keeps its rule: **cost before quality, so §3.3 ships before the
half of §3.5 that spends the same measurement.**

Source of the ideas: `rl-pi-extensions/extensions/memory` (21 modules, ~10.2k lines, 285 tests),
compared with this component in `knowledge/memory-extension-comparison.md`. That component is **not
enabled and its bank holds only `config.json`**, so what follows ports ideas, not code: it has no
measurement to inherit, and its own README asks that its rollover classifier be judged in real use
rather than in tests.

## 0. What the live bank says about each one

Measured 2026-11-04 over 36 knowledge files and 146 `inject` events in
`~/.pi/memory3/logs/usage-*.jsonl`, using the doctor's own topic probe (`index.ts:overlappingTopics`:
the file's H1 as a query, `TOPIC_PROBE_HITS` 5 hits, kept at ratio ≥ `TOPIC_OVERLAP_RATIO` 0.35):

| Measurement | Value | Consequence |
|---|---|---|
| Rival pairs in the bank at 0.35 | **1** — `emacs-cpp-setup.md` ↔ `emacs-config.md` (0.39) | §3.7 has almost no demand today; instrument before gating |
| Prompts that carried **both** halves of a rival pair | **0 / 146** | the contradiction problem is real in principle, unobserved here |
| Files admitted per prompt | 3: 84 · 2: 51 · 1: 5 · 0: 6 | slots are normally full, so the third file — not a cap — is where the cost is |
| Third slot owned by knowledge, not history | 128 / 135 (95 %) | a **per-class** reserved budget, which is what rl actually has, protects nothing: knowledge crowds knowledge |
| Knowledge files over the 6,000-char cap | **7 / 36** (9,576 → 6,065) | truncation is not hypothetical, and §3.4 chose bounding over splitting, so anything designed now lives with oversized files |

Two of these moved priorities while this plan was being written: a bank with one rival pair does not
need a gate, and a bank whose third slot is knowledge does not need a per-class cap. What survives is
the skip-instead-of-truncate rule, path tiers with shadowing, a duplicate-topic note that starts as a
sentence, and a total cap **only if §3.3 leaves a tail for it to cut.**

### 0.1 Two measurement notes, both from the log, both load-bearing

- **Only 11 of the 146 logged prompts ran the §3.1/§3.2 build.** A line carries `cc`/`ch`/`sid` only
  when the code that wrote it had them: 135 lines do not, because sessions opened before those
  commits are still running the old build — pi reads the package's `index.ts` at process start, and
  the package path is this working tree. So: filter the log to lines with `cc` before quoting any
  per-prompt cost, and the live check §3.1/§3.2 was supposed to pass (`pt:` rising, re-sent core near
  zero) is still **not evidenced at n = 11**.
- **The log's `chars` and §6's "characters per prompt" are different numbers, and only one of them
  sizes a constant.** On those 11 lines: `chars` median **17,527**; non-core (`chars − cc`, what the
  knowledge and history sections cost) median **11,156**, p90 16,701, max 17,179. §6's 9,442 is
  `npm run measure`'s reconstruction, which dedups retried prompts and rebuilds sections from today's
  bank: the right number for the §6 series, the wrong number to budget against. A 10,000-character
  knowledge cap would have bitten on 9 of 11 prompts; 12,000 on 5 of 11. n = 11 is a pilot.

---

## §3.5 Skip instead of truncating — **shipped 2026-11-04**; the total cap waits for §3.3

**What rl has that this does not.** A claim that does not fit is **skipped and named, never
truncated** — "a truncated rule is a new rule" — under one budget for the whole injection. pi-memory3
has the opposite halves: `MAX_INJECTED_FILE_CHARS` / `capFile` cut a record's tail (§3.2, on purpose,
because keeping the head keeps the point and loses the source notes), and there is no total, so
non-core content costs a median 11,156 characters a prompt with no ceiling.

**Shipped.** `search.ts:MAX_WITHHELD_SHARE = 0.5` and `withheldShare(fullChars, hiddenChars)`,
called by the injector after `capFile`. Past half, the file is not sent; a line names it, in the same
breath says how to read it, and the debug line and the log report the number the injector used
rather than recomputing one:

```
- knowledge/x.md (19,230 characters) is not in this prompt: 87 % of it is past the injection cap — memory_read "knowledge/x.md" for the whole file
```

Three consequences the design pass did not predict, all of them the rule's point:

- **§3.2 was sending titles.** `capFile` cuts at the last newline before 6,000 characters, so a
  file with few line breaks arrived as its heading plus a marker — one fixture in this repo's own
  §3.2 tests was 11,195 characters arriving as 22. Two fixtures were rewritten with real lines,
  because a truncation rule is only interesting when the file keeps most of itself.
- **A withheld file is a partial view**, so `memory_update` over it is refused. Having read none of
  a file is a stronger case for refusing than having read half of it.
- **It is never a pointer.** §3.1 replaces text the model already has with a sentence saying so,
  and for a withheld file that sentence would describe a transcript that never received the text.
  It is named again on every prompt that ranks it, and `in` excludes it — a log that counts it as
  sent makes every number built on `in` quietly wrong.

**Live impact, measured before and after.** In this bank as it stands, 9 of 47 files are cut by the
caps and **1** trips the withhold rule: `history/daily/2026-10/2026-10-31-dailyContext.md`, 14,091
characters arriving 57 % hidden, an archived daily context whose 84 lines are long enough that the
line cap never bites and the character cap lands near the middle. That is the case the rule exists
for — a prompt about one bullet in that file would have received its first 6,000 characters and no
way to know the bullet was not among them. Everything else keeps §3.2's behaviour: `broad-fs-scans.md`
still arrives at 5,945 of 6,669 characters with the marker. So the rule is narrow today, and the
number that says whether it stays narrow is `withheld` in `/memory log stats`.

Two changes from the plan above. The log fields are `wc` (files withheld) and `wch` (their
characters) rather than `kc`/`sk`: `kc` would have been `chars - cc`, and a field that repeats an
arithmetic combination of two others is a field that can disagree with them. What the plan needed
from it — a distribution to size a budget on — is computed from those lines and printed by
`/memory log stats` as `knowledge per prompt: p50 …, p75 …`. And the reason rides on the existing
`out` array rather than a new call inside `admitsToContext`: that function answers "is this
candidate eligible", and a file that won the ranking and then lost the size rule is a different
question with the same witness — one number, three callers, pinned in `search.test.ts`.

**Do not port the per-kind half.** The 95 % row is the refutation: a reserved class would only
shrink the pool that is already filling the slots.

**Deferred: `MAX_INJECTED_KNOWLEDGE_CHARS`.** A floor at `A ≥ 5` per content term removes 24–26 %
of the tail by dropping low-scoring files; a size cap drops the smallest files. They are two answers
to "the third file is not earning its place", and the relevance answer is the one with a veto test
(§6's last two rows) and a harness already pricing it. If, after §3.3, the `p75` in `log stats` is
still above the candidate 12,000, add the cap: best-first, a file that does not fit whole is skipped
and named, `capFile` truncating only inside a file that fits. If the floor lands under it, close the
item as not needed rather than ship a constant nobody hits.

**Tests.** `search.test.ts:withheldShare` pins the boundary (half arrives, 501 of a 1,000 does not,
an uncapped or empty file is never withheld). `handlers.test.ts` → "a record too big to send"
covers the mixed case (one withheld, one whole, heading and recency note still present), the
withheld heading variant when nothing arrives, the never-a-pointer rule, the refused
`memory_update`, the debug line, `in`/`out`/`wc`/`wch` in the log, the 2 KB line bound, and
`log stats` over a synthetic month whose last line has no `wc` at all — because zero and "predates
the rule" are not the same fact. The two rewritten §3.2 fixtures keep the cut path covered.

Measured: 248 tests, typecheck clean, `npm run smoke` clean, `npm run race` unchanged.

---

## §3.6 Path tiers with shadowing

**What rl has that this does not.** `global` < `path:<glob>` < `project:<name>`: a narrower scope
*shadows* a wider claim for the same key, and the shadowed one is reported as shadowed instead of
vanishing, so "why wasn't my note used?" has an answer.

**Read [`project-scope-design.md`](project-scope-design.md) first.** It is already designed and
already measured — scoping kept every wanted file injectable and left the noise unchanged (5→5, 5→4,
5→5) — and `injection-cost-design.md` §4 records the conclusion: approve it for cross-project privacy,
**not** for cost. This section adds only what that document lacks: what happens when two eligible
files are about the same thing.

**Design.**

1. Eligibility as designed there: tier from the path at read time — `knowledge/<project>/…` narrower
   than `knowledge/shared/…` narrower than flat `knowledge/*.md`; derived, never stored;
   `scopeMode: "off"` reproduces today's bytes; injection filters, `memory_search` labels.
2. **Shadowing**, the new rule: among the files that pass the top-3 cut, when two are topic-rivals
   (the §3.7 probe, same call) **and** in different tiers, inject the narrower and name the wider —
   `- knowledge/x.md shadowed by knowledge/<project>/x.md — same topic, narrower scope`. Never when
   the tiers are equal: two flat rivals is a hygiene problem for `/memory doctor`, not a ranking
   decision, and silently choosing between them is the failure this bank exists to avoid.
3. No new identity system, which is the point: identity is the file path, rivalry is topic
   similarity, so a claim cannot dodge a rule by being renamed — the weakness the entry-keyed gate
   documents about itself.
4. Behind `scopeMode`, default off. A 36-file bank with one rival pair does not earn a new concept in
   the writing guidelines, which is the cost that document warns about in terms.

**Test plan.** The six cases there, plus: two flat rivals never shadow one another and both stay; a
shadowed file is named, never silently absent; `memory_search` returns out-of-scope hits labelled;
`scopeMode: "off"` is byte-identical to today.

**Go / no-go.** Build when bleed is observed in the live log — a file admitted whose project differs
from `ctx.cwd`'s — or when the §3.7 instrument reports its first co-injected rival pair across tiers.
Until then the zero-code levers hold: `PI_MEMORY_DIR` for a wall, alias lists for noise.

---

## §3.7 A duplicate-topic note on a *new* knowledge file

**What rl has that this does not.** The gate distinguishes **amending what you own** (authoring, never
questioned) from **asserting a second claim about one thing** (refused until a human decides).
pi-memory3 has that distinction nowhere: a brand-new path that restates an existing file is accepted
silently, and BM25 has no time term, so the older, better-aliased rival can rank first — measured,
not theorized: Monday's blue beat Tuesday's green 115 to 52.

**Design.**

1. Lift the probe out of `doctorReport`'s helper into `search.ts` as `topicRivals(index, relPath,
   content)` — the title-against-index query `overlappingTopics()` already runs. Doctor calls it too,
   so the warning and the note cannot disagree about what "same topic" means.
2. `memory_update` on a path that **does not exist yet**: if a rival clears `TOPIC_OVERLAP_RATIO`,
   append to the success message —
   `Note: knowledge/y.md covers the same topic (0.41). If one supersedes the other, read it and restate in place — both get retrieved, and either can rank first.`
3. `memory_update` on an existing path says nothing: that is authoring.
4. `memory_append` is untouched — it cannot create a file.

**Why a note and not a refusal.** `knowledge/decision-reversals.md` says never auto-resolve, and a
refusal is not a resolution — but a wrong refusal teaches the agent to route around the tool with
`write`, which is the exact hole this component had to add a watcher to plug. Start as a sentence, the
way scan-guard shipped notify-only and flipped on evidence. Revisit if duplicates keep arriving: a
`dup` field on the `write` event counts how often the note fires, and `/memory doctor` already lists
the pairs, so the evidence is one `log stats` away.

**Test plan.** New path with a rival → note naming it; same content at an existing path → no note;
below ratio → silence; rival outside `knowledge/` → silence (core and history rival nothing); empty
index → no note and no error, because a probe that cannot answer must not speak.

**Cost.** One extra index query per new-file write, ~0 ms at this bank size; nothing per prompt.

---

## 1. Deliberately not ported, with the reason

| rl feature | Why not |
|---|---|
| Entry stores; `## key` headings as identity | Keys are authored by the model, inconsistently, and the gate only sees rivals that share one — so paraphrase passes. The live bank's 36 files are 6–10 KB design notes, not one-line claims. |
| Pending-conflict queue and five resolutions | Nothing to adjudicate in a bank with one rival pair and zero co-injections. A dialog is paid for every turn until it is answered. |
| `kind` / `scope` / `asOf` / `status` fields | `asOf` is carried in prose plus the `RECENCY_NOTE` that says what the scorer cannot see. A field an agent must remember to write is a field that goes missing. |
| Separate non-authoritative working-state block | pi-memory3 injects the same two files and says which is which in the heading; rl needs the block because entries are a different surface. |
| Hand-rolled BM25 with pinned `k1`/`b` | MiniSearch scores are what every recorded number here is stated against; changing the scorer invalidates §6 and the fixture contract. |
| History excluded from recall | rl cannot retrieve a July daily at all. Archive recall is the one capability here that rl lacks. |
| `keep-both-flagged`, i.e. an identity goes dark | A question with no answer is indistinguishable from a memory that was never written. A named note inside a retrieved file is recoverable; silence is not. |

## 2. Order, and what each step re-runs

§3.5's skip-and-name went first, on 2026-11-04: unlike its total-cap half, it answers a different
question — "should a record arrive as a fragment?" — and does not spend the floor's measurement.
§3.3 (the floor) is next, per that document's cost-then-quality order, and it decides whether the
cap is ever needed. Then §3.7's note (a sentence, no gate), then §3.6 behind its flag once the
instrument has earned it. Each is one commit with its numbers, in this repo's habit: `npm test`,
`npm run typecheck`, `npm run smoke`, `npm run race` when a write path is touched, `npm run measure`
for anything that changes a prompt, `npm run replay` for anything that changes selection. §6's last
two rows stay the veto: cheaper is not better if a file the fixture bank says must arrive stops
arriving.

## Source

- Rodrigo asked for the comparison and then the plan, 2026-11-04; the ported items and this ordering
  are AI's recommendation, the measurement table and both priority downgrades came from the same
  session over the live bank and log.
- rl behaviour read from `rl-pi-extensions/extensions/memory` at `be93af3` (main) on 2026-11-04.
  `rl-10-20-memory-v4-spec-rebuild` retires that design (amendment A-10) for proposal-gated records,
  so re-read it before taking anything further from main.
- Per-class cap rejected, shadowing added in its place: 146 logged prompts, third slot 95 % knowledge,
  1 rival pair, 0 co-injections. Cost figures for the cap come from the 11 lines carrying `cc`
  (§0.1). All of these size the work; none of them certifies it — the limit `npm run measure` and
  `npm run replay` state about themselves applies to every number in this file.
