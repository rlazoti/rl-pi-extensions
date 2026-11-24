# command-watchdog

Agent-issued Bash calls with no explicit timeout get **300 seconds**. In a UI session, a Bash call still pending after **60 seconds** gets one warning with a short command preview, provided its deadline is later than the warning. Pi's native Bash tool applies the deadline to the command and returns its timeout error and captured output. The extension does not abort the turn, retry the command, or undo its side effects.

Enable it in `/rl-extensions` and reload Pi. It is off until enabled. Pi 1.6.0 is the verified host.

| Environment variable | Default | Purpose |
|---|---:|---|
| `PI_COMMAND_WATCHDOG_TIMEOUT` | 300 | Default timeout, in seconds |
| `PI_COMMAND_WATCHDOG_WARN_AFTER` | 60 | Time before the warning, in seconds |

Optional overrides are read when the extension loads. Values must be finite numbers from 0.001 through 2147483.647 seconds; invalid values fall back to the defaults. Use a longer explicit Bash `timeout` for a known long build or test suite. For services meant to outlive a call, use their documented detached mode and stop command.

The warning clock starts in tool preflight, so a slow permission prompt or parallel batch can make a call appear pending before its subprocess starts. Output does not reset the deadline. Nested agent Bash calls get the same policy; human `!` / `!!` commands, other tools, and headless warnings are out of scope. Warnings are shown through Pi's UI, not written to a watchdog log. The watchdog relies on the Bash backend honoring its timeout; it does not supervise detached processes or detect a frozen Pi process.

The initial threshold was checked against 7,155 matched Bash calls in 60 recent saved sessions: four calls without an explicit deadline crossed five minutes (two aborts, two successes). Transcript gaps are approximations, especially for parallel tools. The motivating case was an accidental foreground server that held the session for nearly two hours.
