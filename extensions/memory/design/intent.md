# Intent: budgeted, governed memory for Pi
Author: Rodrigo Lazoti. Status: draft, decisions applied 2026-10-16.

## Problem
The current memory extension injects whole files on every turn. That can be tens of KB
of unrelated knowledge on an unrelated question. Knowledge files turn into project status
logs (PR SHAs, run results, "superseded above" notes kept inline), so stale and contradicting facts
reach the model. Preferences are written down, but nothing makes the model see the relevant ones.
rl memory v1.5.0 fixes contradictions and budgets, but cannot write core files. It cuts working
state from the bottom. Its automatic migration of the existing bank yields 0 injectable entries and
1,734 proposals.

## Proposed outcome
A successor memory extension that is better than both, measured in a one-week trial. Its job is
limited to: durable rules and preferences, domain facts and invariants, and the daily log.
- **Storage:** markdown with a small strict grammar (key, scope, asOf, aliases, source). Hand-editable;
  write → read → write round-trips byte-stable.
- **Scope:** every claim is `global`, `project`, or a path glob. Out-of-scope claims never inject.
- **One current claim per key:** a change supersedes the old claim, the old claim moves to history,
  and the new claim needs approval. No inline "superseded" prose.
- **Tiered writes:** the agent writes the daily log through a structured tool, which stamps the date
  on every item and writes no auto-persist lines. Rules and facts go to an approval queue, reviewed
  in a batch (`/memory review`, or at EOD). An inline dialog for conflicts is available as a config
  option (default off).
- **Pending claims:** while a change to an existing claim waits for review, only the approved claim
  is injected. A pending claim for a new key is injected, marked unapproved, below approved claims.
  After 14 days it is flagged and no longer injected. Pending claims are never dropped.
- **Review notice:** every new Pi session opens with a notice when claims wait for review.
- **Status redirect:** project status written into a claim's body (SHAs, PR/run state) is refused and
  redirected to the daily log. Signals: commit SHAs, PR/issue/run numbers, CI URLs, and a date next
  to merged/pushed/deployed/ran/passed/failed. `source` and links are exempt. A refusal can be
  overridden with a reason.
- **Projects live outside memory:** local dir, GitHub, or any other reference. Memory only links to them;
  there is no injected project list.
- **Injection:** a small always-on core plus relevant excerpts under a hard token budget
  (default 2k, configurable: core 600, daily open items 500, retrieved the rest). History is
  searchable only, never injected.
- **Retrieval:** BM25 over keys, aliases, tags and text. The ranker is pluggable; semantic is off by
  default.
- **Rules as context:** rules are injected when they relate to the request; rules tagged `always` are
  injected every turn. Nothing is blocked. "No push without approval" and "no user-facing files in
  `/tmp`" are example rules, not built in.
- **Migration:** a backup of `~/.pi/memory` comes first. The agent drafts keyed claims for the ~240
  knowledge files into the approval queue, in waves: rules and preferences first, then facts one
  domain at a time. Status text goes to a read-only archive. Migrated claims are not injected until
  approved. Rodrigo reviews in batches. Cutover happens all at once, after the trial week gives a go.
- **Success:** a one-week trial. Go when the median injected tokens per turn are at most 25% of the
  current extension's, and Rodrigo flagged zero stale or rival notes. The baseline comes from the
  last 14 days of Pi session files, counted the same way.

## Affected users and systems
Rodrigo, across all Pi sessions, on one machine. Systems: `~/.pi/memory` (core, knowledge, history);
current memory extension (replaced); rl memory in rl-pi-extensions (superseded, new home);
`~/.pi/agent/AGENTS.md` and skills that call `memory_*` tools (`/morning`, briefing, plan-day, EOD);
second-brain-v2 as the project home.

## Constraints
- Lives in rl-pi-extensions. Follows its AGENTS.md: strip-compatible TS, `npm test` and `npm run
  typecheck`, tests for every change, no new runtime dependency without a README justification.
- Must not block Pi startup. Fails closed on two approved claims for one key and fails open on read
  errors (no injection, never a crash).
- No silent loss: any truncation is reported, and nothing is cut from the bottom without notice.
- Read tool names keep working (`memory_read`, `memory_search`, `memory_list`). Write tools are
  renamed (`memory_log`, `memory_propose`) with a documented rename path. Rodrigo updates
  AGENTS.md and skills by hand before cutover.
- Component name is `memory`. It never overwrites a foreign symlink; Rodrigo removes the old link by
  hand at cutover.
- One machine. Sync between machines is out of scope.
- Defaults: 2k budget, no tool blocking, inline conflict dialog off. All configurable.

## Open questions
- None. Changes for `/morning`, briefing, plan-day and EOD come from a read-only caller inventory
  made before cutover; Rodrigo makes the edits.
