# AGENTS.md

## 1. Project Context

**rl-pi-extensions** is a monorepo for personal [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) extensions. Extensions are distributed as a single package with a TUI for enabling/disabling individual extensions at runtime.

- **Language:** TypeScript (ES modules)
- **Runtime:** Pi uses [jiti](https://github.com/unjs/jiti) for TypeScript compilation (CommonJS output)
- **Package manager:** npm
- **Test runners:** Node.js built-in test runner for the monorepo; isolated Vitest for memory.
- **Dependencies:** runtime — `minisearch` (memory's search index) and `typebox` (tool parameter schemas); both are imported by extension code, so they are real dependencies, not dev ones. Host — `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, declared as `*` **optional** peers and installed by nobody: Pi provides them, and nothing in this repo's install graph may name a Pi version (see § 6). `memory` keeps its own manifest for its isolated test tools (vitest), which Pi never installs.

**Key constraint:** Extensions load inside the Pi process. They must not block startup, must handle errors gracefully, and must respect Pi's TUI lifecycle.

---

## 2. Development Commands

| Command | Description |
|---|---|
| `npm test` | Run all tests |
| `npm run typecheck` | `tsc --noEmit` over `extensions/` and `tests/` (strict), with Pi types mapped from the live install |
| `npm run gen:ts-paths` | Regenerate `.pi/tsconfig.pi-types.json` (runs on `npm install`; `--allow-missing` tolerates no install) |
| `npm run setup:memory` | Install memory's isolated test tools (vitest); not needed to run the extension |
| `pi install ~/Projects/Terminal/rl-pi-extensions` | Install locally for testing |
| `pi install git:github.com/rlazoti/rl-pi-extensions` | Install from git |

After changes, reload Pi with `/reload` or restart Pi entirely.

---

## 3. Coding Conventions

- **ES modules:** Use `import`/`export` syntax. Files use `.ts` extension.
- **Import paths:** Use `.js` extension in imports (jiti resolves `.js` to `.ts` at runtime).
- **Type safety:** Use TypeScript interfaces for public APIs.
- **Naming:** Extensions use kebab-case (`tmux-feedback`, `rl-extensions`). Directories match.
- **No side effects:** Extension entry points should be simple re-exports.

---

## 4. Architecture and Design Rules

### Extension Structure

Each extension has a simple entry point that re-exports the implementation:

```
extensions/
├── symlink-manager.ts              # Shared symlink management
├── panel.ts                        # Shared picker panel layout (frameLines)
├── tmux-feedback/
│   ├── index.ts                    # Entry point (re-exports implementation)
│   └── implementation.ts           # Real extension code
├── session-banner/
│   ├── index.ts                    # Entry point
│   └── implementation.ts           # Real extension code
├── session-attention/
│   ├── index.ts                    # Entry point
│   └── implementation.ts           # Real extension code
├── snippets/
│   ├── index.ts                    # Entry point
│   └── ...                         # Multiple implementation files
├── emacs-feedback/
│   ├── index.ts                    # Entry point (re-exports implementation)
│   ├── implementation.ts           # Real extension code (Pi side)
│   ├── emacs/
│   │   ├── pi-feedback.el          # Emacs client (source-region feedback)
│   │   └── pi-feedback-test.el     # Emacs ERT tests
├── memory/
│   ├── index.ts                    # Entry point (re-exports implementation)
│   ├── implementation.ts           # Tools, /memory, injection hook
│   ├── bank.ts search.ts paths.ts  # Bank, search and filesystem safety
│   ├── revisions.ts locks.ts       # Recovery and cooperating-writer locks
│   ├── writeGates.ts               # Pure word/character gates for core/dailyContext.md
│   ├── semantic.ts fusion.ts       # Optional qmd vsearch, index refresher, rank fusion
│   └── README.md                   # Behavior, operations and limits
├── co-authored-by-ai/
│   ├── index.ts                    # Entry point (re-exports implementation)
│   └── implementation.ts           # tool_call patching + refusal, tool_result check
├── shell-command.ts                # Shared quote-aware splitter/matcher (co-authored-by-ai, scan-guard)
├── scan-guard/
│   ├── index.ts                    # Entry point (re-exports implementation)
│   ├── implementation.ts           # tool_call hook, modes, capped log, /scan-guard status
│   ├── classify.ts                 # Pure verdictForCommand: tokenizer, roots, depth, reason text
│   └── README.md                   # The measurements, the rule, the escapes that are limits
├── settle-guard/
│   ├── index.ts                    # Entry point (re-exports implementation)
│   ├── implementation.ts           # settle-boundary hook, thinking-level save/restore, capped log, /settle-guard
│   ├── rule.ts                     # Pure decide(): what counts as an empty turn, what is left alone
│   └── README.md                   # The replay measurement that picked the defaults, and the limits
├── context-viewer/
│   ├── index.ts                    # Entry point (re-exports implementation)
│   ├── implementation.ts           # /context: lazy host reads, !hasUI fallback, clipboard seam
│   ├── tokens.ts                   # Cost estimation + category attribution (pure)
│   ├── text.ts                     # The text of every tab, incl. width rules that keep lines in the frame
│   ├── viewer.ts                   # The overlay component: keys, scroll, search, copy
│   └── README.md                   # Keys; measured vs estimated numbers
├── todos/
│   ├── index.ts                    # Entry point (re-exports implementation)
│   ├── implementation.ts           # 4 tools, /todos, injection, storage choice, nudge
│   ├── store.ts                    # The file: lock, re-read inside it, dependency rules
│   ├── types.ts                    # Task, statuses, priorities, sanitising input
│   ├── render.ts                   # One vocabulary: widget row, tool result, prompt block
│   ├── config.ts                   # Where the file lives (scope + PI_TODOS), pure
│   ├── auto-clear.ts               # Turn-counted clearing of finished work
│   ├── plan-nudge.ts               # Ask once after 3 turns of edits with no list
│   ├── widget.ts                   # Row above the editor: registration, spinner, teardown
│   ├── viewer.ts                   # /todos panel: keys, sections, row budget
│   └── README.md                   # Storage matrix, clearing modes, limits
└── rl-extensions/
    ├── index.ts                    # TUI extension manager
    └── picker.ts                   # Picker overlay (layout via panel.ts)
```

> `extensions/memory/` is the Markdown-based pi-memory3 implementation imported at
> commit `36852cf`. It uses `~/.pi/memory3` by default; the retired entry-keyed
> implementation remains in Git history. See `extensions/memory/README.md` for its
> tools, safety boundaries, isolated tests, and recovery behavior.

### Entry Point Pattern

Simple re-export of the implementation:

```typescript
import factory from "./implementation.js";
export default factory;
```

### Symlink-Based Management

Extensions are enabled/disabled via symlinks in `~/.pi/agent/extensions/`:

```bash
# Enable
ln -s /path/to/rl-pi-extensions/extensions/tmux-feedback ~/.pi/agent/extensions/tmux-feedback

# Disable
rm ~/.pi/agent/extensions/tmux-feedback
```

**Only `rl-extensions` is listed in `package.json`.** The manager creates symlinks which Pi discovers automatically. Disabled extensions are never loaded by Pi.

### TUI Guidelines

- Use Pi's built-in components (`SelectList`, `Container`, `Text`, `DynamicBorder`) over custom rendering.
- For custom components, use `matchesKey()` for keyboard input matching.
- Use `ctx.ui.custom()` for modal overlays, `ctx.ui.select()` for simple selections.
- **The overlay's `maxHeight` and the component's own row budget are one number.** pi-tui slices the overlay's lines to the cap it was given (`resolveOverlayLayout` → `overlayLines.slice(0, maxHeight)`), so a component that budgets more rows than the box allows loses its last rows to the knife — the footer keys and the bottom border, the part a reader needs to leave. Keep the constant in the component and interpolate it into `overlayOptions`, as `rl-extensions/picker.ts` and `todos/viewer.ts` do.
- **Spare rows go above the footer, not below it.** Padding under the key hints leaves them floating mid-frame, which is where a reader looks for the way out and finds an empty row.
- Always call `tui.requestRender()` after state changes.
- Guard TUI-only behavior with `ctx.mode === "tui"` when needed.

### Formats a component both writes and reads

- A component that writes a format must be able to read back what it wrote, and the test is the **second pass**: write, read, write again. Every occurrence of this in `memory` was the writer changing shape (a `Group — Section` heading, a provenance line moved into the body) while the reader still matched only the hand-written form, so the next pass called its own output unrecognised and dropped real work.
- Position carries meaning, not only names: `## In Progress` over `### Money Manager` is Money Manager's open work, and a heading with children groups rather than swallowing them.
- A derived filename is a slot, not an identity. Never overwrite a record; identical bytes mean it already exists; any other collision takes the next free slot beside it. Blocking on the name left a live daily file permanently unarchivable while its staleness warning fired every turn.

---

## 5. Testing Expectations

- **Run `npm test` and `npm run typecheck`** before every commit. All tests must pass and the type-check must be clean. Pi loads extensions through jiti, which strips types without checking them, so a type error never reaches `npm test` — the tsc gate exists to catch exactly that (it found a pi-ai import that resolves in Pi's virtual-module loader but not in plain ESM, and a `Theme` type pi-tui does not export).
- **Discovery:** `npm test` runs the Node tests under `tests/` and `extensions/`, excluding `extensions/memory/`, then runs memory's Vitest suite. Memory's test guards isolate HOME and the bank before imports; do not run its tests through bare Node.
- **Pi packages in tests:** this repo installs **no copy of Pi at any version**. `test-support/register.mjs` (loaded via `--import`) registers a resolve hook that maps `@earendil-works/*` and `@mariozechner/*` to the live Pi install **before** normal resolution, and remaps jiti-style `.js` relative imports to `.ts` inside this repo. The install is found the way Pi finds it: `$PI_CODING_AGENT_DIR` if set, else `~/.pi/agent/install/current-version`, else the highest release dir numerically (`compareReleaseNames` — a lexicographic sort would pick `1.5.2` over `1.5.10`); the variable names the agent dir, so it is normalised whether it points at that, a release root, or the package dir. A missing install **throws** rather than falling through to Node resolution: with no local copy left to catch it, a fall-through produced `ERR_MODULE_NOT_FOUND` from inside pi-coding-agent's own `dist/index.js` — a path nobody had asked for, which is what a stale-copy bug used to look like. Types come from the same install via `scripts/gen-ts-paths.mjs`, which generates the `paths` map from the `.d.ts` files and the `exports` maps that release really ships (a `dist/*` wildcard is rejected by tsc inside a package with `exports`, which is why `pi-ai/compat` used to need a hoisted copy), plus Pi's own rule that the `pi-ai` root resolves to `dist/compat`. `tests/test-harness.test.ts` (14) pins both halves, the release selection and every `PI_CODING_AGENT_DIR` depth; `tests/gen-ts-paths.test.ts` (12) tests the generator against fake installs; `tests/documented-commands.test.ts` checks that every `npm run <name>` written in any markdown or source file exists as a script visible from that file's directory (a command in a README or a test message is an API surface — the generator shipped as `types:gen` while every doc said `gen:ts-paths`, and grepping its expected output hid npm's `Missing script`). Test files import sibling sources with `.ts` extensions.
- **Which Pi a component links against:** at runtime, Pi's own extension loader hands every component the host's `pi-coding-agent`/`pi-tui`/`pi-ai` (`dist/core/extensions/loader.js` virtual modules), so the install works on whatever Pi is running — `peerDependencies` are `"*"` on purpose, and the exact dev pins exist only to make `tsc` see one version. The gate is deliberately version-strict rather than range-testing: the parity assertion fails when the two disagree, which is how an upgrade announces itself. Measured 2026-11-10 against both installed releases: the Node suite is green on 1.5.0 and 1.5.1 (on 1.5.0 the only failure is that parity guard, which is its designed behaviour). The range is proven for the versions tested, not for 1.5.x as a promise — 1.4 → 1.5 moved enough of the surface to redden the baseline here once.
- **`extensions/memory` pins its own Pi copy** (currently 1.4.0, nested lockfile) and its two Pi imports are `import type`, so what that pin makes stale is the component's **type-check**, never its tests: Vitest strips the types and the suite never loads Pi's JS. Its sources were checked clean against the live install's declarations, so there is no drift today; the gate simply cannot see one if it arrives. Re-check with `tsc --paths` mapped to the live install when Pi moves.
- **Coverage map:** emacs-feedback (53, behavioral), session-attention (process roles, ask-body formatting, truncation, notification activation: bundle id from `__CFBundleIdentifier`, iTerm fallback, shell-escaping), snippets (display-safe, placeholders, frontmatter helpers), tmux-feedback (state reconstruction, message formatting, command handlers via fake Pi), session-banner (helpers: names/titles/auto-naming/URL reduction; panes: RenderScheduler + paneRegistry via `mock.timers`; index: full extension behavior — lifecycle, host handoff, title re-asserts, auto-naming, Herdr/cmux rename, /title — via `mock.timers` + the null-gated test seams in `implementation.ts`, plus a pin that its pi-ai `complete()` import names a specifier that really exports it), rl-extensions picker (16 behavioral tests driving the real `PickerComponent` through a keyboard/theme harness in a temp extensions dir), symlink-manager (real filesystem, temp dirs — broken/stale symlinks, occupied paths, `getExtensionsDir()` absoluteness), panel + extension-loading, co-authored-by-ai (76 tests in two files: `implementation.test.ts` — trailer contract incl. its stable `Co-authored-by: AI` prefix, quote-aware `splitShellCommand`/`containsUnquoted` incl. unterminated quotes and the zero-length-match hang, the four append-to-the-wrong-place regressions, `hasOurTrailer` (only this extension's own trailer stops it — the lookalike `--trailer "Co-authored-by: AI"`, a human trailer, and prose quoting the trailer mid-sentence all get patched), `hasOnlyEmptyMessageLiteral`, `messageIsOnlyTrailer`, plus nine tests running **real git** (patched command → `bash` → `git log --format=%B`: one trailer, a `; && || |`-laden message intact, amend idempotence, the cleanup line after a newline still running, a human trailer appended to, the recorded real-world command (here-doc message file, `-F`, the agent's own lookalike trailer) coming out with subject intact and both attributions, this extension's own trailer never doubled, and the four empty-message shapes that really do commit once `--trailer` is present); `hooks.test.ts` — the two hooks driven through a fake Pi with a fake git: refusal of blank `-m` literals, "unknown, do not refuse" for `$MSG`/`-F`/`--no-edit`, standing down only for its own trailer and never touching git when it does, the warning reaching tool result *and* notification, and silence when the message is fine, when nothing committed, when the call was not ours, and when git cannot answer), memory (isolated Vitest suite; see extensions/memory/README.md for behavior and safety verification; write gates — a pure rule table plus handler tests proving a refused write leaves the file byte-identical and takes no snapshot; semantic search — real child processes against a stand-in `qmd` (`fixtures/fake-qmd.mjs`), never the real binary, which the isolation setup points at a path that does not exist, with the memory package's `smoke:semantic` script as the one check against the real one), scan-guard (135 tests in three files: `classify.test.ts` 107 — the rule (broad root × depth, the ≤ 4 cut-off both ways, `-mount`/`-xdev` not narrowing `/`, `-delete` at any depth), the two grammars (`find <root> …` vs `fd <pattern> [path…]`, `fd`'s five depth spellings, a quoted `"~"` being a directory named tilde, a glob or `$VAR` root refusing to be one), the segmentation root extraction needs and `splitShellCommand` does not do (`$( … )` nesting — where the 5,550 s call hid, here-documents as data, `#` comments, `cd ~` making a `.` a home walk), broad roots, the documented escapes as pinned limits, 44 fail-open shapes each asserted to allow or at least never throw, and the suggestions **executed for real** in a temp tree with `HOME` pointed at it (both `fd` and the `find` fallback, a refused delete leaving its target on disk, a file six directories down still found — the regression that killed `-maxdepth` from the suggestion); `implementation.test.ts` 24 — the three modes on one command, `terminate` never set, contents-opt-in capped log, a throwing UI, a failed `fd` probe, `/scan-guard status`, and coexistence: `git commit … && find ~` blocked with co-authored-by-ai loaded, its trailer added and never run; `corpus.test.ts` 4 — 0 false positives over 12,734 real commands and 29/29 recall on the hand-labelled ones, skipped with instructions when the git-ignored fixture has not been generated)), settle-guard (50 tests: `rule.test.ts` as a pure table of what it interrupts and what it deliberately leaves alone (aborted, error, length, no continuation available, whitespace-only text, junk content), and `implementation.test.ts` driving the real extension against a fake Pi — the `{ continue: true }` request, the thinking level saved and put back, a human level change during the retry never clobbered, the retry budget and one warning per streak, `off` meaning inert, and an unwritable log that still retries), context-viewer (108 tests in four files: `tokens.test.ts` — the estimator per block type, attribution that neither drops nor double-counts a block, scaling that keeps the rows equal to the header, and the estimator **diffed against pi's own `estimateTokens`** by running pi's compaction module in a subprocess, because the test loader's `@earendil-works/*` hook breaks that package's own sub-imports; `text.test.ts` — the tokens column read back out of the rendered table at its own header's column, every line inside the requested width for hostile inputs, **no line containing a newline** (one element of a `render()` array is one terminal row, and an element holding one is painted as two and shifts everything under it), tabs and escape sequences normalised out of text arriving from the host, `breakLine` down to a one-column frame, the estimated/not-measured caveats present when they apply and absent when they do not; `viewer.test.ts` — keys and paging overlap, search scrolling to its match, Tab working mid-search, Escape leaving search before closing, copy taking the whole tab, a missing clipboard reported rather than thrown, plus the frame surviving a tab that hands it multi-line content and a long line wrapped into rows (its tail reachable by scrolling, by search, and re-wrapped when the frame gets wider); `implementation.test.ts` — five tabs built and rendered against a fake Pi, the `!hasUI` one-line fallback, tab aliases, and a host where each read throws on its own still producing a panel that names what it could not read), todos (219 tests in eight files: `store.test.ts` — ids, the one-transaction batch that leaves no half plan, the dependency rules as refusals (cycle, dangling id, parent with open subtasks), the lock (real concurrent writers on one file, re-read inside the lock so a mutation lands on what is on disk, rollback to those bytes when a rule refuses, a stale lock broken by pid check, a corrupt file preserved as `.corrupt-*` rather than read as empty), and `deleteFileIfEmpty` never taking a directory with it; `render.test.ts` — the shared vocabulary: every status glyph distinct, blockers counted only while open (a dangling id invents none), the widget's row budget counted rather than truncated, `oneLine` keeping a task's own words from splitting a terminal row, `truncateVisible` cutting a coloured line by visible width, and ids ordered `t1, t2, t10` because `localeCompare` would read as a wrong plan, and the three densities all opening with the tally, counting what they drop, and holding the width and one-element-per-row rules; `config.test.ts` — the whole storage matrix as pure functions (`session`/`project`/`memory`, every `PI_TODOS` shape incl. `~` still naming a file and `../../etc/passwd` naming a list, not a path), and a hand-edited config typo falling back to defaults instead of breaking the session (including a `widgetDensity` the widget cannot render: `compact`, `off`); `auto-clear.test.ts` — the three modes as a turn-counted table (a half-finished plan never starts counting, a reopened task leaves the schedule); `plan-nudge.test.ts` — what counts as work (`edit`/`write`/`bash`/`powershell`, never the read-only tools) and that the counted unit is the **turn**, so a three-write batch in one turn stays silent (the live-session regression that moved the trigger off call counts), the ask firing once and re-arming only after a list existed and went away, `planNudge: false` meaning inert, and the reminder text naming its own threshold and asking for a one-line reply when declining; `widget.test.ts` — no row before the first task, one registration then repaints, the row taken back when the list empties and on dispose, the animation running only for a task someone is watching and stopping when it finishes, elapsed time read from the store rather than from when the widget appeared (via `mock.timers` with `Date`), and the density cycle contracting the same list while the animation timer follows the rendered rows rather than the store — a spinner the attention cap cut off must not repaint the terminal; `viewer.test.ts` — the frame holding hostile content inside the width, **no line containing a newline**, the progress bar being what a short terminal loses before a task, sections by what needs doing (a task waiting on another lands in Needs Attention, not the queue), one row marked with the cursor, each key asking for exactly one action through the injected handler, every key ignored while an action is in flight (the second `x` would delete whatever moved into its slot), a refused action shown as a status line rather than thrown, and the window moving to keep the cursor's row reachable with the keys still on screen, the frame never taller than the height the host was told (pi slices what is past it, which is how the key lines went missing) with those keys pinned to its last rows; `implementation.test.ts` — 43 tests over a fake Pi: which file each scope opens and that `off` writes nothing at all, a corrupt store reported once with the session still working in memory, a memory list not surviving into a new session but surviving a resume, all four tools' answers including what a bad batch names, the prompt block appearing with open work and being absent when nothing is open, the nudge firing once per quiet stretch and never when the list is empty, the plan nudge riding the third turn containing file changes and never a same-turn batch, staying silent for a read-only session, a session that planned, and a config that turns it off (with a pin that a result carries at most one of the two reminders), the settings menu offering `Plan nudge` and switching it off for the current session, and `/todos` answering a session that has no panel in one message), the `alt+t` handler cycling the widget through its three densities, the configured `widgetDensity` applied at `session_start` and never re-applied over a session's own keypress, the settings menu offering `Widget rows` and applying it at once, and a host whose `notify` throws still getting the change, and the test harness itself (12 tests: Pi packages resolve to the live install, pi-ai root → compat, subpaths stay inside that install, `current-version` decides which release the suite runs, numeric release ordering, a missing install is refused with the fix not with `ERR_MODULE_NOT_FOUND`, `PI_CODING_AGENT_DIR` honoured by hook and generator alike, no Pi copy installed here, type gate and runtime reading the same install, both tsconfigs extending the generated mapping, `.js` → `.ts` remap), the type-paths generator (12, fake installs: both scopes, wildcard subpaths, `exports`-derived mapping, no phantom for a package with no root declarations, `--allow-missing`, JSON tsc accepts, and the generated mapping for this checkout matching the live install), and declared dependencies (6: every imported package named by a manifest, the Pi imports equal to the declared optional peers, no runtime import satisfied by a devDependency, no manifest naming a Pi package, the scanner itself not reading prose as imports, no Pi copy reappearing in `node_modules` — `typebox` had been imported by three components and declared by none, working only because a hoisted copy supplied it), the memory-toolchain guard (5 tests: a missing toolchain names every tool and the command that fixes it, an installed one passes silently, a half-installed one names only what is absent, the message keeps its rationale, and both `test:memory` and `typecheck` are wired to run it), ask (181 tests in two files: `state.test.ts` — the selection strategies, three-state skip tracking, and the notes that are not attached to an option (a shared note surviving tabs and skips, a question note surviving the skip it explains while an option note goes with the answer it qualified, nothing added to the result when nobody typed one, the editor-target bookkeeping that keeps a shared note from being saved onto the focused option, `n`/`m` as keys with neither reaching through an open editor, and `formatResult` writing notes as prose above the JSON while the JSON keeps them verbatim); `implementation.test.ts` driving the real component through a keyboard harness that renders every pass at widths 20 and 80 and asserts **no line containing a newline** (a pasted 480-line answer folds into one terminal row, escape sequences and control characters stripped — an element holding a newline is painted as two and shifts everything under it), `n` on the Done tab editing instead of submitting, Escape keeping the previous note, reopening prefilled so Enter alone keeps it, and the transcript renderer naming each note beside its question). All formerly-dead vitest suites are ported; `npm test` is the only behavior gate, `npm run typecheck` the type gate.
- **Strip-compatible TS:** bare-node tests load extension sources via type stripping, which rejects parameter properties and other transform-only syntax. Memory is tested separately with Vitest.
- **No ESM module mocking (Node 26):** inject dependencies through null-gated seams exported by the module under test (see session-banner's `setCompleteForTesting` / `setExecFileForTesting` / `setFsForTesting`). For async scheduling use `mock.timers` (`apis: ["setTimeout", "setInterval", "setImmediate", "Date"]` whenever the code compares `Date.now()`). Two differences from vitest fake timers, verified on Node 26: a timer due exactly at a tick's end fires only if it was pending *before* the tick, and a timer scheduled inside a tick callback is due at `tickTarget + delay` — size tick windows to strictly exceed the due time rather than landing on it.
- **Test isolation:** Each test creates its own temp directory. Clean up in the same test.
- **No literal counts for repo-wide lists:** anything enumerating the extension catalog derives its expected size from `getAvailableExtensions(getMonorepoRoot())` instead of hardcoding `5`, so adding a component does not require re-pinning behavior tests. The one deliberate exception is the catalog pin in `tests/symlink-manager.test.ts`, which exists to be updated when the catalog changes.
- **A component that produces a command is tested by running it:** `co-authored-by-ai` patches a `git commit` string, so seven of its tests hand the patched command to `bash` in a temp repo and read the recorded message back with `git log --format=%B` — string-level assertions alone would pass while git rejected the flag, duplicated the trailer, or lost the message. Running it also finds things reading cannot: `--trailer` turns git's "empty commit message" exit 1 into a committed message consisting solely of the trailer, a consequence of *succeeding*, and no static assertion about the produced string would ever have shown it. The extension now prevents the statically visible half of that and reports the rest after the fact.
- **No regressions:** When fixing a bug, add a test that reproduces it first.

---

## 6. Safety and Operational Constraints

- **Never push to GitHub** without explicit confirmation from the user.
- **Don't modify Pi's internals** — only work within the extension API.
- **Don't add runtime dependencies** without justification. Pi extensions should be lightweight. Each accepted dependency gets a justification line in its component's README (and is listed in § 1), so the next reader learns *why* it is there instead of inheriting it. Accepted today: `minisearch` (memory's BM25/fuzzy index — no service, no model download) and `typebox` (parameter schemas Pi itself consumes; imported at runtime, so it cannot be a devDependency).
- **No manifest may name a Pi version.** Pi installs a git checkout with `--omit=dev` and peers disabled, and pnpm still *resolves* `devDependencies` under `--prod`: a `@earendil-works/*@1.5.1` pin anywhere turned every install into a registry request for that exact version, which fails on a lagging mirror (`ERR_PNPM_NO_MATCHING_VERSION '@earendil-works/pi-ai@1.5.1'`, npmmirror) even though Pi supplies the packages at runtime. Keep the three peers at `*` **and optional**, get types from `npm run gen:ts-paths`, and let `tests/declared-deps.test.ts` fail anything that tries to reinstall the host.
- **A `postinstall` runs on the user's machine.** Pi's git-install args carry no `--ignore-scripts` (measured at 1.5.1 and confirmed by the clone's own log), so a lifecycle script must be fast, tolerate inputs a fresh clone lacks, and exit 0 regardless — `postinstall` runs the generator with `--allow-missing`, which writes a valid empty config and says why.
- **Every new or changed file must include tests.** No code lands without test coverage.
- **Don't break existing extensions** when adding new ones. Test the full package after changes.

---

## 7. Definition of Done

Before reporting work complete, verify:

1. **`npm test` passes** — all tests green
2. **`npm run typecheck` is clean** — zero errors (needs `npm install`, which also regenerates the Pi type mapping from the live install; a machine with no Pi install there fails loudly rather than type-checking nothing)
3. **Manual testing** — install in Pi (`pi install ...`), reload (`/reload`), and verify the extension works
4. **README updated** — each extension has its own `README.md` in its directory
5. **No breaking changes** — existing extensions still load and function
6. **Concise commit message** — follows conventional commit format (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`)
