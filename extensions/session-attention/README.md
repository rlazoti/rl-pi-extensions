# session-attention

Desktop notifications when Pi needs your attention.

## What it does

Sends a desktop notification when:
- The agent finishes a turn and is waiting for your input
- Pi calls the `ask` tool (shows the question)
- A `session-attention:waiting` event is emitted

Clicking the notification returns you to the Pi session (macOS only).

## Commands

### `/attention-test`

Send a test notification to verify the extension is working.

### `/attention-status`

Show whether session-attention is active or why it's inactive.

## Configuration

| Env var | Default | Notes |
|---------|---------|-------|
| `PI_SESSION_ATTENTION_DISABLE` | `0` | Set to `1` to disable notifications |

## Requirements

- **macOS** — uses `terminal-notifier` or `osascript` for desktop notifications
- **Terminal focus** — clicking the notification focuses the terminal that launched
  Pi, read from `__CFBundleIdentifier` (Ghostty, Terminal, iTerm2, …). iTerm2 is
  assumed only when that variable is absent, so a non-iTerm user is never shown
  an unrelated app
- **tmux** — when Pi runs inside tmux, the notification also selects the window
  and pane holding Pi; outside tmux it just focuses the terminal

## Enable/Disable

This extension is part of the [rl-pi-extensions](..) monorepo. Run `/rl-extensions` to toggle it on/off. Changes apply after `/reload`.
