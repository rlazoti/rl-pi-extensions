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
├── memory/
│   ├── index.ts                    # Entry point (re-exports implementation)
│   ├── implementation.ts           # Tools, /memory, injection hook, dialogs
│   ├── gate.ts resolver.ts schema.ts   # Admission gate, authority, entry grammar
│   ├── inject.ts pending.ts service.ts # Recall + budget, conflict queue, use cases
│   ├── workingState.ts            # The injected working state: verbatim status file, open daily items, per-file budgets
│   ├── rollover.ts dailyItems.ts       # Daily archive, reported carry, item ageing
│   ├── migrate.ts fs-store.ts markdown.ts # Prose→entry migration, atomic bank I/O
│   └── README.md                   # The spec: authority, conflict protocol, non-goals
├── co-authored-by-ai/
│   ├── index.ts                    # Entry point (re-exports implementation)
│   └── implementation.ts           # tool_call patching + refusal, tool_result check
└── rl-extensions/
    ├── index.ts                    # TUI extension manager
    └── picker.ts                   # Picker overlay (layout via panel.ts)
```

> `extensions/memory/` is a **live component** (shipped in v1.4.0): `memory_write` /
> `memory_show` / `memory_search` / `memory_doctor`, `/memory …`, a per-turn
> injection hook, and a write-time gate that refuses rival claims until the human
> decides. It is enabled by a symlink at `~/.pi/agent/extensions/memory` (created by
> the rl-extensions manager), and it is the only component with a runtime dependency
> of its own (`minimatch`). `extensions/memory/README.md` is the spec — authority
> order, the conflict protocol, and the deliberate non-goals are decided there, not
> re-argued per session.

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
- **Discovery:** `npm test` runs `node --test .` with recursive discovery — every `*.test.ts` / `*.test.mjs` under `tests/` and `extensions/` runs automatically. Never hardcode file lists.
- **Pi packages in tests:** `test-support/register.mjs` (loaded via `--import`) registers a resolve hook that maps `@earendil-works/*` and `@mariozechner/*` to the real packages in the local Pi install (`~/.pi/agent/install/releases/<version>`, override with `PI_CODING_AGENT_DIR`) **before** normal resolution, and remaps jiti-style `.js` relative imports to `.ts` inside this repo. Mapping first matters: `npm install` also puts a pinned copy in this repo's `node_modules` (that is what `npm run typecheck` resolves types from), and letting it win would silently test against versions that lag the running Pi. `tests/test-harness.test.ts` pins the resolution rules, asserts the pinned copy's version equals the live Pi install's (bump the pinned dev/peer dependency when Pi upgrades — pinned exactly, currently 1.3.0, never with a caret), and asserts the mismatch is reported on stderr. Test files import sibling sources with `.ts` extensions.
- **Coverage map:** emacs-feedback (53, behavioral), session-attention (process roles, ask-body formatting, truncation, notification activation: bundle id from `__CFBundleIdentifier`, iTerm fallback, shell-escaping), snippets (display-safe, placeholders, frontmatter helpers), tmux-feedback (state reconstruction, message formatting, command handlers via fake Pi), session-banner (helpers: names/titles/auto-naming/URL reduction; panes: RenderScheduler + paneRegistry via `mock.timers`; index: full extension behavior — lifecycle, host handoff, title re-asserts, auto-naming, Herdr/cmux rename, /title — via `mock.timers` + the null-gated test seams in `implementation.ts`, plus a pin that its pi-ai `complete()` import names a specifier that really exports it), rl-extensions picker (16 behavioral tests driving the real `PickerComponent` through a keyboard/theme harness in a temp extensions dir), symlink-manager (real filesystem, temp dirs — broken/stale symlinks, occupied paths, `getExtensionsDir()` absoluteness), panel + extension-loading, co-authored-by-ai (69 tests in two files: `implementation.test.ts` — trailer contract incl. its stable `Co-authored-by: AI` prefix, quote-aware `splitShellCommand`/`containsUnquoted` incl. unterminated quotes and the zero-length-match hang, the four append-to-the-wrong-place regressions, `hasOnlyEmptyMessageLiteral`, `messageIsOnlyTrailer`, plus seven tests running **real git** (patched command → `bash` → `git log --format=%B`: one trailer, a `; && || |`-laden message intact, amend idempotence, the cleanup line after a newline still running, a human trailer appended to, and the four empty-message shapes that really do commit once `--trailer` is present); `hooks.test.ts` — the two hooks driven through a fake Pi with a fake git: refusal of blank `-m` literals, "unknown, do not refuse" for `$MSG`/`-F`/`--no-edit`, the warning reaching tool result *and* notification, and silence when the message is fine, when nothing committed, when the call was not ours, and when git cannot answer), memory (284 tests: entry schema — key/scope/status/asOf validation, errors that never silently default, duplicate-identity detection, deterministic authority order, render↔parse idempotence; resolver — two-gate authority resolution, fail-closed on a contested identity with `bestCandidate` kept for the human, scope shadowing across `project`/`path`/`global`, minimatch path scopes with `dot`/`nonegate`/`nocomment` pinned, and invariant sweeps over 200 generated stores; the read surface — `memory_read`/`memory_list` containment (`..`, absolute paths, a **symlink inside the bank pointing outside it**), windows counted in graphemes so no ZWJ emoji is ever split, leftover `.tmp-<pid>` siblings reported as damage; the working-state budgets — a line is never cut in half, dropped items are counted and named, an unreadable daily file still gets its warning; plus the Pi adapter: tools, the `/memory` command, the injection hook, the single-instance guard, and the conflict protocol — dialog showing both claims and the refusal reason, no timer, contests parked before anyone is asked, one dialog at a time because Pi has a single dialog slot, dialogs carrying the tool call's abort signal), and the test harness itself (6 tests: Pi packages must resolve to the live Pi install, pi-ai root → compat, pinned-copy/runtime version parity, mismatch reported on stderr, `.js` → `.ts` remap). All formerly-dead vitest suites are ported; `npm test` is the only behavior gate, `npm run typecheck` the type gate.
- **Strip-compatible TS:** bare-node tests load extension sources via type stripping, which rejects parameter properties and other transform-only syntax — keep extension code strip-compatible (plain `constructor(x) { this.x = x }`).
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
