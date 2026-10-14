# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **rl-extensions picker**: a search that matched nothing rendered the full unfiltered list *plus* "No matching extensions" — the fallback reused the unfiltered list, so Space toggled a row the user could not see as filtered and Enter applied it. An empty result now renders no rows
- **rl-extensions picker**: the visible list could exceed the panel height, pushing the selected row (and its state marker) off-screen with no way to scroll back — the row budget is now derived from the terminal height, clamped to the visible window and scrollable
- **rl-extensions picker**: Esc in the search box cleared the visible query while the filter stayed applied, so the list looked truncated and the cursor sat on an off-screen row. Esc now clears the filter too
- **rl-extensions**: extension paths were derived from `process.cwd()`, so opening the picker from any other project produced paths that `enableExtension` turned into symlinks pointing nowhere — and the picker listed every extension as broken. Paths now come from the module's own location
- **session-banner**: `complete()` was imported from the pi-ai package root. In Pi that specifier is served by the compat entrypoint, but pi-ai exports no such name at its root — under plain ESM the extension fails to load outright, and `generateName()` would otherwise have swallowed the error and left auto-naming silently dead. It now imports `@earendil-works/pi-ai/compat`, which resolves identically in Pi, in tests and under `tsc`
- **session-attention**: clicking a notification activated `com.googlecode.iterm2` in both activation paths, bringing an unrelated (often not even running) app forward for Ghostty, Terminal.app, herdr and cmux users. The terminal bundle id is now read from `__CFBundleIdentifier`, with iTerm2 kept as the fallback for a bare TTY
- **session-attention**: `/attention-status` reported an *active* status in print mode because it tested `mode !== "headless"` — a value Pi never emits (`ExtensionMode` is tui/rpc/json/print)

### Added

- **tests**: `npm run typecheck` — a strict `tsc --noEmit` gate over `extensions/` and `tests/`. Pi loads extensions through jiti, which strips types without checking them, so nothing in this repo had ever been type-checked; the gate found 31 errors, including the two broken imports above
- **tests**: 16 behavioral picker tests driving the real `PickerComponent` through a keyboard/theme harness (search focus, Esc, row budgets, selection clamping, apply-result seam)
- **tests**: 12 real-filesystem `symlink-manager` tests (temp dirs, no fakes) plus `getExtensionsDir()` absolute-path pins for the cwd bug
- **tests**: session-attention activation tests (bundle id from env, iTerm fallback, sanitization of a value that is interpolated into a shell command)
- **tests**: a pin that session-banner imports `complete()` from a pi-ai specifier that actually exports it

### Changed

- **session-banner**: the `execFile` and `fs` test seams are typed as the narrow shapes the extension actually uses instead of whole node modules, so their test fakes are structurally honest
- **session-banner / tmux-feedback**: `session_switch`, `session_fork` and `session_branch` registrations go through one documented cast (Pi 1.2.0 does not emit them; they are OMP-only events) instead of an ad-hoc cast at each site
- **docs**: the CHANGELOG sections were out of order (1.0.0 before 1.1.0) and dated 2025-07-11 / 2026-07-18; both releases actually landed on 2026-10-10, and 1.1.0 was never tagged

## [1.2.0] - 2026-10-12

### Fixed

