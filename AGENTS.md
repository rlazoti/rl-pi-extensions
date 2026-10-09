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
- **Import paths:** Use `.ts` extension in imports (jiti resolves `.js` to `.ts` at runtime, but tests use `node --experimental-strip-types` which requires `.ts`).
- **Type safety:** Use TypeScript interfaces for public APIs. `any` is acceptable only in wrapper files that delegate to implementations.
- **Naming:** Extensions use kebab-case (`tmux-feedback`, `rl-extensions`). Directories match.
- **Config files:** Store in `~/.pi/agent/` with descriptive names (`rl-extensions.json`).
- **No side effects in wrappers:** Wrapper `index.ts` files should only check config and delegate — no business logic.

---

## 4. Architecture and Design Rules

### Extension Structure

Each extension loads directly — no wrapper pattern:

```
extensions/
├── symlink-manager.ts              # Shared symlink management
├── <extension-name>/
│   ├── index.ts                    # Entry point (exports implementation)
│   └── implementation.ts           # Real extension code (or multiple files)
└── rl-extensions/
    └── index.ts                    # TUI manager extension
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

The manager (`rl-extensions`) creates/removes these symlinks. Only symlinked extensions appear in Pi's `[Extensions]` list.

### TUI Guidelines

- Use Pi's built-in components (`SelectList`, `Container`, `Text`, `DynamicBorder`) over custom rendering.
- For custom components, use `matchesKey()` for keyboard input matching.
- Use `ctx.ui.custom()` for modal overlays, `ctx.ui.select()` for simple selections.
- Always call `tui.requestRender()` after state changes.
- Guard TUI-only behavior with `ctx.mode === "tui"` when needed.

### Config Management

- **No config file needed** — symlinks are the source of truth
- Extensions are **disabled by default** (no symlink)
- Users explicitly enable via `/rl-extensions` or manual symlink creation

---

## 5. Testing Expectations

- **Run `npm test`** before every commit. All tests must pass.
- **Test coverage targets:**
  - `symlink-manager.test.ts`: symlink creation/removal, toggle logic, directory structure
  - `manager.test.ts`: command registration, handler existence (source inspection since Pi deps unavailable)
- **Test isolation:** Each test creates its own temp directory. Clean up in the same test.
- **No regressions:** When fixing a bug, add a test that reproduces it first.

---

## 6. Safety and Operational Constraints

- **Never push to GitHub** without explicit confirmation from the user.
- **Don't modify Pi's internals** — only work within the extension API.
- **Don't add runtime dependencies** without justification. Pi extensions should be lightweight.
- **Every new or changed file must include tests.** No code lands without test coverage.
- **Don't break existing extensions** when adding new ones. Test the full package after changes.
- **Config files are user data** — never overwrite `~/.pi/agent/rl-extensions.json` without preserving existing entries.

---

## 7. Definition of Done

Before reporting work complete, verify:

1. **`npm test` passes** — all tests green
2. **Manual testing** — install in Pi (`pi install ...`), reload (`/reload`), and verify the extension works
3. **README updated** — each extension has its own `README.md` in its directory
4. **No breaking changes** — existing extensions still load and function
5. **Concise commit message** — follows conventional commit format (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`)
