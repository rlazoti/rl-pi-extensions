# rl-pi-extensions

Personal Pi coding agent extensions, managed as a single package with a TUI for enabling/disabling.

## Extensions

| Extension | Description |
|-----------|-------------|
| **tmux-feedback** | Inline feedback for tmux scrollback selection |

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

Changes take effect after `/reload`.

### Manual Config

Extensions are configured in `~/.pi/agent/rl-extensions.json`:

```json
{
  "enabled": {
    "tmux-feedback": true,
    "emacs-feedback": true,
    "snippets": true,
    "session-attention": true,
    "retitle": false
  }
}
```

## Structure

```
rl-pi-extensions/
├── package.json                    # Single package with all extensions
├── extensions/
│   ├── config-manager.ts           # Shared config loading
│   ├── tmux-feedback/
│   │   ├── index.ts                # Wrapper (checks config)
│   │   └── implementation.ts       # Real extension code
│   └── manager/
│       └── index.ts                # TUI extension manager
```

Each extension has a thin wrapper (`index.ts`) that checks the config and only loads the real implementation if enabled.
