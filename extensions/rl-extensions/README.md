# rl-extensions

TUI manager for enabling/disabling rl-pi-extensions.

## What it does

Provides a framed picker to browse and toggle extensions on/off. Extensions are managed via symlinks in `~/.pi/agent/extensions/`. Changes take effect after `/reload`.

## Usage

Run `/rl-extensions` to open the extension picker.

### Picker Controls

The picker uses a centered framed panel with a search bar, extension list, and status footer:

- `↑` / `↓`: navigate through extensions
- `Space`: toggle the selected extension
- `/`: focus search; search matches name and description
- `Enter`: apply changes and close
- `Escape`: cancel without saving

### Visual Feedback

- `●` = enabled, `○` = disabled
- `›` highlights the currently selected item
- Status footer shows `X/Y enabled` count
- State updates immediately after toggle

## Enable/Disable

Extensions are enabled/disabled via symlinks in `~/.pi/agent/extensions/`. The picker manages these automatically.

## License

[MIT](../../LICENSE)
