# rl-extensions

TUI manager for enabling/disabling rl-pi-extensions.

## What it does

Provides a framed picker to browse and toggle extensions on/off. Changes are tracked in-memory and only applied when you press Enter. Extensions are managed via symlinks in `~/.pi/agent/extensions/`. Changes take effect after `/reload`.

## Usage

Run `/rl-extensions` to open the extension picker.

### Picker Controls

The picker uses a centered framed panel with a search bar, extension list, and status footer:

- `↑` / `↓`: navigate through extensions
- `Space`: toggle the selected extension (visual only)
- `/`: focus search; search matches name and description
- `Enter`: apply all pending changes and close
- `Escape`: from the search box, leave it — the filter stays active and the query
  stays rendered; from the list, cancel without saving (discards all pending changes)

### Visual Feedback

- `●` = enabled, `○` = disabled, `✕` = broken symlink (target missing — Pi cannot load it)
- `›` highlights the currently selected item
- Status footer shows `X/Y enabled` count, plus `• N broken` when any symlink is broken
- Toggled state shows immediately; symlinks only update on Enter

### Broken Links

A symlink whose target no longer exists (e.g. the repo was moved) shows as `✕ broken`. Selecting it with Space marks it for repair; Enter re-creates the symlink pointing at this checkout. Enabling always validates the target exists, so the picker never creates a broken link.

## Enable/Disable

Extensions are enabled/disabled via symlinks in `~/.pi/agent/extensions/`. The picker manages these automatically. Symlink targets are derived from the location of this package (never from the directory Pi was started in), so links always point at the checkout they were created from.

## License

[MIT](../../LICENSE)
