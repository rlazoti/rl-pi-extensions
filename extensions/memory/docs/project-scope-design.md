# Design: project scope for knowledge files

Status: **built opt-in on 2026-11-08, default `scope.mode = off`.** Measured 2026-10-27 against
the corpus in `injection-eval.test.ts`; numbers below are from that run. Shipped as `scope.ts`
plus the injector's `pathReason`, and the warnings below still hold: it removes other projects'
files and nothing else.

What shipped as designed: path-derived eligibility (`knowledge/shared/`, flat `knowledge/*.md`
global; `knowledge/<scope>/` scoped), detection order `scope.name` → nearest `.git` (directory
*or* worktree file) → `cwd` basename, `explicit` never guessing, the injection-filters /
search-labels asymmetry, `/memory scope`, and doctor reporting scope, detection source and
non-eligible folders.

What differs from the sketch, and why:

- The scope line goes in the injected header only when the mode is not `off`, so a bank that
  never enables scoping keeps byte-identical model context (asserted in `handlers.test.ts`).
- Eligibility is applied **before** the top-three candidate cut and before the history
  score reference (`MemoryIndex.searchForContext`'s `filter`), not after ranking. Filtering
  afterwards let an ineligible file occupy a slot and raise the bar a wanted history file had
  to clear; `scope.test.ts` pins both.
- An unresolved explicit scope fails closed for project folders rather than falling back to
  "inject everything", and the reason is a warning in doctor, not silence.
- Scope is recomputed per prompt from `ctx.cwd`, not only at `session_start`: one process can
  serve prompts whose session cwd differs, and a scope cached at startup would be wrong there.
- Rejected-alternatives table stands unchanged, including per-scope corpora (filter after
  scoring, so recorded scores and thresholds stay valid).

Evidence: `scope.test.ts` (predicates, detection, ranking position), `handlers.test.ts` (real
injection header, cross-project exclusion, search labels, unresolved-scope fail-closed,
byte-compatibility when off), `fixtures/retrieval/scope-corpus.json` through the shipped handler
under both retrieval policies (strict), and `/memory scope`/`doctor` output.

## Problem

Every knowledge file is one corpus. A note written for one project competes with every
other project's notes. The motivating case is real: a file titled
"Concurrent writes (two agents, race, lost update, overwrite, locking, shared bank)"
matches a prompt about a merge conflict in an unrelated repository, and the agent then
reads a note about its own extension while fixing its app.

## What scoping fixes, and what it does not

Measured on a 7-file fixture bank, run once per scope, 12 prompts each:

| Scope active | Wanted file still injected | Injected files on unrelated prompts |
|---|---|---|
| `webapp` | 2 / 2 | 5 before, 5 after |
| `api` | 2 / 2 | 5 before, 4 after |
| `pi-memory3` | 2 / 2 | 5 before, 5 after |

Read the last column carefully. **Scoping removes files from other projects. It does not
remove noise from the files that remain eligible**, because the noise comes from generic
words in the eligible files, not from the wrong files being present. Do not approve this
design as a fix for injected filler. Those are two problems.

## Layout

```
knowledge/shared/        eligible in every project
knowledge/<scope>/       eligible only when <scope> matches the current project
knowledge/foo.md         eligible always (today's behaviour, unchanged)
```

Files directly in `knowledge/` stay global. Nothing moves, so an existing bank behaves
exactly as it does today. Enabling the feature means choosing a scope and moving files in.

## Detecting the scope

1. `ctx.cwd`, already available to the extension.
2. Walk up to the nearest `.git` directory. Use its directory name. That is the project.
3. No git repository: use the `cwd` basename.
4. Config `scopeName` overrides both. Config `scopeMode` is `"off"` (default), `"auto"`,
   or `"explicit"` (require `scopeName`, never guess).

Detection runs at `session_start` and is stored on `state`, not on disk: a bank is shared
by many projects, so the scope belongs to the session. Because it is guessed, say where it
came from — the injected header gets `scope: pi-memory3 (git)` and `doctor` prints the same
line. A wrong guess must be visible, and `scopeName` must be the documented cure.

## The rule

One predicate, derived from the path at read time. Nothing is stored, so a moved file can
never disagree with its own location:

```ts
scopeAllows(path, scope) =
    !path.startsWith("knowledge/")            // core, templates, history: unchanged
 || path.startsWith("knowledge/shared/")
 || (scope !== null && path.startsWith(`knowledge/${scope}/`))
```

`scopeMode: "off"` makes it return true for everything, which is today's behaviour.

## Injection filters, search labels

This asymmetry is the core of the design, and it is deliberate:

- **Injection** drops files outside the scope. It runs on every prompt, unasked, and the
  model cannot decline what it is shown.
- **`memory_search`** keeps every file and prefixes each hit with its scope. Asked
  questions are asked on purpose. Filtering them would make "what do I know about X"
  unanswerable across projects, and an agent that finds nothing writes a duplicate.

## Writing files

A guideline, not a rule enforced by code: a note about one repository goes in
`knowledge/<scope>/`; a note about the environment, the machine, or the user goes in
`knowledge/shared/`. When in doubt, use the scope — a file that is too narrow is merely
missing, a file that is too broad is noise in every project.

`/memory scope` prints the active scope, how it was detected, and the folders present.

## Cost and rejected alternatives

| Option | Why not |
|---|---|
| `PI_MEMORY_DIR` per project | Already works, zero code, but it splits the whole bank: core files and history are meant to be shared. Right tool for a hard wall, wrong tool for a partition. |
| Store a `scope` column in the index | A derived column rots when a file is moved, which is how `index.csv` died. Derive from the path instead. |
| Tag files with frontmatter | The model must remember to write the tag, and forgets. A directory cannot be forgotten. |
| Per-scope BM25 corpora | Changes every score in the bank, so every recorded number and every test threshold becomes wrong. Filter after scoring, not before. |

## Failure modes

- **Two checkouts of the same repository, or two projects with the same name** share a
  scope. Accepted; `scopeName` fixes it.
- **A renamed project directory** orphans its files. `doctor` lists every scope present
  with its file count and marks the ones not eligible now, so an orphan is visible.
- **A `shared/` file is noise everywhere.** In the run above the shared fixture matched 4
  of 5 unrelated prompts. `shared/` must stay small, and the guideline should say so.
- **A scope with no files** behaves exactly like today.

## Test plan

1. A file under another scope is never injected; the same file is still returned by
   `memory_search`, labelled.
2. `shared/` is injected in two different scopes.
3. Flat `knowledge/*.md` is injected in both scopes (back-compatibility).
4. `scopeMode: "off"` reproduces today's output byte for byte.
5. `doctor` shows scope, detection source, and an orphaned scope.
6. Extend the `injection-eval.test.ts` fixture with two scopes and assert the bleed case
   from the Problem section is gone.

## Recommendation

Build it only when cross-project bleed is observed in a real bank, not in the fixture. The
measured benefit is narrow and the cost is a new concept in the guidelines. Until then the
two zero-code levers are `PI_MEMORY_DIR` for a hard wall and better alias discipline — the
noise in every run above came from common words in alias lists, which is a writing problem.

## Source
- Rodrigo + AI, 2026-10-27, design requested in the pi-memory3 session; tables from a
  simulation over the `injection-eval.test.ts` corpus (scratch test, since deleted).
