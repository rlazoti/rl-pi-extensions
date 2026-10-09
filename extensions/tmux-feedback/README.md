# tmux-feedback

Inline feedback for [pi](https://github.com/earendil-works/pi-coding-agent) — select text in tmux scrollback and annotate it without leaving your terminal.

When pi generates a long answer, you can scroll up, highlight the exact passage you want to comment on, press **Y**, type your feedback, and send it all at once. No copy-pasting, no re-finding paragraphs.

## Requirements

- [pi](https://github.com/earendil-works/pi-coding-agent) coding agent
- [tmux](https://github.com/tmux/tmux) — pi must be running inside a tmux session

## Install

This extension is part of the [rl-pi-extensions](..) monorepo. Install the whole package:

```bash
pi install ./rl-pi-extensions
```

## Enable/Disable

Run `/rl-extensions` to toggle this extension on/off. Changes apply after `/reload`.

## Workflow

1. **Read** — pi generates a long answer. Scroll up in tmux copy-mode to review it.
2. **Select** — highlight the exact passage you want to give feedback on.
3. **Press `Y`** — the tmux binding copies your selection, exits copy-mode, clears any partial input, and runs `/feedback-capture`.
4. **Annotate** — an editor opens with the quoted text. Type your feedback and submit.
5. **Repeat** — go back to step 1 for more notes. Each one is queued.
6. **Manage (optional)** — run `/feedback-list` to select a queued note, edit its annotation, or remove it after confirmation.
7. **Send** — run `/feedback-send` to deliver all remaining queued notes to the assistant as a single message.

The status bar shows `tmux feedback N` while you have notes queued.

## Setup

Install the tmux keybinding (run once inside pi):

```
/feedback-install-tmux-binding
```

Or add the binding permanently to your `~/.tmux.conf`:

```tmux
# pi tmux feedback capture (select text in copy-mode, press Y)
bind-key -T copy-mode Y send-keys -X copy-selection-and-cancel \; send-keys C-c \; send-keys -l /feedback-capture \; send-keys Enter
bind-key -T copy-mode-vi Y send-keys -X copy-selection-and-cancel \; send-keys C-c \; send-keys -l /feedback-capture \; send-keys Enter
```

## Commands

| Command | Description |
|---|---|
| `/feedback-capture` | Read the latest tmux buffer and queue feedback for it |
| `/feedback-send` | Send all queued feedback to the assistant |
| `/feedback-list` | Select a queued note to edit its feedback or remove it |
| `/feedback-clear` | Discard all queued feedback (with confirmation) |
| `/feedback-install-tmux-binding` | Install the `Y` binding in the running tmux server |
| `/feedback-help` | Show workflow help and caveats |

## How it works

The extension bridges tmux copy-mode and pi's extension API:

- The tmux `Y` binding copies selected text to the tmux paste buffer, sends `Ctrl+C` to clear any partial pi input, then types `/feedback-capture` and presses Enter.
- `/feedback-capture` reads the tmux buffer via `tmux show-buffer`, opens pi's built-in editor with the quoted text, and queues your feedback note.
- Feedback state is persisted in the pi session as custom entries. It survives restarts, session switches, and tree navigation.
- `/feedback-send` bundles all queued notes into one user message with quoted selections and your annotations. If the assistant is currently streaming, notes are delivered as a follow-up message.

## Caveats

- The `Y` binding targets the current tmux pane. Use it from the pane where pi is running.
- `Ctrl+C` clearing is intentional — it prevents `/feedback-capture` from appending to partially typed input. If the assistant is actively streaming, `Ctrl+C` will interrupt it. This workflow is meant for reviewing **completed** answers.
- The extension requires pi's interactive mode (TUI). It does not work in print mode (`-p`).

## License

[MIT](../../LICENSE)
