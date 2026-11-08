# Six-step improvement series — 2026-11-08

Rodrigo approved the six assessment recommendations, one commit per item, in this session.
Keep Markdown/MiniSearch; no database, embeddings, automatic conflict adjudication, or silent pruning.

1. Safety: fingerprint the actual served content, canonical path identity, reject symlink traversal,
   require a read of existing files unless explicitly overridden. Regression tests and race probes.
2. Evaluation: frozen representative fixtures, explicit label provenance, actual production pipeline,
   per-session cost attribution, required/irrelevant/no-memory metrics. No invented owner approval.
3. Selection: configurable relevance floor and referential topic continuity; zero hits is valid.
   Keep unreviewed relevance tuning opt-in until owner-reviewed real-bank evaluation exists.
4. Maintenance: incremental disk reconciliation before retrieval, archive injection age policy,
   read-only carry-forward hygiene reporting. Never delete notes or guess which tasks are finished.
5. Scope/recovery: opt-in path eligibility (search labels, no automatic shadowing), bounded revision
   history, explicit restore with backup and locking. Defaults preserve existing bank layout.
6. Refactor: split cohesive responsibilities, strengthen integration checks and documentation,
   preserve public tools and commands. One verification command for the release gates.

## Verification

Each commit: unit/handler tests, typecheck, real-Pi offline smoke. Write changes: full race probe.
Injection changes: frozen evaluation, live-bank measure and replay (retrospective, not ground truth).
All probes use temporary banks; do not alter the live bank's project/task content or configuration.

## Progress

- Step 1 complete: content fingerprints, canonical keys, symlink rejection, explicit unread override;
  263 tests passed (1 optional report skipped), typecheck/smoke and all six race scenarios passed.
- Step 2 complete: 34 frozen cases / 14 snapshots, real injector metadata, per-session/reset-aware
  measure/replay, all tests typechecked. 268 tests passed, typecheck/smoke passed.
  Provisional legacy baseline: required recall 22/24, relevant slots 23/68, no-memory 7/11,
  33,329 characters. Corrected live replay: 203 events / 173 sessions (138 unattributed),
  561 admitted slots, 25 named-only records. Measure/control: 3,727,865 / 4,073,898 chars;
  these conservative session-attributed numbers are not comparable with the old time-gap series.
- Step 3 complete: opt-in balanced relevance floors, long/short referential topic continuity,
  explicit no-hit outcomes, validated policy commands and truthful reasons. Fixed query/index
  case/diacritic normalization; replaced lexically colliding synthetic filler aliases in the
  500-file test rather than loosening its 0.35 overlap guard. 278 tests, typecheck/smoke passed.
  Provisional balanced: 24/24 required, 24/26 relevant slots, no-memory 11/11, 20,899 chars;
  the history prompt still admits two extras. Legacy after normalization: 22/24, 23/64, 32,000.
  Live retrospective legacy/balanced: 3,634,153 / 2,571,077 chars on 203 prompt events;
  not proof of historical recall or approval to enable the policy by default.
- Step 4 complete: metadata/hash-based incremental reconciliation before every retrieval,
  including cross-process additions, same-mtime edits, renames and deletions. The index race
  probe now requires `search=true list=true`. Optional calendar-day archive injection window
  preserves explicit discovery/read; read-only doctor reports aged/repeated carry-forward items.
  287 tests, typecheck/smoke and all six race scenarios passed; frozen eval and live
  balanced replay/measure were unchanged. Nothing in the live bank was pruned or reconfigured.
- Step 5 complete: opt-in path-derived scope eligibility (`scope.ts`; injection filters, search
  labels, unresolved explicit scope fails closed, scope recomputed per prompt) and opt-in bounded
  revision history (`revisions.ts`; capture under target + store locks, newest-first pruning,
  checksum verification, refuse-write-when-the-previous-text-cannot-fit, `/memory revisions`,
  `/memory restore` with undo backup). Internal `.revisions`/`.write-locks` paths are refused as
  memory targets, symlinked stores cannot write outside the bank, and lock identity is now the
  configured-root spelling (subsequent audit found that different configured roots still bypassed each other; corrected below). 305 tests, typecheck,
  smoke and a seventh race scenario (`revisions`: 8 checksummed snapshots, latest backups present,
  bounds respected) passed; a 7-case scope corpus passes strict under both retrieval policies and
  the 34-case corpus is unchanged (24/24 required, 24/26 relevant slots, 11/11 no-memory).
