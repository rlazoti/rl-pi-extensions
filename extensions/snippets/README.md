# snippets

Insert snippets into the current draft.

## What it does

Provides a picker to browse and insert snippets from `~/.pi/agent/snippets/`. Snippets are Markdown files with frontmatter metadata.

## Usage

### Command

Run `/snippets` to open the snippet picker.

### Keyboard Shortcut

`Alt+Shift+S` opens the snippet picker directly. If the shortcut doesn't work (tmux may intercept it), install the tmux binding:

## Snippet Format

Snippets are Markdown files in `~/.pi/agent/snippets/`:

```markdown
---
name: Example Snippet
description: A brief description
---

Your snippet content here.
```

### Placeholders

Snippets can include placeholders that get replaced with context:

- `{{cursor}}` — Current cursor position
- `{{selection}}` — Current text selection
- `{{cwd}}` — Current working directory

## Configuration

Snippets are loaded from `~/.pi/agent/snippets/`. Create this directory and add `.md` files with frontmatter.

### Install Tmux Binding

Run `/snippets-install-tmux-binding` to install the `Alt+Shift+S` shortcut in tmux copy-mode.

## Enable/Disable

This extension is part of the [rl-pi-extensions](..) monorepo. Run `/rl-extensions` to toggle it on/off. Changes apply after `/reload`.
