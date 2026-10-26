# rl-pi-extensions

Personal Pi coding agent extensions, managed as a single package with a TUI for enabling/disabling.

## Extensions

| Extension | Description |
|-----------|-------------|
| **tmux-feedback** | Inline feedback for tmux scrollback selection |
| **session-banner** | Colored banner + auto-naming for Pi sessions |
| **session-attention** | Desktop notifications when Pi needs your attention |
| **snippets** | Insert predefined text snippets into the prompt |
| **emacs-feedback** | Source-region and Magit diff-line feedback from Emacs |
| **memory** | Entry-keyed knowledge store: one authority per claim per context, rival claims refused until you decide. Also injects the day's open work, and `memory_read` / `memory_list` reach every file in the bank. Spec in `extensions/memory/README.md` |
| **co-authored-by-ai** | Adds a `Co-authored-by: AI (Pi/<model>)` trailer to the commits Pi creates, by patching `git commit` before it runs |

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

**Changes take effect after `/reload`.** Extensions are enabled/disabled via symlinks in `~/.pi/agent/extensions/`. Only symlinked extensions appear in Pi's `[Extensions]` list.

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
npm install        # dev dependency only (typescript); Pi itself is not installed
npm test           # every *.test.ts / *.test.mjs under tests/ and extensions/
npm run typecheck  # tsc --noEmit over extensions/ and tests/ (strict)
```

Pi loads extensions with jiti, which strips types without checking them, so a
type error never reaches `npm test` — run both before committing. Test files
import extension sources through `test-support/` resolve hooks, which load the
real `.ts` files in bare `node --test`.

The three `@earendil-works/*` packages are pinned as devDependencies purely so
the type-check can resolve them. Tests resolve them from the *live Pi install*
(`~/.pi/agent/install/releases/<version>`), i.e. the code the extensions
actually run; `tests/test-harness.test.ts` fails if the pinned copy's version
drifts from that, so bump the pins whenever Pi upgrades.

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
│   │   └── ...                     # schema/resolver/gate/inject/rollover (see its README)
│   ├── co-authored-by-ai/
│   │   ├── index.ts                # Extension entry point
│   │   └── implementation.ts       # tool_call hook + the shell-aware patching
│   └── rl-extensions/
│       ├── index.ts                # TUI extension manager
│       └── picker.ts               # Picker overlay
└── tests/                          # Manager, picker, panel, symlink-manager, loading
```

**Only `rl-extensions` is listed in `package.json`.** The manager creates symlinks in `~/.pi/agent/extensions/` which Pi discovers automatically. Disabled extensions are never loaded by Pi.
