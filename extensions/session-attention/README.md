# session-attention

Desktop notifications when Pi needs your attention.

## What it does

Sends a desktop notification when:
- The agent finishes a turn and is waiting for your input
- Pi calls the `ask` tool (shows the question)
- A `session-attention:waiting` event is emitted

Clicking the notification returns you to the Pi session (macOS only, requires iTerm2).

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
- **iTerm2** — clicking the notification returns to the Pi session (requires iTerm2 bundle ID)
- **tmux** — Pi must be running inside a tmux session for activation to work

## Enable/Disable

This extension is part of the [rl-pi-extensions](..) monorepo. Run `/rl-extensions` to toggle it on/off. Changes apply after `/reload`.
