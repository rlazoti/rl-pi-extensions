---
summary: Persistent memory bank with full-text search — active projects, daily context, and auto-discovered knowledge.
commands: [/memory]
tools: [memory_read, memory_update, memory_append, memory_search, memory_list]
category: productivity
keywords: [memory, context, projects, knowledge, persistence, search]
---

# Memory — Persistent Memory Bank

Gives pi a personal memory bank that persists across sessions.

## What it does

**On every session start:**
- Archives the previous day's `dailyContext.md` to `history/daily/YYYY-MM/` when the date rolls over — only a day that has passed; a file dated ahead of today (a UTC-dated heading) is left alone
- Carries "Context for Tomorrow", and anything already carried, into the new day — the rest of the daily file is archived
- Builds a full-text search index over all memory bank files
- Scaffolds default memory bank files on first run

**On every prompt:**
- Injects `activeProjects.md` and `dailyContext.md` into context
- Searches for relevant knowledge and history files based on the prompt content (BM25 + fuzzy matching via [MiniSearch](https://github.com/lucaong/minisearch)) and injects the best few. A file the size rules would leave as less than half of itself is named instead of sent — see [Limits worth knowing](#limits-worth-knowing)
- Stays silent while doing it; `/memory debug on` makes it say what it chose, and `/memory log on` records it

**Tools for the agent:**
- `memory_read` — read any memory bank file
- `memory_update` — write a full memory bank file, creating it when the path is new (whole-file replace; see [Two agents, one bank](#two-agents-one-bank))
- `memory_append` — append entries to a section without rewriting the rest of the file
- `memory_search` — fuzzy full-text search across all memory files (knowledge, history, core)
- `memory_list` — list files in the memory bank, every subdirectory included

**Command:**
- `/memory` or `/memory status` — bank status and the command list
- `/memory help` — show all subcommands and their options
- `/memory refresh` — rebuild the search index after external or cross-session edits, without restarting
- `/memory scope` — show the detected project scope and which knowledge folders are eligible here
- `/memory revisions [file]` — list bounded local recovery snapshots taken by managed writes
- `/memory restore <file> <id>` — restore one snapshot, backing up the current text first
- `/memory doctor` — health checks: knowledge gone stale, a file too big to inject whole, two files that look like the same topic, a daily file rollover can't date, a daily file dated in a future day, the index out of step with disk, and what the every-turn core files cost per prompt
- `/memory config [key] [value]` — how often each content type is injected
- `/memory debug [on|off]` — print, per prompt, which files were injected, their scores, and what was turned down
- `/memory log [on|off|prompts [on|off]|stats]` — record prompts and what injection did with them, in a file you can read

## Memory bank location

```
~/.pi/memory3/
├── core/
│   ├── activeProjects.md    # Active work and priorities (max 50 lines)
│   └── dailyContext.md      # Today's work, decisions, carry-forward (max 150 lines, 6,000 characters)
├── knowledge/
│   └── *.md                 # Reference docs — auto-discovered via search
└── history/
    └── daily/
        └── YYYY-MM/
            └── YYYY-MM-DD-dailyContext.md   # Archived daily contexts
```

Override the location with `PI_MEMORY_DIR` env var.

Four results name a place, and those four name the **whole** place — `Updated knowledge/x.md (1,204 bytes) → /Users/you/.pi/memory3/knowledge/x.md`, the same `→ path` on `Appended to`, and the full path in both `File not found:` and `Section "…" not found in`. Everything else stays relative: a read returns the file and nothing above it, `memory_search` prints `Path: knowledge/x.md`, `memory_list` prints entries under their own root. The rule is about doubt, not tidiness. A relative path is a claim about a root the message never states, and an agent that cannot see the root assumes the one it is standing in — which is how a `write` of `knowledge/example-port.md` from a project session turned into a 179-second `find /` looking for the agent's own note.

## Two agents, one bank

The bank is global, so two Pi sessions share it. `memory_update` and `memory_append` now serialize with a per-file directory lock; writers outside these tools do not participate:

| Two sessions doing | What happens |
| --- | --- |
| both `memory_update` the same file (read → compose → write) | the second write is **refused**, with an instruction to re-read and re-apply |
| one overwriting a file it was only ever shown truncated | also refused — it holds 100 of 300 lines, and replacing the file would drop the rest |
| both `memory_append` to one file | serialized; 120 of 120 survived one zero-gap race probe |
| one searching after the other wrote or edited a file | finds it: retrieval reconciles disk first, so search and `memory_list` agree (the `index` race probe asserts both) |
| both starting on the first morning after a gap | safe: one archive, carry-forward intact |
| one reading a file the other is rewriting | cannot happen: writes land by rename, so a reader sees the old file or the new one |

`memory_update` replaces whole files, so it records what each bank file looked like when this session was shown it — injection counts as showing it, since that is the only copy the agent has — and refuses when the disk version has moved on. A new session starts from nothing, because a refusal justified by a copy some earlier agent saw is not explainable to the one holding it. The window this closes is wide: agent A composes for a minute while agent B writes, and A has no reason to suspect anything.

Two more things make the rest survivable rather than catastrophic. Writes are atomic renames, so no reader ever sees the gap between truncating a file and filling it in — before that, 5 to 12 of 300 reads taken while another session wrote a 5 KB file came back **empty**, and an empty read that an agent writes back is a lost file, not a stale one. And `npm run race` asserts both facts: the rollover and torn-read rows are checks that fail the run, not statistics.

An existing file this session never read is refused by default; `allowUnread: true` explicitly permits a blind replacement, but never bypasses a stale or partial-view refusal. Before update or append, only `ENOENT` means the target is absent; permission and other I/O failures refuse the write, even with `allowUnread` and even with revisions off. Versions are SHA-256 fingerprints of the text actually served, compared with current content under the write lock—not modification time and size. Compaction and tree navigation discard served-version state too. The lock coordinates `memory_append`, `memory_update` and daily rollover in updated processes: harness writes/edits, shell tools and older sessions do not acquire it. If a process crashes while holding a lock, subsequent writes time out and refuse; after verifying no writer is active, remove its lock directory under `<bank>/.write-locks/` manually. Locks are never stolen automatically.

The search row used to be the one to know about, because "no results" is the answer that makes an agent record a decision *again* instead of correcting it. It no longer is: each process keeps its own in-memory index, but reconciles it against disk (device, inode, size, nanosecond mtime/ctime, then a content hash) before every search and injection, so another session's or your editor's writes are visible immediately. `/memory refresh` remains for a forced full rebuild. What reconciliation does **not** do is treat a search snippet or a harness read as a complete copy in hand — that is what the served-version fingerprints are for, and they stay separate.

Reproduce the table with `npm run race` — about a minute, two real extension processes, a throwaway bank, not part of `npm test`.

Paths resolve existing components to their on-disk spelling, giving filesystem case/Unicode aliases one bank-relative identity for locks, served versions, recovery and indexing. Distinct files on case-sensitive filesystems remain distinct; ambiguous non-exact hardlink aliases are refused rather than guessed. Symlinked files or directories below the configured bank root are refused, including ancestors of files being created; index scanning ignores symlinks. The configured root may itself be a symlink. Locks hash the on-disk bank-relative target, so different root aliases or mount paths coordinate through the shared lock directory. A short namespace gate serializes path resolution against creation: new targets retain it through commit, while existing targets release it before waiting for their per-target lock. The nested revision-store lock does not acquire that gate. This also protects case/Unicode aliases of targets that do not exist yet. Restart all cooperating sessions together after upgrading path/lock identity rules; old sessions do not implement these guarantees. These checks prevent accidental escapes, not hostile directory replacement races by another process with the same OS privileges.

If you would rather the sessions not share at all, that needs no code: set `PI_MEMORY_DIR` per project.

## How knowledge discovery works

All `.md` files in the memory bank are indexed with [MiniSearch](https://github.com/lucaong/minisearch) — a lightweight full-text search engine: BM25 ranking, fuzzy matching with an edit budget that grows with word length, and prefix matching on terms of three characters or more (the rules, with examples, are in [Limits worth knowing](#limits-worth-knowing)). No external services, no model downloads, no configuration needed. There is no embedding model and no synonym bridge: ranking is by shared words, which is why [aliases](#aliases-the-one-ranking-lever) matter.

When you send a prompt, the extension automatically searches the index for relevant knowledge and history files:

- **Knowledge files** are included when they match and rank in the top three (default `legacy` policy)
- **History files** are included when they score strongly relative to the top result
- **Core files** (activeProjects, dailyContext) are always injected directly, never via search

The search index is rebuilt on session start and reconciled incrementally **before every retrieval**. A metadata manifest (device, inode, size, nanosecond mtime and ctime) detects additions, replacements, edits and deletions—including other sessions, editors and bash. Changed files are hashed; merely touching unchanged text does not alter BM25 statistics. Memory-tool and watched harness writes also reconcile immediately. This is a local filesystem freshness mechanism, not a transactional snapshot against arbitrary external writers.

### Aliases: the one ranking lever

BM25 ranks on shared words, and there is no synonym bridge and no embedding model — a knowledge file can only surface for a prompt that uses words **the file itself contains**. So write those words down deliberately, in the heading. The whole file text is indexed, heading included, and the heading *additionally* gets its own index field weighted 3x (`search.ts:118-122`): dropping that field costs a heading-only match about 75% of its score. Aliases in the H1 therefore decide which files survive the top-3 cut and whether a history file clears the 50%-of-top-score bar — they are about ranking, not about whether the file is findable at all.

```markdown
# Proposal tone (proposals, pitches, outreach, hedging, assertive voice)

Confident and direct. No hedging words like "maybe" or "perhaps".

## Source
- Rodrigo, 2026-10-02, proposal review thread
```

Three to eight aliases, phrased as the words a future prompt would use rather than as a restatement of the title. They show up in `memory_search` results, which is deliberate — a stale alias is visible.

An alias list is not a list of phrases. The index splits on punctuation, so `(change my mind)` is really an alias for `change` and an alias for `mind` — and a prompt about rebuilding a Docker layer says "change" too. That collision is measured: in `injection-eval.test.ts` the reversal-decision file is the top hit for a Docker question, at 64, on the word `change`. Prefer words a prompt about something else would not need.

### Legacy `index.csv` (not read)

Older versions of this extension routed knowledge files through a hand-maintained `knowledge/index.csv` of trigger words. Nothing reads that file any more: the index walks `.md` files only, so a `.csv` is skipped on build and on update. Aliases in the heading are the replacement, and older banks may still contain an `index.csv` that is safe to delete.

## Usage log

`/memory debug` tells you what happened while you watch. It is gone by the next morning. The usage log is the same facts in a file, for the questions no fixture can ask: what do people actually type, and how often does the bank have nothing for them?

```
/memory log on        # start recording
/memory log stats     # events, cost, filler, injects that found nothing, most-injected files, last prompts
/memory log prompts off   # keep the decisions, stop writing prompt text
```

One JSON object per line, in `<bank>/logs/usage-YYYY-MM.jsonl`:

| `t` | What it records |
| --- | --- |
| `session` | One header per session: document count, injection settings, the caps in force. A later line can be replayed against a fixture bank without guessing how the session was configured |
| `inject` | The prompt (clipped to 300 characters), the core files that rode along, what the search put in with its scores, and up to six candidates it left out **with the reason each was left out** — including any file the ranking chose and the size rule then withheld, which is listed as left out and never as sent. Plus what the cost question needs: `cc` and `ch`, the size and hash of the core part of the block; `sid`, which process wrote the line; and `wc`/`wch`, the files withheld whole and their characters |
| `search` | Every `memory_search` query, the hit count, and the top three paths — the vocabulary a real person used, which is what an alias list is meant to contain |
| `write` | A file written, or a write **refused** because its base moved. Counting refusals is how "nobody hits that" becomes a number |
| `index` | A bank file that a harness `write` or `edit` changed, and which tool changed it. This is what separates "the index lost a file" from "nothing announced it" — the first day of the log answered that question only because `write` named the two files that came through the tools and the seven that did not |

Defaults, and why:

- **Off.** A prompt log records what you were working on. Nothing is written until you ask, and the file sits inside the bank, so deleting it is `rm`.
- **Prompt text is optional.** `logPrompts: false` (or `/memory log prompts off`) keeps scores, paths and reasons and writes `[redacted]` instead of your words. The decisions are still useful; the vocabulary is not.
- **Bounded lines.** A prompt is clipped and at most six rejected candidates are listed, so one event stays under about 2 KB. Two sessions append to one file, and a small line is what keeps appends from interleaving.
- **A cap, not a rotation.** Writing stops past 5 MB per month file, and `/memory doctor` says so. Filling a disk in silence is worse than losing the log.

The reason it exists: the eval fixtures in `injection-eval.test.ts` are questions this project invented. They can say whether a change broke something. Only real prompts say what to build next, and a log line is one step from being a test.

### What a prompt costs

`/memory log stats` ends with five numbers, each stated with the denominator it was computed
over, because a log started this morning would otherwise be read as a rate over three prompts:

- **re-sent** — how often consecutive prompts of the same session got the same core (`ch` unchanged) or the same set of knowledge files, and how many characters that was. Measured against the transcript before any of this was logged: **39 % of injected bytes were identical to what the previous prompt had already paid for** ([design](docs/injection-cost-design.md)).
- **filler** — the median score-per-content-term of the second and third files, which is the number a relevance floor has to be chosen against. Absolute score cannot be the ruler: it multiplies with query length, and logged prompts spanned 0 to 779,977.
- **admitted** — how many injected files scored nothing at all. A file that scored zero got in on one shared word, and no relative rule can see it happen, because there is no top score to be a fraction of.
- **knowledge per prompt** — p50 and p75 of `chars - cc` over the lines that report a core size: what the non-core part of the block costs, measured on the prompts that were actually sent. This is the number a total knowledge budget would be sized from, and it is deliberately not `npm run measure`'s figure, which dedups retried prompts: sizing a 10,000-character budget on 9,442 would have cut in on 82 % of the logged prompts.
- **withheld** — files the size rule named instead of sending, and what they would have cost. Only printed when non-zero, because "zero" and "this log predates the rule" must not look alike.

`npm run replay` reads the same log and drives the actual injection handler against a temporary copy of today's bank, including category eligibility, pointers, caps and withheld records. It reports only admitted knowledge/history slots—not four raw search ranks. Both replay and measure split on session IDs, transcript reset events and per-session 30-minute gaps. Legacy prompts without an ID are isolated and counted, not assumed to share a conversation. Retries remain actual prompt events; old tables using time-only grouping are not directly comparable. It ranks against the bank as it is now, so it sizes a cut rather than certifying one, and it prints that warning itself. Whether the file you *wanted* survived needs labels. `npm run eval` now runs 34 frozen cases and 14 snapshots through that same handler, reporting required recall, relevant-slot precision, no-memory accuracy, and characters. `--json` includes observations; `--strict` fails on any labelled discrepancy. The fixtures are assistant-authored and explicitly provisional—not owner-reviewed ground truth. The separate real-bank draft in `docs/retrieval-eval-draft.md` still needs snapshotting and owner review before tuning a default relevance floor.

## Limits worth knowing

Injection is bounded, so what the model sees is not always the whole file.

| Limit | Value | What happens past it |
| --- | --- | --- |
| Knowledge/history files per prompt | 3, best-scoring first | The rest are dropped — `/memory debug on` names them and why |
| Lines **or** characters of each injected knowledge or history file | 100 lines, 6,000 characters | Whichever comes first, with `… N more characters not shown — memory_read "…" for the whole file`. A cut under 500 characters is not made, because the note would cost more than the cut |
| How much of one file a cut may take | half of it | **The file is not sent.** One line names it — `knowledge/x.md (19,230 characters) is not in this prompt: 87 % of it is past the injection cap — memory_read "knowledge/x.md" for the whole file` — because three quarters of a note, with no marker where the rest was, is a wrong claim with a pointer to the right one, and the bottom of one of these files is its `## Source`. A file that loses less than half still arrives cut, with the marker above. If nothing in the section got through, the heading says so and the "follow the most recent" note is left out, since it is about disagreement between records. `wc` and `wch` in the log count withheld files and their characters |
| A section this session has already been shown | unchanged text, same session | Replaced by `core/dailyContext.md unchanged since earlier in this session — … memory_read "…" for it`, measured on this bank as 22,518 → 9,442 characters a prompt. Dropped on a new session, a compaction, or a tree navigation, because after those the earlier copy may not be in the context; a file whose text changed anywhere is shown again in full |
| Lines **or** characters of each injected core file | 300 lines, 8,000 characters | Whichever comes first, and `core: dailyContext.md (4,412 chars hidden)` in the debug line. Core is injected every prompt whatever you ask, so this is the one path that had better not be unbounded |
| One section of an injected core file | 60 lines, 2,500 characters | The section is trimmed and named — `… 1,935 characters (7 lines) of "Carried Forward" not shown — memory_read "core/dailyContext.md" for the whole file` — and its neighbours are left alone |
| `memory_read` response | 2,000 lines or 16,384 UTF-8 bytes | Names an incomplete read; `memory_update` refuses a whole-file replacement from that view. Read the rest and use a targeted edit. The byte cap reduces, but cannot eliminate, downstream truncation risk |
| Term length for prefix matching | 3+ characters | Shorter terms match exactly (`webh` finds `webhook`; `i` does not find `inventory`) |
| Fuzzy | `round(len × 0.2)` edits | one edit for terms of 3-7 characters, two for 8-12: `stuck` finds `stock` and `note` finds `node`, but `cache` does not find `case` |
| History files | must score over half the top *eligible* score | Otherwise the archive stays out of the prompt. Note what that does not do: when a daily file is the top candidate it is compared with itself, so the leading archive always enters and the bar only decides a second one |
| Function words in a query | closed-class stoplist, ignored | `"the"` cannot match a body, `"for"` cannot prefix-match `form`. A query of nothing else searches for nothing and says so |
| Entries returned by `memory_list` | 500 | Says how many it hid; pass a subdirectory to narrow the walk |
| Usage log | one file per month, stops past 5 MB | No more events are appended, and `/memory doctor` warns until you delete the file |
| Directory levels the index reads | 5 | Files below that are never searched — `/memory doctor` flags them |

The 100-line injection cap and the documented 100-line maximum for a knowledge file are the same number, which is worth saying out loud: a file sitting exactly at the documented maximum is the first file that starts losing lines. Treat 50 as the working ceiling and split anything longer.

**Both caps are reported, because they catch different files.** 100 lines of long paragraphs is 14,000 characters. Measured on a bank in daily use: 2 of 44 knowledge files were over the line cap and **7** were over the 6,000-character one — a line-only report called five silently-trimmed files healthy. `/memory doctor` now names the cap that binds each file, and for one past the half-withheld point says "injection sends its name instead of the file" rather than "truncated", which would be the wrong promise.

When the daily core file exceeds its total budget, `Context for Tomorrow`, `In Progress`, and `Key Decisions` are considered before older carried-forward material. Sections that fit are still displayed in their original order, and omitted sections are named.

**A line budget does not bound a cost, so the core caps are in characters too.** `dailyContext.md` was measured over four days at 4.5 KB, 6.2 KB, 5.5 KB and **14 KB**, every one of them inside the 150-line rule, all of it injected into every prompt of every project — because 150 lines of 90-character entries is 13 KB, and because `### Carried Forward` had grown to 4,412 of a file's 4,522 characters while `### Context for Tomorrow` held one line. Two caps follow. The character cap (8,000, against a written budget of 6,000 — the same "keep the cap away from the guideline" rule as 300 against 150) bounds what a prompt pays. The **per-section** cap (2,500, which cleared every section measured on a normal day, largest 2,328) is the one that does the work, and it exists because of where a cut lands: a whole-file cut keeps the top of the file, and the template puts `Context for Tomorrow` last, so the old behaviour spent the budget on a task list and dropped the plan. Measured against those same four days: the 4.5/6.2/5.5 KB days still arrive whole with no marker; 14 KB arrives as 7.3 KB, one section trimmed, no section lost; today's 4.5 KB arrives as 2.7 KB with `Carried Forward` trimmed and a marker naming it. When the file cap does bite it drops whole sections from the end and says which.

There is no relevance floor **by default** (`retrieval.mode = legacy`). A knowledge file enters a prompt when it scores more than zero and ranks in the top three, which means an unrelated prompt that shares one word with an alias list can pull a whole decision into context. Four fixes were measured; three were rejected, in `injection-eval.test.ts`:

- **A minimum score** — rejected, because BM25 magnitudes move with corpus size and document length (one prompt and one file scored 39 in a one-file bank and 176 in a sixty-file bank).
- **"Over half the top score"** — rejected, because filler reached 0.34 of the top while the newer half of a contradicted decision reached 0.45.
- **Directory scope** (`knowledge/<project>/`) — rejected *as a fix for this*: with scoping active, unrelated prompts pulled in the same number of files, because the eligible ones still matched on common words. It removes files from other projects and nothing else — see `docs/project-scope-design.md` for the measurement and the design if you want it anyway.
- **Dropping function words from queries** — accepted. Five prompts that share no content word with the bank used to pull in 15 files; they now pull in 9, at roughly half the score, and every wanted prompt still gets its file in first place. The cause was visible only after attributing each hit to the word that admitted it: `the`, `do`, `a`, `my`, and prefix runs from them (`for` found `form`, `does` found `do`).

The function-word list is closed-class on purpose, and a test holds the line from the other side: `"file"` and `"change"` still match, because a list that grows by adding nouns becomes a relevance floor nobody can see. Rewriting alias lists to rarer words was measured too and changed nothing (15 files in, same recall) — the writing advice above is about collisions, not about noise.

Fuzzy matching was measured rather than tuned by feel: no tightening of it removed a wrong file from the top three on realistic prompts, while turning it off lost the right file to typos. If injection ever seems noisy, the suspicion usually lands on the wrong knob — it is more often that three files are injected and the second and third are filler, which `/memory debug on` will show you.

Cross-process staleness is reconciled before search/injection, not deferred to a new session. The two-process `index` race probe now requires `search=true list=true`; same-count edits, same-mtime changes, renames and deletions have regression tests. `/memory refresh` remains a forced full rebuild and recovery command. Index freshness does **not** bless a search snippet or an unrelated harness read as a full-file write base; stale-write protection remains separate.

`memory_list` has no depth limit: it used to stop three levels down, which made the answer depend on where the walk began — `memory_list("history/daily")` showed the archived days and `memory_list()` hid them, and the same was true of any knowledge file in a subdirectory. Depth is the wrong thing to bound anyway: a thousand files sitting two levels down were always listable, so the cap stopped you seeing the fourth level and still let you ask for 30 KB of output at once. Entries are what cost, so entries are capped, and the cut is announced.

## Agent guidelines

The extension injects prompt guidelines that shape how the agent maintains memory.

### Which tool writes the file

> Write bank files with memory_update, not the harness file tools: it creates a missing file, and its write is checked against what this session was shown. A write around it is blind, and reaches the search index only because the extension watches write and edit results — bash and editor writes wait for the next session.

The tools used to lose to `write` for one structural reason: an agent with a new file has nothing to read first, and `memory_update` read as update-only. So the description now says it creates the file, and the results of the other tools are watched. Trusting the guideline alone would leave every writer outside it unhandled, which is why the watcher is the fix and the guideline is the polish.

One more reason the tools win now, which no guideline can say: their results name the absolute path they touched, and a harness `write` echoes the path it was given, relative in and relative out.

### Proactive knowledge capture

> When the user establishes conventions, tone/voice rules, architectural decisions, workflow preferences, or any reusable guidance — immediately store it as a knowledge file. Don't wait to be asked.

### Knowledge file discipline

- **Target 10-50 lines**, max 100 per file — and note that 100 is also where injection truncates, so longer files are read in pieces. Split them.
- **Aliases in the H1**, 3-8 of them, so search ranks the file where you mean it to: see [Aliases](#aliases-the-one-ranking-lever).
- **Include source attribution**: who said it, when, and where (PR, Slack thread, meeting).
- **Supersede, don't duplicate.** Decisions get reversed, and two files about one topic are both retrieved — the older, better-aliased one can rank first. Search for the record before storing the reversal, read it, update it, and add a dated `## Source` line. Injection shows each file's `updated` date for exactly this case.
- **Skills vs knowledge**: if a pattern is a multi-step workflow (3+ repeating steps), it belongs as a Skill, not a knowledge file.

### Word budgets

dailyContext entries must be concise to keep the file scannable and under 150 lines and 6,000 characters — characters, because that is what a prompt pays for:
- **Completed items**: 15-25 words (action taken, not full analysis)
- **Key Decisions**: 10-20 words (outcome + rationale)
- **activeProjects**: one line per project, no sub-bullets

### No redundancy between sections

Each fact belongs in exactly one dailyContext section:
- **Completed** = actions taken (what you did)
- **Key Decisions** = outcomes decided (what was resolved)
- **In Progress** = work still open right now
- **Context for Tomorrow** = what the next session should pick up
- **Carried Forward** = written by rollover: yesterday's unfinished "Context for Tomorrow"

Only the last two survive a day. Rollover archives everything else, so work that has to be picked up tomorrow belongs under "Context for Tomorrow" — "In Progress" is the heading that sounds durable and is not.

A meeting that produced a decision: Completed says "Held meeting with X", Key Decisions captures the outcome. No overlap.

### Self-verification

Before modifying code, committing, or taking irreversible actions, the agent is instructed to check for relevant knowledge files (git conventions, component patterns, API design rules, testing standards) using `memory_search`.

## Example workflows

### Daily workflow
```
You: Good morning, what was I working on?
→ Agent reads dailyContext.md and activeProjects.md from memory, tells you

You: I finished the auth refactor
→ Agent appends to Completed, updates activeProjects.md

You: Let's wrap up for the day
→ Agent updates "Context for Tomorrow" with carry-forward items
```

### Knowledge capture
```
You: For all proposals in this project, use a confident and direct tone.
     No hedging words like "maybe" or "perhaps". Be specific and assertive.
→ Agent immediately saves this as knowledge/proposal-tone.md
→ Future sessions find it automatically when you mention proposals
```

### History search
```
You: What did I decide about the webhook naming convention?
→ Agent uses memory_search to find the historical dailyContext where the decision was recorded
```

## Setup

Nothing to configure — memory bank is scaffolded automatically on first run at `~/.pi/memory3/`. Start using it by telling pi about your projects and it will maintain the memory bank across sessions.

### Configuration

Optional, at `~/.pi/memory3/config.json`, written for you by `/memory config`:

```json
{
  "injection": {
    "activeProjects": "every-turn",
    "dailyContext": "every-turn",
    "knowledge": "every-turn",
    "history": "every-turn"
  },
  "debug": false,
  "log": false,
  "logPrompts": true
}
```

Each content type takes `every-turn`, `first-turn` (only the first prompt of a session), or `off`. `debug` is the same setting as `/memory debug on`: with it on, every prompt prints one line naming the files injected, their scores, what was rejected and why, and the size of the block. It is opt-in because a line per prompt is noise once you have seen it — it is the thing you turn on for a minute when memory seems to be ignoring you. `log` and `logPrompts` are the same settings as `/memory log` and `/memory log prompts` — see [Usage log](#usage-log).

An unparseable config.json falls back to the defaults silently; `/memory doctor` is what tells you it happened.

#### Optional project scope

```text
/memory config scope.mode auto      # off (default) | auto | explicit
/memory config scope.name my-app    # override the guess; "" clears it
```

Eligibility is derived from the path at read time, never stored: `knowledge/shared/` and flat `knowledge/*.md` stay global, `knowledge/<scope>/` is injectable only in that scope. The scope comes from `ctx.cwd` at the nearest `.git` (directory or worktree file), else the `cwd` basename; `scope.name` wins, and `scope.mode explicit` refuses to guess. Because it is a guess, it is printed in the injected header, in `/memory status`, in `/memory scope` and in `/memory doctor`, and an unresolved explicit scope fails closed for project folders (flat/shared still work) rather than injecting everything.

The asymmetry is deliberate: **injection** filters by scope, **`memory_search`** does not — it labels each hit `project:<name>` or `global`, because an asked question must stay answerable across projects or the agent writes a duplicate. `doctor` lists folder counts and marks scopes not eligible here, so a renamed project directory is visible instead of silently orphaned.

This is not a privacy wall and not a shadowing rule: a narrower note is not a more correct note, so nothing is hidden from search or given authority. For a real wall, use separate `PI_MEMORY_DIR` banks. Measured in the design that preceded it (`docs/project-scope-design.md`), scoping removes other projects' files and nothing else — generic-word noise inside the eligible set is the separate problem the relevance policy addresses.

#### Optional local recovery history

```text
/memory config revisions.enabled true      # default false
/memory config revisions.maxPerFile 10
/memory config revisions.maxTotalBytes 10485760
```

When enabled, `memory_update` and `memory_append` back up the text they are about to replace into `<bank>/.revisions/<sha256-of-path>/<id>.json`, under both the target's lock and the store's own lock, before the atomic rename. `/memory revisions [file]` lists snapshots (id, date, path, size) and `/memory restore <file> <id>` puts one back — always capturing the current text first, even if automatic history was off, so a restore is undoable. Restoring drops the stale served-version record, re-indexes the file, and the reply tells the agent to `memory_read` before editing.

Bounds and honesty about them: pruning is newest-first with a per-file count and a total byte budget, and it protects the snapshot just taken, so a store that fills up drops recovery copies, never notes. If the text about to be replaced cannot fit in that budget, the **write is refused** rather than performed unrecoverable — `doctor` warns before that happens. Lowering the budget does not invalidate existing snapshots: listings still report their real size, and the next managed overwrite prunes valid old copies to the new bounds. Restore may recover an old snapshot larger than the new budget if the current text can be backed up; later overwrites of that large restored text still require a sufficient backup budget. Snapshots are checksummed and re-verified before use, and an unexpected entry fails the store closed for writes until it is inspected; memory tools reserve every casing of `.revisions/` and `.write-locks/` as write targets on all filesystems, including when either is a symlink out of the bank. Markdown extension recognition is case-insensitive for recovery and indexing, so `.MD` does not bypass capture. Existing alias-spelled snapshots remain valid and are grouped by current on-disk target identity after their original metadata/checksums are verified. What this is not: a backup of the bank (it lives inside it, and harness/shell writes are not captured), a version-control system, or protection against another process deleting the directory — for those, put the bank in git or copy it.

#### Maintenance without deletion

```text
/memory config maintenance.historyMaxDays 90
/memory config maintenance.carryForwardWarnDays 14
```

`historyMaxDays` defaults to `0` (all ages). A positive calendar-day window excludes older, canonically dated daily archives from **automatic injection**, before ranking/candidate cuts. They stay on disk and remain available through `memory_search` and `memory_read`; explicit results label why an archive would not be injected. Unknown/non-daily dates are not guessed from modification time. No notes are automatically deleted.

`/memory doctor` reports current Carried Forward duplicates and items also present in old archived Carried Forward sections. It gives the earliest observed snapshot date and asks for manual review—it never infers that a task is finished, changes a bullet, or prunes the bank.

#### Optional relevance policy

The conservative default is `legacy`. To try the experimental selector:

```text
/memory config retrieval.mode balanced
/memory config retrieval.minScorePerTerm 5
/memory config retrieval.minRelativeScore 0.25
/memory config retrieval.topicStickiness true
```

These are persisted under `"retrieval"` in config.json. Balanced mode applies an absolute score-per-distinct-content-term floor **to rank one too**, plus a fraction-of-top-eligible-score floor; it can inject no knowledge. It does not backfill rejected slots with weaker records. The ordinary `memory_search` tool remains unfiltered lexical recall.

Referential follow-ups (including long "what are its goods, bads…" questions) reuse the last successful retrieval query. Explicit topic switches, a new named title subject, a no-hit topic, compaction, tree navigation and a new session release that anchor. This is a lexical heuristic, not intent understanding; arbitrary short subject queries do not inherit it.

The frozen provisional corpus improves from 22/24 required files to 24/24, with 24/26 relevant slots and all 11 no-memory cases correct; the history case still admits two irrelevant records. It is **not** owner-reviewed evidence for a new default. Compare `npm run eval -- --policy balanced` and `npm run replay -- --policy balanced --cuts 3,5,8`. Return to the original selection rule with `/memory config retrieval.mode legacy`.

To load it from this checkout without installing anything:

```bash
pi -e ./index.ts                       # this extension only, plus whatever else is configured
PI_MEMORY_DIR=$(mktemp -d) pi -e ./index.ts   # try it out against a throwaway bank
```

Or add the directory to `packages` in `~/.pi/agent/settings.json` to load it in every session. `npm install` in the repository root first: the extension needs `minisearch` at runtime, and the root declares it — Node resolves it by walking up from this directory, so nothing has to be installed inside `extensions/memory/` to load the extension.

## Requirements

Pi `1.4.0`. Two API facts from that version are relied on and were measured against it:

- `before_agent_start` is a union — a run started by an idle custom message carries `message`, not `prompt`, so the prompt is read only when `messageType === "user"`.
- A tool's `execute` must return `details` next to `content` (`AgentToolResult.details`). Every tool here reports the file or query it acted on there; `content` stays the model-facing text.

`typebox` is a root **runtime** dependency: the tool schemas are built with it, so it is imported, not merely typed. `@earendil-works/pi-coding-agent` is an optional peer that nothing installs — Pi supplies it, and the `ExtensionAPI` import is type-only, so jiti erases it and no package is fetched at load time. The manifest here keeps only what this component's own test tools need (vitest), which Pi never installs.

## Development

```
npm run setup:memory                   # from the repo root: this component's vitest + tsc
npm test            # vitest: config, search index, and handler/tool tests
npm run test:watch
npm run typecheck   # tsc gate — neither vitest nor jiti checks types
npm run smoke       # loads the extension in a real `pi --mode rpc` process
npm run race        # two processes, one bank: concurrency checks that fail the run (~1 min)
npm run measure     # characters sent per prompt, and how many the session already had
npm run replay      # actual injection decisions on logged prompts against today's bank
npm run eval        # frozen, provisional labels through the real injection handler
npm run audit       # read-only: what the last weeks of real sessions say (no fixture replaces this)
```

`npm run verify` is the gate: typecheck, unit tests, the real-runtime smoke and the race probes in
one command. The CLIs below it read flags rather than guess them — `npm run eval -- --policy balanced
--strict` (unknown flags exit non-zero, because a mistyped policy otherwise prints the default as if
it were the setting you measured), and `npm run measure -- --policy balanced`.

Where each responsibility lives, since `index.ts` is the wiring and not the implementation:

| file | owns |
| --- | --- |
| `paths.ts` | one bank-relative path identity; symlink containment |
| `bank.ts` | bank root and directories, atomic write, `config.json` read/merge |
| `locks.ts` | bank-relative directory lock identity shared across root aliases |
| `caps.ts` | every injection size limit, and what a cut says out loud |
| `calendar.ts` | local calendar dates, day of a daily file |
| `sections.ts` | heading lookup and section bodies, one rule for three features |
| `search.ts` | MiniSearch document identity and reconciliation |
| `retrieval.ts` | opt-in relevance floor, referential topic continuity |
| `scope.ts` | opt-in path eligibility, from `cwd` or a pinned scope name |
| `revisions.ts` | bounded local recovery history, checksums, restore |
| `versions.ts` | which content this session was already served (staleness refusal) |
| `usage-log.ts` | the monthly JSONL log, its switches, `summarizeLog` |
| `evaluation.ts` | frozen-corpus scoring and session-sequenced runs |
| `maintenance.ts` | archive age and carry-forward reporting; it never deletes |
| `lifecycle.ts` | first-run scaffolding and day rollover |
| `index.ts` | tools, commands, event handlers, the injection block, and the per-session record of what it showed |

`npm run smoke` starts Pi in RPC mode with `--no-extensions --offline`, points `PI_MEMORY_DIR` at a temporary directory, sends `/memory` and then `/memory doctor`, and checks that each was handled, that its dialog names that directory and mentions the expected sections, and that first-run scaffolding wrote the default files. It makes no model request, so it works offline and costs nothing. Pass `-- --pi /path/to/pi` to test a different binary.

`handlers.test.ts` is the file to change when touching the event handlers: it drives the closures that `pi.on(...)` receives, which `index.ts` does not export. `scripts/harness.mjs` is the same idea for the CLIs — callers provide a throwaway bank before it imports the shipped handlers. Production-pipeline evaluation and replay operate on fixtures or bank copies, not on the original bank.

Test isolation has three layers, because `bank.ts` binds paths at import and ES imports hoist above a test file's statements. `vitest.bank-guard.ts` (`globalSetup`) redirects HOME, USERPROFILE and PI_MEMORY_DIR to a temporary suite sandbox; subprocesses inherit that isolated default home. `vitest.isolate-bank.ts` (`setupFiles`) gives each test file its own temporary bank before imports, and `bank.ts` throws if a VITEST process imports it without PI_MEMORY_DIR. Teardown compares content hashes and paths in the original default bank and any explicit PI_MEMORY_DIR bank: additions, overwrites and deletions fail the run. An explicit override no longer disables this detector. `isolation.test.ts` directly tests each layer, original-bank detection with and without an override, and environment restoration/cleanup even after detection fails.

These are protections, not an OS sandbox: code deliberately naming an outside absolute path can still write there. Teardown detects persistent changes after the fact, cannot catch changes undone before exit, does not undo damage, and cannot distinguish test writes from a concurrent live session. Avoid changing the original banks during tests. `PI_MEMORY_GUARD=off` disables the detector for that concurrency case, not the temporary-home isolation. This is not decoration: a suite wrote fixtures into the live bank on 2026-11-08 while every test passed.

`npm run audit` answers the question the tests structurally cannot: did any of this change what agents do? It reads `~/.pi/agent/sessions` and prints three numbers — how many memory results that name a place named the *whole* place (by month, so a shipped change shows up as a month at 100%), how many bank-shaped `.md` writes landed outside the bank, and what `find /` and `find ~` cost. Baseline from the run that justified the absolute paths: 0 of 123 results, 3 misplaced writes in 18,390 tool calls, 7,301 s of broad scanning. Two cautions it inherits from the audit that got two numbers wrong the first time — read the whole result text of a compound command, never a 200-character prefix, and do not add an "outcome" column: the script prints the slowest commands with the tail of their output and leaves the judgement to whoever is reading.
