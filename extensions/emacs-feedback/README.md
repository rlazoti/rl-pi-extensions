# emacs-feedback

Source-region and Magit diff-line feedback from [Emacs](https://www.gnu.org/software/emacs/) for terminal Pi sessions.

Review Pi-authored source changes in Emacs, attach notes to selected source regions or Magit diff lines, send them to the matching Pi session, and ask Pi to address them.

## Requirements

- [Pi](https://github.com/earendil-works/pi-coding-agent) coding agent
- [Emacs](https://www.gnu.org/software/emacs/) 27.1 or newer

## Install

This extension is part of the [rl-pi-extensions](..) monorepo. Install the whole package:

```bash
pi install ./rl-pi-extensions
```

Load the Emacs client (included in this package):

```elisp
(add-to-list 'load-path "/path/to/rl-pi-extensions/extensions/emacs-feedback/emacs")
(require 'pi-feedback)
```

## Enable/Disable

Run `/rl-extensions` to toggle this extension on/off. Changes apply after `/reload`.

## Workflow

1. **Start** a terminal Pi session in the project you want Pi to change.
2. **Ask Pi** to make code changes.
3. **Review** the changes in Emacs (source buffers, Magit status/diff, or commit diffs).
4. **Select** a source region or exact diff lines to comment on.
5. **Run** `M-x pi-feedback-add` and enter your feedback note.
6. **Repeat** for all review notes.
7. **Send** with `M-x pi-feedback-send` to append a bundle to the matching Pi session inbox.
8. **Inspect** with `/emacs-feedback-list` in Pi.
9. **Address** with `/emacs-feedback-address` to ask Pi to fix the feedback.

## Commands

| Command | Description |
|---|---|
| `/emacs-feedback-address` | Send queued inbox feedback to the assistant, then archive and clear |
| `/emacs-feedback-list` | Show queued inbox feedback and any malformed inbox lines |
| `/emacs-feedback-clear` | Discard queued inbox feedback (with confirmation) |
| `/emacs-feedback-help` | Show setup, workflow, storage paths, and caveats |

## Storage

Uses local filesystem storage under `~/.pi/emacs-feedback/`:

```
~/.pi/emacs-feedback/
├── sessions/    # Live Pi session descriptors
├── inbox/       # Per-session JSONL inboxes (Emacs appends feedback)
└── archive/     # Bundles archived after /emacs-feedback-address
```

## Session Matching

Pi and Emacs match sessions by normalized project context:
- Pi records `projectRoot` (from `git rev-parse --show-toplevel`) and `cwd`
- Emacs uses `project-current` to find the project root
- A match occurs when `projectRoot` equals the Emacs project root, or `cwd` is inside it
- Stale descriptors (dead PID) are skipped automatically

## Caveats

- **Manual address**: Emacs does not auto-trigger Pi assistant turns. You must run `/emacs-feedback-address` manually.
- **Source regions only**: Works from real file-backed buffers. Scratch buffers and shell buffers are unsupported.
- **Diff line selection**: Magit/diff support requires selecting exact diff lines inside a single hunk — no whole-hunk fallback.
- **No commit hash feedback**: Open the commit and select changed diff lines instead.
- **Local filesystem only**: No cross-machine synchronization.
- **Terminal sessions only**: No `pi-mono-ide` integration.

## License

[MIT](../../LICENSE)
