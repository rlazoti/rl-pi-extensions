# AGENTS.md

## 1. Project Context

**rl-pi-extensions** is a monorepo for personal [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) extensions. Extensions are distributed as a single package with a TUI for enabling/disabling individual extensions at runtime.

- **Language:** TypeScript (ES modules)
- **Runtime:** Pi uses [jiti](https://github.com/unjs/jiti) for TypeScript compilation (CommonJS output)
- **Package manager:** npm
- **Test runners:** Node.js built-in test runner for the monorepo; isolated Vitest for memory.
- **Dependencies:** `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai` (peer dependencies provided by Pi). The `memory` component ships its own locked dependencies, including runtime `minisearch` (see `extensions/memory/README.md`).

**Key constraint:** Extensions load inside the Pi process. They must not block startup, must handle errors gracefully, and must respect Pi's TUI lifecycle.

---

## 2. Development Commands

| Command | Description |
|---|---|
| `npm test` | Run all tests |
| `npm run typecheck` | `tsc --noEmit` over `extensions/` and `tests/` (strict) |
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
- **Pi packages in tests:** `test-support/register.mjs` (loaded via `--import`) registers a resolve hook that maps `@earendil-works/*` and `@mariozechner/*` to the real packages in the local Pi install (`~/.pi/agent/install/releases/<version>`, override with `PI_CODING_AGENT_DIR`) **before** normal resolution, and remaps jiti-style `.js` relative imports to `.ts` inside this repo. Mapping first matters: `npm install` also puts a pinned copy in this repo's `node_modules` (that is what `npm run typecheck` resolves types from), and letting it win would silently test against versions that lag the running Pi. `tests/test-harness.test.ts` pins the resolution rules, asserts the pinned copy's version equals the live Pi install's (bump the pinned dev/peer dependency when Pi upgrades — pinned exactly, currently 1.3.0, never with a caret), and asserts the mismatch is reported on stderr. Test files import sibling sources with `.ts` extensions.
- **Coverage map:** emacs-feedback (53, behavioral), session-attention (process roles, ask-body formatting, truncation, notification activation: bundle id from `__CFBundleIdentifier`, iTerm fallback, shell-escaping), snippets (display-safe, placeholders, frontmatter helpers), tmux-feedback (state reconstruction, message formatting, command handlers via fake Pi), session-banner (helpers: names/titles/auto-naming/URL reduction; panes: RenderScheduler + paneRegistry via `mock.timers`; index: full extension behavior — lifecycle, host handoff, title re-asserts, auto-naming, Herdr/cmux rename, /title — via `mock.timers` + the null-gated test seams in `implementation.ts`, plus a pin that its pi-ai `complete()` import names a specifier that really exports it), rl-extensions picker (16 behavioral tests driving the real `PickerComponent` through a keyboard/theme harness in a temp extensions dir), symlink-manager (real filesystem, temp dirs — broken/stale symlinks, occupied paths, `getExtensionsDir()` absoluteness), panel + extension-loading, co-authored-by-ai (76 tests in two files: `implementation.test.ts` — trailer contract incl. its stable `Co-authored-by: AI` prefix, quote-aware `splitShellCommand`/`containsUnquoted` incl. unterminated quotes and the zero-length-match hang, the four append-to-the-wrong-place regressions, `hasOurTrailer` (only this extension's own trailer stops it — the lookalike `--trailer "Co-authored-by: AI"`, a human trailer, and prose quoting the trailer mid-sentence all get patched), `hasOnlyEmptyMessageLiteral`, `messageIsOnlyTrailer`, plus nine tests running **real git** (patched command → `bash` → `git log --format=%B`: one trailer, a `; && || |`-laden message intact, amend idempotence, the cleanup line after a newline still running, a human trailer appended to, the recorded real-world command (here-doc message file, `-F`, the agent's own lookalike trailer) coming out with subject intact and both attributions, this extension's own trailer never doubled, and the four empty-message shapes that really do commit once `--trailer` is present); `hooks.test.ts` — the two hooks driven through a fake Pi with a fake git: refusal of blank `-m` literals, "unknown, do not refuse" for `$MSG`/`-F`/`--no-edit`, standing down only for its own trailer and never touching git when it does, the warning reaching tool result *and* notification, and silence when the message is fine, when nothing committed, when the call was not ours, and when git cannot answer), memory (isolated Vitest suite; see extensions/memory/README.md for behavior and safety verification), scan-guard (135 tests in three files: `classify.test.ts` 107 — the rule (broad root × depth, the ≤ 4 cut-off both ways, `-mount`/`-xdev` not narrowing `/`, `-delete` at any depth), the two grammars (`find <root> …` vs `fd <pattern> [path…]`, `fd`'s five depth spellings, a quoted `"~"` being a directory named tilde, a glob or `$VAR` root refusing to be one), the segmentation root extraction needs and `splitShellCommand` does not do (`$( … )` nesting — where the 5,550 s call hid, here-documents as data, `#` comments, `cd ~` making a `.` a home walk), broad roots, the documented escapes as pinned limits, 44 fail-open shapes each asserted to allow or at least never throw, and the suggestions **executed for real** in a temp tree with `HOME` pointed at it (both `fd` and the `find` fallback, a refused delete leaving its target on disk, a file six directories down still found — the regression that killed `-maxdepth` from the suggestion); `implementation.test.ts` 24 — the three modes on one command, `terminate` never set, contents-opt-in capped log, a throwing UI, a failed `fd` probe, `/scan-guard status`, and coexistence: `git commit … && find ~` blocked with co-authored-by-ai loaded, its trailer added and never run; `corpus.test.ts` 4 — 0 false positives over 12,734 real commands and 29/29 recall on the hand-labelled ones, skipped with instructions when the git-ignored fixture has not been generated)), settle-guard (50 tests: `rule.test.ts` as a pure table of what it interrupts and what it deliberately leaves alone (aborted, error, length, no continuation available, whitespace-only text, junk content), and `implementation.test.ts` driving the real extension against a fake Pi — the `{ continue: true }` request, the thinking level saved and put back, a human level change during the retry never clobbered, the retry budget and one warning per streak, `off` meaning inert, and an unwritable log that still retries), context-viewer (108 tests in four files: `tokens.test.ts` — the estimator per block type, attribution that neither drops nor double-counts a block, scaling that keeps the rows equal to the header, and the estimator **diffed against pi's own `estimateTokens`** by running pi's compaction module in a subprocess, because the test loader's `@earendil-works/*` hook breaks that package's own sub-imports; `text.test.ts` — the tokens column read back out of the rendered table at its own header's column, every line inside the requested width for hostile inputs, **no line containing a newline** (one element of a `render()` array is one terminal row, and an element holding one is painted as two and shifts everything under it), tabs and escape sequences normalised out of text arriving from the host, `breakLine` down to a one-column frame, the estimated/not-measured caveats present when they apply and absent when they do not; `viewer.test.ts` — keys and paging overlap, search scrolling to its match, Tab working mid-search, Escape leaving search before closing, copy taking the whole tab, a missing clipboard reported rather than thrown, plus the frame surviving a tab that hands it multi-line content and a long line wrapped into rows (its tail reachable by scrolling, by search, and re-wrapped when the frame gets wider); `implementation.test.ts` — five tabs built and rendered against a fake Pi, the `!hasUI` one-line fallback, tab aliases, and a host where each read throws on its own still producing a panel that names what it could not read), and the test harness itself (6 tests: Pi packages must resolve to the live Pi install, pi-ai root → compat, pinned-copy/runtime version parity, mismatch reported on stderr, `.js` → `.ts` remap). All formerly-dead vitest suites are ported; `npm test` is the only behavior gate, `npm run typecheck` the type gate.
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
- **Don't add runtime dependencies** without justification. Pi extensions should be lightweight. Each accepted dependency gets a justification line in its component's README (and is listed in § 1), so the next reader learns *why* it is there instead of inheriting it.
- **Every new or changed file must include tests.** No code lands without test coverage.
- **Don't break existing extensions** when adding new ones. Test the full package after changes.

---

## 7. Definition of Done

Before reporting work complete, verify:

1. **`npm test` passes** — all tests green
2. **`npm run typecheck` is clean** — zero errors (needs `npm install`; the Pi packages arrive as auto-installed peer dependencies)
3. **Manual testing** — install in Pi (`pi install ...`), reload (`/reload`), and verify the extension works
4. **README updated** — each extension has its own `README.md` in its directory
5. **No breaking changes** — existing extensions still load and function
6. **Concise commit message** — follows conventional commit format (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`)
