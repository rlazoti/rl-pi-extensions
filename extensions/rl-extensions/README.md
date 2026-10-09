# rl-extensions

TUI manager for enabling/disabling rl-pi-extensions.

## Usage

Run `/rl-extensions` in Pi to open the extension manager.

### Navigation

| Key | Action |
|---|---|
| ↑ / ↓ | Navigate extensions |
| Space | Toggle the selected extension |
| Enter (on Done) | Apply changes and close |
| Esc | Cancel without saving |

### Visual Feedback

- `●` = enabled, `○` = disabled
- `▶` highlights the currently selected item
- State updates immediately after toggle

## Config

Extensions are configured in `~/.pi/agent/rl-extensions.json`:

```json
{
  "enabled": {
    "tmux-feedback": true
  }
}
```

Unconfigured extensions are enabled by default.

## License

[MIT](../../LICENSE)
