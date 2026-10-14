# AGENTS.md

## 1. Project Context

**rl-pi-extensions** is a monorepo for personal [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) extensions. Extensions are distributed as a single package with a TUI for enabling/disabling individual extensions at runtime.

- **Language:** TypeScript (ES modules)
- **Runtime:** Pi uses [jiti](https://github.com/unjs/jiti) for TypeScript compilation (CommonJS output)
- **Package manager:** npm
- **Test runner:** Node.js built-in test runner (`node --test`)
- **Dependencies:** `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai` (peer dependencies provided by Pi)

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
└── rl-extensions/
    ├── index.ts                    # TUI extension manager
    └── picker.ts                   # Picker overlay (layout via panel.ts)
```

> `extensions/memory/` is also present (Phase 1 of a new component: `schema.ts`
> entry parser, `implementation.ts` registering nothing yet). It is in the
> catalog but never symlinked while unfinished — see `extensions/memory/README.md`.

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

---

## 5. Testing Expectations

- **Run `npm test` and `npm run typecheck`** before every commit. All tests must pass and the type-check must be clean. Pi loads extensions through jiti, which strips types without checking them, so a type error never reaches `npm test` — the tsc gate exists to catch exactly that (it found a pi-ai import that resolves in Pi's virtual-module loader but not in plain ESM, and a `Theme` type pi-tui does not export).
- **Discovery:** `npm test` runs `node --test .` with recursive discovery — every `*.test.ts` / `*.test.mjs` under `tests/` and `extensions/` runs automatically. Never hardcode file lists.
- **Pi packages in tests:** `test-support/register.mjs` (loaded via `--import`) registers a resolve hook that maps `@earendil-works/*` and `@mariozechner/*` to the real packages in the local Pi install (`~/.pi/agent/install/releases/<version>`, override with `PI_CODING_AGENT_DIR`) **before** normal resolution, and remaps jiti-style `.js` relative imports to `.ts` inside this repo. Mapping first matters: `npm install` also puts a pinned copy in this repo's `node_modules` (that is what `npm run typecheck` resolves types from), and letting it win would silently test against versions that lag the running Pi. `tests/test-harness.test.ts` pins the resolution rules, asserts the pinned copy's version equals the live Pi install's (bump the pinned dev/peer dependency when Pi upgrades), and asserts the mismatch is reported on stderr. Test files import sibling sources with `.ts` extensions.
- **Coverage map:** emacs-feedback (53, behavioral), session-attention (process roles, ask-body formatting, truncation, notification activation: bundle id from `__CFBundleIdentifier`, iTerm fallback, shell-escaping), snippets (display-safe, placeholders, frontmatter helpers), tmux-feedback (state reconstruction, message formatting, command handlers via fake Pi), session-banner (helpers: names/titles/auto-naming/URL reduction; panes: RenderScheduler + paneRegistry via `mock.timers`; index: full extension behavior — lifecycle, host handoff, title re-asserts, auto-naming, Herdr/cmux rename, /title — via `mock.timers` + the null-gated test seams in `implementation.ts`, plus a pin that its pi-ai `complete()` import names a specifier that really exports it), rl-extensions picker (16 behavioral tests driving the real `PickerComponent` through a keyboard/theme harness in a temp extensions dir), symlink-manager (real filesystem, temp dirs — broken/stale symlinks, occupied paths, `getExtensionsDir()` absoluteness), panel + extension-loading, memory (entry schema: key/scope/status/asOf validation, errors that never silently default, duplicate-identity detection, deterministic authority order, render↔parse idempotence; plus a pin that the unfinished factory registers nothing), and the test harness itself (6 tests: Pi packages must resolve to the live Pi install, pi-ai root → compat, pinned-copy/runtime version parity, mismatch reported on stderr, `.js` → `.ts` remap). All formerly-dead vitest suites are ported; `npm test` is the only behavior gate, `npm run typecheck` the type gate.
- **Strip-compatible TS:** bare-node tests load extension sources via type stripping, which rejects parameter properties and other transform-only syntax — keep extension code strip-compatible (plain `constructor(x) { this.x = x }`).
- **No ESM module mocking (Node 26):** inject dependencies through null-gated seams exported by the module under test (see session-banner's `setCompleteForTesting` / `setExecFileForTesting` / `setFsForTesting`). For async scheduling use `mock.timers` (`apis: ["setTimeout", "setInterval", "setImmediate", "Date"]` whenever the code compares `Date.now()`). Two differences from vitest fake timers, verified on Node 26: a timer due exactly at a tick's end fires only if it was pending *before* the tick, and a timer scheduled inside a tick callback is due at `tickTarget + delay` — size tick windows to strictly exceed the due time rather than landing on it.
- **Test isolation:** Each test creates its own temp directory. Clean up in the same test.
- **No literal counts for repo-wide lists:** anything enumerating the extension catalog derives its expected size from `getAvailableExtensions(getMonorepoRoot())` instead of hardcoding `5`, so adding a component does not require re-pinning behavior tests.
- **No regressions:** When fixing a bug, add a test that reproduces it first.

---

## 6. Safety and Operational Constraints

- **Never push to GitHub** without explicit confirmation from the user.
- **Don't modify Pi's internals** — only work within the extension API.
- **Don't add runtime dependencies** without justification. Pi extensions should be lightweight.
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