- **docs**: rl-extensions README no longer documents a "Done button" (Tab) that never shipped, and the 1.1.0 entry below was corrected; a guard test keeps the README from claiming picker controls that don't exist
- **emacs-feedback**: queued feedback was orphaned when switching away from a session and back — every activation minted a random descriptor id (new inbox), so notes left in the old inbox were unreachable. Descriptors are now keyed by the stable Pi session id, so switch/resume/reload re-attaches to the same inbox until notes are addressed or cleared
- **symlink-manager**: EEXIST crash when enabling an extension whose symlink was broken — the guard now uses `lstatSync` and repairs (re-points) broken or stale symlinks instead of no-oping or throwing
- **rl-extensions picker**: extension paths were derived from `process.cwd()` (the user's project), so enabling an extension from another directory created instantly-broken symlinks — paths now come from the package's own location
- **symlink-manager**: `enableExtension` validates the target directory exists before creating a link, so the picker can no longer create broken symlinks
- **symlink-manager**: broken symlinks are no longer reported as "enabled"; `isExtensionEnabled` now means loadable
- **symlink-manager**: `disableExtension` only removes symlinks; a real file/directory at the link path is never clobbered
- **rl-extensions**: toggling an extension off and on again inside the picker was a no-op — the Space handler computed the new state from the disk alone (which only changes on apply), so the marker never returned to ● and Enter would disable an extension the user had just re-selected. The toggle now flips the effective state (pending ?? disk)
- **emacs-feedback**: `/emacs-feedback-address` can no longer re-send the same notes after a crash (bundles are archived before sending and skipped when already archived; a failed send rolls the archive back so the next run retries). A non-string `location`/`hunkHeader` in a feedback note is now rejected by validation

### Added

- **tests**: 74 new runnable tests — session-attention (process roles, ask-body formatting, truncation), snippets (display-safe, placeholders, frontmatter catalog helpers), tmux-feedback (branch state reconstruction, message formatting, all six command handlers via a fake Pi)
- **tests**: 124 more — the session-banner `helpers` (98: emoji/title parsing, world-context detection, auto-naming context + URL reduction, generated-name cleaning) and `panes` (26: RenderScheduler coalescing/animation via `mock.timers`, paneRegistry singleton/host/panes) vitest suites ported to `node:test`
- **tests**: 126 more — the session-banner `index` vitest suite (the full extension behavior: lifecycle hooks, rich-editor host handoff + banner pane, deferred title re-asserts, auto-naming incl. SKIP/back-off/stale-result drops, Herdr tab rename + ownership persistence, cmux workspace rename, `/title`) ported to `node:test` with `mock.timers`
- **tests**: null-gated test seams in session-banner `implementation.ts` (`setCompleteForTesting`, `setExecFileForTesting`, `setFsForTesting`) — Node 26's test runner has no ESM module mocking, so the LLM/CLI/fs dependencies are injectable instead; production behavior unchanged
- **tests**: `test-support/` resolve hooks that let bare `node --test` load extension sources — aliases `@earendil-works/*`/`@mariozechner/*` to the real packages from the local Pi install and remaps jiti-style `.js` relative imports to `.ts`
- **tests**: 22 new tests across the M batch (picker status/search/panel guards, import-scope + typing guards, emacs archive/dedupe/rollback behavior, note validation)

### Changed

- **tests**: `npm test` now discovers all `*.test.{ts,mjs}` recursively; the previous hardcoded file list is what let test suites go dead without failing. All three previously-dead session-banner vitest suites are now ported and run in every `npm test`
- **session-banner**: `RenderScheduler` constructor no longer uses a TypeScript parameter property (type stripping, used by the test runner, does not support them); behavior unchanged
- **session-banner**: `PI_SESSION_BANNER_PROVIDER` / `PI_SESSION_BANNER_MODEL` / `CMUX_WORKSPACE_ID` are read lazily at use instead of captured at module load — Pi's env never changes mid-run, so production behavior is identical; tests no longer need module re-imports to change them
- **tests**: the `test-support` hooks now mirror Pi's own extension loader for `pi-ai` — the package root resolves to the compat entrypoint (which exports the legacy `complete` API), not the core entry, matching `virtual-modules.js`
- **rl-extensions picker**: broken symlinks render as `✕` (warning) with a `• N broken` count in the status footer; Space on a broken entry marks it for repair
- **rl-extensions picker**: per-extension apply failures are reported to the user via error notifications instead of being silently skipped
- **tests**: `tests/symlink-manager.test.ts` rewritten as real behavioral tests against the module (temp-dir injected); covers broken-symlink repair, stale re-pointing, missing-target and occupied-path errors
- **pickers**: shared panel layout extracted to `extensions/panel.ts` (both pickers were carrying ~40 duplicated lines); the extension picker's status line is pending-aware and shows unapplied toggles; search keystrokes clamp the selection instead of resetting it; `Theme` now comes from pi-coding-agent (pi-tui doesn't export it)
- **snippets**: the extension entry point types its API as `ExtensionAPI` instead of `any`
- **session-banner**: imports standardized on `@earendil-works/*`; comments corrected against the pinned Pi 1.1.0 (it emits no `session_switch`/`session_fork`/`session_branch` — those handlers are OMP compatibility; `session_shutdown` reasons are quit/reload/new/resume/fork); README documents that the title color is intentionally not persisted

## [1.1.0] - 2026-10-10 (released by version bump, never tagged)

### Added

- **emacs-feedback**: Source-region and Magit diff-line feedback from Emacs — review Pi-authored changes in Emacs, attach notes, send to Pi, and ask it to address them
- Separator lines between search input, extension list, and status for better visual hierarchy

### Changed

- **rl-extensions picker**: Toggles are now tracked in-memory — Space shows visual feedback immediately, Enter applies all pending changes, Esc discards them

### Fixed

- **rl-extensions picker**: Esc now properly cancels — no symlink changes are applied until Enter is pressed
- **symlink-manager**: EEXIST crash when enabling an extension with a stale/broken symlink — now uses `rmSync` for robust cleanup and noops if the entry already exists
- **symlink-manager**: `isExtensionEnabled` now uses `lstatSync` to detect broken symlinks (was returning false for broken symlinks)
- **rl-extensions picker**: Crash from using `theme.bg("dim")` — "dim" is a style modifier, not a valid color

### Updated

- Clarified snippets description: "Insert predefined text snippets into the prompt"

## [1.0.0] - 2026-10-10

### Added

- **rl-extensions**: TUI picker for managing extensions with framed panel UI
- **session-attention**: Desktop notifications when Pi needs your attention
- **snippets**: Snippet insertion into current draft with picker UI
- Navigation with ↑↓, toggle with Space, search with /
- Symlink-based enable/disable management
- Comprehensive test suite (24 tests)
- CHANGELOG.md following Keep a Changelog format

### Fixed

- **rl-extensions picker**: Navigation and toggle not working when no search query is active. Picker now uses consistent visible list for display and navigation.
- **rl-extensions picker**: Focus routing for search input
- **rl-extensions picker**: Navigation using keybindings instead of raw key constants
- **rl-extensions picker**: Adopted framed picker UI from snippets extension
