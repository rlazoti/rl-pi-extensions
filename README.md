# rl-pi-extensions

Personal Pi coding agent extensions, managed as a single package with a TUI for enabling/disabling.

## Extensions

| Extension | Description |
|-----------|-------------|
| **ask** | Ask structured single- or multi-select questions, with custom answers and notes |
| **tmux-feedback** | Inline feedback for tmux scrollback selection |
| **session-banner** | Colored banner + auto-naming for Pi sessions |
| **session-attention** | Desktop notifications when Pi needs your attention |
| **snippets** | Insert predefined text snippets into the prompt |
| **emacs-feedback** | Source-region and Magit diff-line feedback from Emacs |
| **memory** | Persistent Markdown memory bank, searchable knowledge and history, selective context injection, write gates on the daily file, managed-write safety, optional recovery snapshots and optional semantic search through qmd. See `extensions/memory/README.md`. |
| **co-authored-by-ai** | Adds a `Co-authored-by: AI (Pi/<model>)` trailer to the commits Pi creates, by patching `git commit` before it runs |
| **scan-guard** | Refuses a `bash` command that walks `/` or all of `$HOME` with no depth bound — 29 of 13,084 recorded calls, 9.4% of all bash wall time — and answers with the scoped search. Notify-only by default; `PI_SCAN_GUARD=block` to refuse. `bash -c "find /"` and friends are documented escapes, not bugs |
| **settle-guard** | Asks again when a model turn ends with reasoning and no answer, which is what makes a session stop mid-run and wait for a keystroke. The retry goes out with reasoning off — 8 of 9 replays with it, 0 of 3 without. Two per streak, then it stops and says so |
| **todos** | A task list the agent keeps and you can see: `TodoCreate`/`TodoList`/`TodoGet`/`TodoUpdate`, the open work re-injected every turn, a live row above the editor with a spinner and elapsed time, `/todos` to move tasks by hand, and one ask when file edits start with no plan. Per-session file by default; finished work clears itself 4 turns after it lands |
| **context-viewer** | `/context`: browse the context window — the measured token total split by category (system prompt, tool schemas, tool calls and results, thinking, messages), the system prompt as the model got it, every tool's parameters, every message, and a raw JSON view. Costs per category are estimated and scaled to the measured total, and the panel says which is which |

## Usage

### Install

```bash
pi install ./rl-pi-extensions
```

Or from git:

```bash
pi install git:github.com/rlazoti/rl-pi-extensions
```

### Manage Extensions

Run `/rl-extensions` in Pi to open the TUI manager where you can:
- Navigate with ↑↓
- Toggle extensions with Space
- Apply changes with Enter
- Cancel with Esc

**Changes take effect after `/reload`.** Extensions are enabled/disabled via symlinks in `~/.pi/agent/extensions/`. Only symlinked extensions appear in Pi's `[Extensions]` list. If an existing standalone `ask` directory occupies the link path, see `extensions/ask/README.md` for the reversible cutover; the manager will not replace it.

**Broken links** (e.g. after the repo was moved or renamed) show as `✕` in the picker; enabling them re-creates the symlink pointing at this checkout. Symlink targets are always derived from this package's location, so they can't drift into the directory Pi was started from.

### Manual Config

Extensions are managed via symlinks in `~/.pi/agent/extensions/`:

```bash
# Enable an extension
ln -s /path/to/rl-pi-extensions/extensions/tmux-feedback ~/.pi/agent/extensions/tmux-feedback

# Disable an extension
rm ~/.pi/agent/extensions/tmux-feedback
```

## Development

```bash
npm install        # minisearch + typebox, then regenerates the Pi type mapping
npm test           # Node extension suite, then memory's isolated Vitest suite
npm run typecheck  # both TypeScript projects
npm run setup:memory   # memory's own test tools (vitest); npm test names this if it is missing
npm run verify:memory  # memory typecheck, tests, real-Pi smoke and race probes
```

Pi loads extensions with jiti, which strips types without checking them, so a
type error never reaches `npm test` — run both before committing. Test files
import extension sources through `test-support/` resolve hooks, which load the
real `.ts` files in bare `node --test`.

The three `@earendil-works/*` packages are declared as `*` optional peer
dependencies and installed by nobody — Pi provides them, and this checkout
installs no copy of Pi at any version. Nothing here may name a Pi version: Pi
installs a git checkout with dev dependencies omitted and peers disabled, but
pnpm still resolves `devDependencies`, so a pinned copy became a request to the
registry for `@earendil-works/pi-ai@1.5.1` on every install — which fails on a
lagging mirror even though the extension would never have loaded that copy.

Types and tests read the *live Pi install* instead, the code the extensions
actually run: `npm run gen:ts-paths` writes `.pi/tsconfig.pi-types.json` (an
absolute `paths` map generated from that release's `.d.ts` files and its `exports`
maps, with Pi's own rule that the `pi-ai` root means `dist/compat`), and
`test-support/hooks.mjs` maps the same specifiers at runtime, choosing the release
the way Pi does (`~/.pi/agent/install/current-version`). `tests/test-harness.test.ts`
fails if the two halves ever disagree.

## Architecture

```
rl-pi-extensions/
├── package.json                    # Only lists rl-extensions (manager)
├── tsconfig.json                   # `npm run typecheck` gate (no emit)
├── test-support/                   # Resolve hooks: bare node loads .ts sources
├── extensions/
│   ├── symlink-manager.ts          # Symlink management logic
│   ├── panel.ts                    # Shared picker panel layout
│   ├── tmux-feedback/
│   │   ├── index.ts                # Extension entry point
│   │   └── implementation.ts       # Real extension code
│   ├── session-banner/
│   │   ├── index.ts                # Extension entry point
│   │   ├── implementation.ts       # Real extension code
│   │   ├── helpers.ts              # Emoji/title/world-context helpers
│   │   └── panes.ts                # Rich-editor pane registry (copied per extension)
│   ├── session-attention/
│   │   ├── index.ts                # Extension entry point
│   │   └── implementation.ts       # Real extension code
│   ├── snippets/
│   │   ├── index.ts                # Extension entry point
│   │   └── ...                     # Multiple implementation files
│   ├── emacs-feedback/
│   │   ├── index.ts                # Extension entry point
│   │   ├── implementation.ts       # Real extension code (Pi side)
│   │   └── emacs/
│   │       ├── pi-feedback.el      # Emacs client (source-region feedback)
│   │       └── pi-feedback-test.el # Emacs ERT tests
│   ├── memory/
│   │   ├── index.ts                # Extension entry point
│   │   └── ...                     # Markdown bank, search, injection, safety and recovery
│   ├── co-authored-by-ai/
│   │   ├── index.ts                # Extension entry point
│   │   └── implementation.ts       # tool_call hook + the shell-aware patching
│   └── rl-extensions/
│       ├── index.ts                # TUI extension manager
│       └── picker.ts               # Picker overlay
└── tests/                          # Manager, picker, panel, symlink-manager, loading
```

**Only `rl-extensions` is listed in `package.json`.** The manager creates symlinks in `~/.pi/agent/extensions/` which Pi discovers automatically. Disabled extensions are never loaded by Pi.
