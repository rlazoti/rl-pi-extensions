# rl-pi-extensions

Personal Pi coding agent extensions, managed as a single package with a TUI for enabling/disabling.

## Extensions

| Extension | Description |
|-----------|-------------|
| **tmux-feedback** | Inline feedback for tmux scrollback selection |
| **session-banner** | Colored banner + auto-naming for Pi sessions |

More extensions coming soon (emacs-feedback, snippets, etc.).

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

### Manual Config

Extensions are managed via symlinks in `~/.pi/agent/extensions/`:

```bash
# Enable an extension
ln -s /path/to/rl-pi-extensions/extensions/tmux-feedback ~/.pi/agent/extensions/tmux-feedback

# Disable an extension
rm ~/.pi/agent/extensions/tmux-feedback
```

## Architecture

```
rl-pi-extensions/
├── package.json                    # Only lists rl-extensions (manager)
├── extensions/
│   ├── symlink-manager.ts          # Symlink management logic
│   ├── tmux-feedback/
│   │   ├── index.ts                # Extension entry point
│   │   └── implementation.ts       # Real extension code
│   ├── session-banner/
│   │   ├── index.ts                # Extension entry point
│   │   └── implementation.ts       # Real extension code
│   └── rl-extensions/
│       └── index.ts                # TUI extension manager
```

**Only `rl-extensions` is listed in `package.json`.** The manager creates symlinks in `~/.pi/agent/extensions/` which Pi discovers automatically. Disabled extensions are never loaded by Pi.
