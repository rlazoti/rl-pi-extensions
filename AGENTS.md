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
    └── index.ts                    # TUI extension manager
```

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

- **Run `npm test`** before every commit. All tests must pass.
- **Discovery:** `npm test` runs `node --test .` with recursive discovery — every `*.test.ts` / `*.test.mjs` under `tests/` and `extensions/` runs automatically. Never hardcode file lists.
- **Pi packages in tests:** `test-support/register.mjs` (loaded via `--import`) registers a resolve hook that aliases `@earendil-works/*` and `@mariozechner/*` to the real packages in the local Pi install (`~/.pi/agent/install/releases/<version>`, override with `PI_CODING_AGENT_DIR`) and remaps jiti-style `.js` relative imports to `.ts` inside this repo. Test files import sibling sources with `.ts` extensions.
- **Coverage map:** emacs-feedback (53, behavioral), session-attention (process roles, ask-body formatting, truncation), snippets (display-safe, placeholders, frontmatter helpers), tmux-feedback (state reconstruction, message formatting, command handlers via fake Pi), session-banner (helpers: names/titles/auto-naming/URL reduction; panes: RenderScheduler + paneRegistry via `mock.timers`), symlink-manager + picker + extension-loading (string/behavioral). The one remaining unported vitest suite (session-banner `index.test.vitest.ts`) is out of discovery until ported.
- **Strip-compatible TS:** bare-node tests load extension sources via type stripping, which rejects parameter properties and other transform-only syntax — keep extension code strip-compatible (plain `constructor(x) { this.x = x }`).
- **Test isolation:** Each test creates its own temp directory. Clean up in the same test.
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
2. **Manual testing** — install in Pi (`pi install ...`), reload (`/reload`), and verify the extension works
3. **README updated** — each extension has its own `README.md` in its directory
4. **No breaking changes** — existing extensions still load and function
5. **Concise commit message** — follows conventional commit format (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`)
