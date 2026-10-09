# snippets

Insert snippets into the current draft.

## What it does

Provides a picker to browse and insert snippets from `~/.pi/agent/snippets/`. Snippets are Markdown files with frontmatter metadata.

## Usage

### Command

Run `/snippets` to open the snippet picker.

### Keyboard Shortcut

`Alt+Shift+S` opens the snippet picker directly.

### Terminal Compatibility

This extension uses **`Alt+Shift+S`** as a keyboard shortcut. Some terminal configurations cannot distinguish this combination reliably from other keypresses, so the shortcut may not work as expected.

If the shortcut doesn't work, check the following:

* **iTerm2 (macOS):** In *Settings → Profiles → Keys → General*, configure the Option key you use as **Esc+** rather than Meta, and enable CSI-u keyboard reporting if available.

* **tmux:** Use tmux 3.5 or newer and enable extended keyboard support in `~/.tmux.conf`:

  ```tmux
  set -s extended-keys on
  set -s extended-keys-format csi-u
  ```

  Ensure your terminal supports enhanced keyboard reporting and tmux forwards it correctly. You may also need to enable the `extkeys` terminal feature for your terminal type.

* **Other terminals:** Use a terminal that supports reporting modified keys distinctly, such as [Kitty's CSI-u protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) or xterm's [`modifyOtherKeys`](https://invisible-island.net/xterm/modified-keys.html) mechanism.

If you're using tmux, configure both the terminal emulator and tmux. Enabling extended keys in tmux alone may not be sufficient.

## Snippet Format

Create Markdown files directly in the global directory:

```text
~/.pi/agent/snippets/
```

Nested directories, symlinks, and non-`.md` files are ignored. The extension only reads this directory; there is no file-writing UI. Files are reloaded when a new picker opens, while an already-open picker keeps its original snapshot.

A file may have YAML frontmatter with string `name` and `description` fields. The filename without `.md` is the fallback name.

```markdown
---
name: Review changes
description: Review a change with a chosen focus
---

Review these changes for {{focus:correctness}}.
Pay special attention to {{area}}.
```

Frontmatter delimiter lines must be exactly `---`. The body starts immediately after the closing delimiter line ending. Blank separator lines, leading indentation, trailing spaces, and final newlines after that point are all part of the inserted body. Files without frontmatter preserve the same normalized body semantics. An empty or whitespace-only body is invalid.

### Placeholders

Snippets can include placeholders that get replaced with context:

- `{{name}}` starts with an empty value.
- `{{name:default}}` starts with `default`; only the first colon separates the name.
- Names match `[A-Za-z_][A-Za-z0-9_-]*`.
- `\{{name:default}}` inserts the literal `{{name:default}}` and removes the escape backslash.
- Defaults and entered values may be blank or multiline.
- Repeated names share one value within a snippet. The same name in different snippets remains independent.
- Repeated explicit defaults must match. Conflicting defaults make that file invalid.
- Values are substituted once and are never parsed recursively.
- Placeholders cannot nest. The first `}}` closes a placeholder, so a default cannot contain that delimiter.

Unsafe terminal control characters are rejected. Line endings are normalized while files load.

## Configuration

Snippets are loaded from `~/.pi/agent/snippets/`. Create this directory and add `.md` files with frontmatter.

## Picker controls

The browse and placeholder screens use a centered, framed, padded panel colored by the active Pi theme. The panel targets 80% of the terminal width and at most 70% of its height. On terminals too narrow or short for the frame, the usable controls remain in a compact layout.

- `↑` / `↓`: move through snippets or scroll a focused preview
- `Space`: toggle the focused snippet
- `/`: focus search; search matches name, description, and filename
- `Tab` / `Shift+Tab`: move between search, list, preview, fields, Back, and Insert
- `Enter`: continue with the focused snippet, choose Back, or Insert
- `Escape`: leave search/preview, return from fields to selection, or cancel
- `PageUp` / `PageDown`: scroll a focused preview
- `Shift+Enter` or `Ctrl+J`: add a newline in a placeholder field

Selections are inserted in selection order, joined by exactly one blank line (`\n\n`) with no outer padding. Search preserves hidden selections. Going Back preserves selections and entered field values.

The status widget is temporary: it shows the exact **Alt+Shift+S** hint and selected count only while the picker is open. No active-snippet list is persisted.

## Enable/Disable

This extension is part of the [rl-pi-extensions](..) monorepo. Run `/rl-extensions` to toggle it on/off. Changes apply after `/reload`.