- Step 6 complete: `index.ts` went from 2,459 lines to 1,705 as five responsibilities moved to their
  own modules — `caps.ts` (every size limit, and what a cut says out loud), `bank.ts` (bank root,
  atomic write, and one config read/merge so no save can drop another section), `calendar.ts` (local
  calendar dates), `sections.ts` (heading lookup, one rule for three features), `usage-log.ts` (the
  monthly JSONL log and its switches) and `lifecycle.ts` (scaffolding and day rollover, which now
  takes the managed writer and the lock as dependencies, so recovery history covers rollover too).
  `npm run verify` makes typecheck + tests + smoke + race one gate; the eval/measure/replay CLIs now
  reject unknown flags, after a `--retrieval selective` run silently reported the legacy policy;
  smoke drives `/memory scope` and `/memory revisions` against a real Pi, so both opt-in commands
  have real-runtime coverage. 308 tests, typecheck, five smoke probes and seven race scenarios pass.
  Splitting the file exposed a worse fault than dead code: a handler suite statically imported a module
  that reaches `bank.ts`, ES imports hoisted above its `PI_MEMORY_DIR` assignment, and the suite wrote
  its fixtures into the live `~/.pi/memory3` with every test green. The initial fix used `setupFiles`
  to set a temp bank before imports and an import-time `bank.ts` assertion under VITEST. Its
  globalSetup detector only checked added paths and was not directly tested; audit finding 4
  below strengthens this protection without claiming an OS sandbox. `tsconfig.json` gained `noUnusedLocals` and
  `noUnusedParameters` so the next extraction cannot leave fossils behind.
  Frozen corpus: legacy 22/24 required, 23/64 relevant; balanced 24/24 and 24/26 with 11/11 no-memory
  cases — one provisional history case still admits two extras, so `--strict` stays red by design
  until those labels are owner-reviewed; the scope corpus is 8/8 with no differences. Live replay on
  2026-11-08 (83 prompt events, current log): balanced 95 admitted slots / 944,635 chars against legacy
  206 / 1,480,150 — a size change measured on today's bank and clipped prompts, not proof of historical
  recall.

## Post-series audit fixes

- Finding 1: moved lock acquisition to `locks.ts` and hash normalized bank-relative targets,
  not absolute configured paths. The shared lock directory identifies the bank. Added a
  two-process `alias-locks` race: target and revision-store locks held through one root
  block writes through a symlink root, then writing succeeds after release. Restart old
  sessions together: the previous absolute-path scheme is not compatible with this scheme.
- Finding 2: inventory validates snapshots independently of the current retention budget, reports
  real bytes after budget reductions, and lets managed writes prune valid old copies. Tests cover
  cross-file pruning, oversized old snapshot restore with undo backup, and refusal when current
  text cannot fit. Corrupt metadata/checksums still fail closed.
- Finding 3: unchanged partial views preserve an earlier complete fingerprint. Changed content and
  transcript resets still invalidate completeness. Unit and handler regressions cover cropped
  knowledge, withheld knowledge, and cropped core injection after a complete read.
- Finding 4: globalSetup isolates HOME/USERPROFILE and PI_MEMORY_DIR, then checks hashes and paths
  in original default and explicitly overridden banks. Detection covers additions, overwrites and
  deletions. Direct and subprocess tests exercise guards, inherited default-home isolation, explicit
  overrides, and cleanup/restoration on failure. Detection is after the fact, not write prevention;
  it cannot attribute concurrent live writes or detect changes reverted before teardown.
- Final gate after all four fixes: 323 tests passed (2 skipped), typecheck, five real-Pi smoke
  commands and all eight race scenarios passed. Balanced frozen evaluation unchanged: 24/24
  required, 24/26 relevant, 11/11 no-memory; scope corpus passes strict (8/8 required).

## Second-audit safety fixes

- `39cc642`: strict current-file reads treat only ENOENT as absence. Update and append refuse
  permission/I/O errors regardless of allowUnread or revision mode. Mocked EACCES/EIO tests
  cover both modes, refusal recovery and genuine creation; the real chmod-000 probe preserves text.
- Existing path components now resolve to their on-disk directory-entry spelling using filesystem
  identity, not case folding. Distinct case/Unicode spellings remain distinct when the filesystem
  supports them; ambiguous non-exact hardlink matches fail closed. A namespace lock gates all
  target resolution and stays held through new-target creation, covering aliases before they exist.
  Existing targets release it before waiting for their file lock; the nested store lock bypasses it.
- Reserved recovery/lock names are case-insensitive on all filesystems. Markdown recognition also
  accepts .MD for recovery/indexing. Valid old alias-spelled snapshots retain their original group
  verification and are exposed/pruned/restored under current on-disk identity. Updated harness
  write-result identity and corrected stale external-write freshness comments/guidance.
- Regressions exercise host case/Unicode behavior, simulated case-sensitive distinct files,
  namespace cleanup, nested store locks, served versions, indexing, uppercase capture, legacy
  snapshots, and two-process existing/creation alias races. Final gate: 340 tests (2 skipped),
  typecheck, five real-Pi smoke commands and all nine races pass; both frozen evaluations unchanged.
