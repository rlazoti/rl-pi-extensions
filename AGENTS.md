# AGENTS.md

## 1. Project Context

**rl-pi-extensions** is a monorepo for personal [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) extensions. Extensions are distributed as a single package with a TUI for enabling/disabling individual extensions at runtime.

- **Language:** TypeScript (ES modules)
- **Runtime:** Pi uses [jiti](https://github.com/unjs/jiti) for TypeScript compilation (CommonJS output)
- **Package manager:** npm
- **Test runner:** Node.js built-in test runner (`node --test`)
- **Dependencies:** `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai` (peer dependencies provided by Pi). The `memory` component additionally ships one runtime dependency of its own: `minimatch` (see § 6 and `extensions/memory/README.md`).

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
├── memory/                         # budgeted, governed memory (see its README)
│   ├── index.ts                    # Entry point (re-exports implementation)
│   ├── implementation.ts           # Pi adapter: tools, /memory, the three hooks
│   ├── bank.ts                     # Use-case layer every decision is tested through
│   ├── grammar.ts scope.ts time.ts # Entry grammar, identity/scope, the day a claim belongs to
│   ├── store.ts queue.ts           # Bank I/O (atomic, history, archive, backup), pending claims
│   ├── gate.ts daily.ts            # Write-time checks; the daily log and its rollover
│   ├── rank.ts inject.ts notice.ts # BM25 + the Ranker interface, budgeted injection, review notice
│   ├── context.ts                  # What one conversation is allowed to carry (R25.1)
│   ├── config.ts trial.ts migrate.ts # Validated defaults, trial metrics/baseline, migration waves
│   ├── design/                     # intent.md + spec.md (R1–R50, D1–D19)
│   ├── cutover-callers.md          # Read-only caller inventory (spec R40.0)
│   └── README.md                   # The spec: authority, conflict protocol, non-goals
└── rl-extensions/
    ├── index.ts                    # TUI extension manager
    └── picker.ts                   # Picker overlay (layout via panel.ts)
```

> `extensions/memory/` is a **live component** written to
> `extensions/memory/design/spec.md` (R1–R50, D1–D19): reads are
> `memory_read` / `memory_list` / `memory_search`; writes are only `memory_log`
> (the daily log, dated by the extension) and `memory_propose` (a **pending**
> claim — the agent can never write an approved one), plus `memory_archive` for
> leftover prose. `/memory …` covers status, preview, review, doctor, flags, trial
> and migration; `session_start` shows a review notice, `before_agent_start`
> injects a budgeted block (2000 tokens: core 600, open daily items 500, retrieved
> claims the rest) for user-started runs only. Rules are context, never
> enforcement: **no `tool_call` handler is registered**. The picker never replaces
> or removes a `memory` link it did not create. The only runtime dependency is
> `minimatch` (path scopes). `extensions/memory/README.md` is the spec — authority
> order, the conflict protocol, and the deliberate non-goals are decided there, not
> re-argued per session; `cutover-callers.md` is the read-only caller inventory the
> cutover checklist points at.

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

- A component that writes a format must be able to read back what it wrote, and the test is the **second pass**: write, read, write again. The mirror rule is the one that bites: **a writer may rewrite only what it can reproduce.** Re-rendering a file from the parts that parsed deletes the parts that did not, so a hand typo in one entry used to vanish the next time an unrelated claim was proposed into the same file. A store write now refuses and names the line (`StoreUnreadable` in `memory/store.ts`); a log write inserts one line and leaves every other byte alone. Every occurrence of this in `memory` was the writer changing shape (a `Group — Section` heading, a provenance line moved into the body) while the reader still matched only the hand-written form, so the next pass called its own output unrecognised and dropped real work.
- Position carries meaning, not only names: `## In Progress` over `### Money Manager` is Money Manager's open work, and a heading with children groups rather than swallowing them.
- A derived filename is a slot, not an identity. Never overwrite a record; identical bytes mean it already exists; any other collision takes the next free slot beside it. Blocking on the name left a live daily file permanently unarchivable while its staleness warning fired every turn.

---

## 5. Testing Expectations

- **Run `npm test` and `npm run typecheck`** before every commit. All tests must pass and the type-check must be clean. Pi loads extensions through jiti, which strips types without checking them, so a type error never reaches `npm test` — the tsc gate exists to catch exactly that (it found a pi-ai import that resolves in Pi's virtual-module loader but not in plain ESM, and a `Theme` type pi-tui does not export).
- **Discovery:** `npm test` runs `node --test .` with recursive discovery — every `*.test.ts` / `*.test.mjs` under `tests/` and `extensions/` runs automatically. Never hardcode file lists.
- **Pi packages in tests:** `test-support/register.mjs` (loaded via `--import`) registers a resolve hook that maps `@earendil-works/*` and `@mariozechner/*` to the real packages in the local Pi install (`~/.pi/agent/install/releases/<version>`, override with `PI_CODING_AGENT_DIR`) **before** normal resolution, and remaps jiti-style `.js` relative imports to `.ts` inside this repo. Mapping first matters: `npm install` also puts a pinned copy in this repo's `node_modules` (that is what `npm run typecheck` resolves types from), and letting it win would silently test against versions that lag the running Pi. `tests/test-harness.test.ts` pins the resolution rules, asserts the pinned copy's version equals the live Pi install's (bump the pinned dev/peer dependency when Pi upgrades — pinned exactly, currently 1.3.0, never with a caret), and asserts the mismatch is reported on stderr. Test files import sibling sources with `.ts` extensions.
- **Coverage map:** emacs-feedback (53, behavioral), session-attention (process roles, ask-body formatting, truncation, notification activation: bundle id from `__CFBundleIdentifier`, iTerm fallback, shell-escaping), snippets (display-safe, placeholders, frontmatter helpers), tmux-feedback (state reconstruction, message formatting, command handlers via fake Pi), session-banner (helpers: names/titles/auto-naming/URL reduction; panes: RenderScheduler + paneRegistry via `mock.timers`; index: full extension behavior — lifecycle, host handoff, title re-asserts, auto-naming, Herdr/cmux rename, /title — via `mock.timers` + the null-gated test seams in `implementation.ts`, plus a pin that its pi-ai `complete()` import names a specifier that really exports it), rl-extensions picker (32: behavioral keyboard/theme harness in a temp extensions dir, plus module-shape pins; includes the R42 guard — a name held by a link the picker did not create is refused and the link is left alone), symlink-manager (24, real filesystem in temp dirs — broken/stale symlinks, occupied paths, `getExtensionsDir()` absoluteness, `getForeignLink()` distinguishing our own link from a live foreign one and from a broken one), panel + extension-loading + manager, jiti loading (2: every component loads under Pi's jiti transform and registers something; memory's tool/command/hook surface pinned there), memory (236, one file per module: grammar — required `key`/`kind`/`scope`/`asOf`/`source`, errors that never silently default, malformed entries reported with file and line and excluded alone, byte-stable write→read→write for every file kind the component writes; scope — project id from remote/git root/cwd, `path:` globs with minimatch `dot`/`nonegate`/`nocomment` pinned, shadowing `path` > `project` > `global`; store — atomic writes with no half-written file left behind, history moves byte for byte, archive slot allocation, backup verified by listing it back; queue — at most one approved and one pending claim per identity, contested identities fail closed, ageing at `pendingFlagDays`, approve/reject/defer/edit, origin waves; gate — the status-signal table (SHAs, PR/issue/run numbers, CI URLs, a date next to a status verb), `source`/`links` exemption, override-with-reason, supersession-prose refusal; daily — extension-stamped dates, rollover with reported carry, open-item selection, damage reported per line; rank — BM25 determinism and the `Ranker` seam, unknown ranker reported and fallen back, the stopword table having no holes, word families folding (`branches`/`branched`/`branching`, `status`/`alias`/`class` untouched), the probe table of queries and their expected keys in order with chat queries retrieving nothing, and the score floor holding at a share of the top hit while `memory_search` runs without it; context — the newest memory block alone reaches the model, a newest block that recalled nothing carries back the newest one that did (marked, never two of them, never a rewrite of a block whose content it cannot reproduce), another extension's `custom` message is never dropped, and pruning twice drops nothing more; inject — the R28 eligibility table, section caps and flow-through, the recall cap holding a turn below the budget and naming which limit stopped each claim (R27.4, R29), tokens ≤ budget swept over generated stores, entries never split, dropped entries counted and named, `[unapproved]` ranked below approved, preview; notice — counts per category, silence when empty, logged once outside the TUI; config — validated defaults with a warning per bad key, the recall cap validated and 0 meaning uncapped, describeConfig naming it, the settings table being the validator (one row per setting, each range accepted at both bounds and refused just outside with the fallback named, only the non-numeric settings unbounded), which value the file set vs. defaulted vs. moved by the section interlock, and the listing showing every knob with its default, range and origin plus the derived recall the caps leave, the paste-ready template parsing as accepted config with every key at its default while a one-key file leaves the rest default and the listing writes no file, and no rendered line carrying a requirement ID; the subcommand table appearing complete in the command-list line, `/memory help` and the argument completions with no listed name unimplemented, the README's command list checked against it in both directions; trial — metrics lines carry no prompt text and name the bank they were injected into, a preview writes none, flag recording, every gate of the verdict (clock at 3 approved claims, the window measured from the first recorded turn and half its days carrying turns, 5 turns that retrieved, the 25% ratio, the 1,200-token ceiling, zero flags) with a one-day burst refused as not-a-week and every unmet gate named in one verdict, overrides as one event line each and reported rather than gated, baseline measured from fixture session files with the same estimator and nothing written when the marker is absent; migrate — every step but the backup refuses without a verified backup, waves derived from the files that exist, resumable state, `--file`/`--batch`, `apply` drafting a whole wave through the gate and reporting what it refused, the working-state wave keeping each item's own date while project status is left out, retired entries never proposed, cutover archives instead of deletes; and `index.test.ts` driving the real Pi surface — the exact registered tool set with the old write names absent, no `tool_call` handler at all, the context handler holding a three-turn conversation to one block (two when the newest recalled nothing) while the session file keeps all three and one context sample is written per turn, the session-start notice on `new` but not `resume`, injection for user-started runs only, metrics appended per turn, a failing metrics write failing the injection open with one warning, read-tool containment, review opening one dialog at a time and a whole wave in one command, the inline conflict dialog on and off, a claim store edited outside the extension (or by another session) re-read on the next turn, `/memory migrate apply → review → approve` end to end, `/memory settings` listing every knob with `config` still answering to the old name, and a config file edited outside the session changing the next turn's injection (the recall cap applied) without a restart, and a pin that `estimateTokens` really is exported by the installed Pi), and the test harness itself (6 tests: Pi packages must resolve to the live Pi install, pi-ai root → compat, pinned-copy/runtime version parity, mismatch reported on stderr, `.js` → `.ts` remap). All formerly-dead vitest suites are ported; `npm test` is the only behavior gate, `npm run typecheck` the type gate.
- **Strip-compatible TS:** bare-node tests load extension sources via type stripping, which rejects parameter properties and other transform-only syntax — keep extension code strip-compatible (plain `constructor(x) { this.x = x }`).
- **No ESM module mocking (Node 26):** inject dependencies through null-gated seams exported by the module under test (see session-banner's `setCompleteForTesting` / `setExecFileForTesting` / `setFsForTesting`). For async scheduling use `mock.timers` (`apis: ["setTimeout", "setInterval", "setImmediate", "Date"]` whenever the code compares `Date.now()`). Two differences from vitest fake timers, verified on Node 26: a timer due exactly at a tick's end fires only if it was pending *before* the tick, and a timer scheduled inside a tick callback is due at `tickTarget + delay` — size tick windows to strictly exceed the due time rather than landing on it.
- **Test isolation:** Each test creates its own temp directory. Clean up in the same test.
- **No literal counts for repo-wide lists:** anything enumerating the extension catalog derives its expected size from `getAvailableExtensions(getMonorepoRoot())` instead of hardcoding `5`, so adding a component does not require re-pinning behavior tests.
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
