# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **rl-extensions**: toggling an extension off and on again inside the picker was a no-op — the Space handler computed the new state from the disk alone (which only changes on apply), so the marker never returned to ● and Enter would disable an extension the user had just re-selected. The toggle now flips the effective state (pending ?? disk)
- **emacs-feedback**: `/emacs-feedback-address` can no longer re-send the same notes after a crash (bundles are archived before sending and skipped when already archived; a failed send rolls the archive back so the next run retries). A non-string `location`/`hunkHeader` in a feedback note is now rejected by validation

### Changed

- **pickers**: shared panel layout extracted to `extensions/panel.ts` (both pickers were carrying ~40 duplicated lines); the extension picker's status line is pending-aware and shows unapplied toggles; search keystrokes clamp the selection instead of resetting it; `Theme` now comes from pi-coding-agent (pi-tui doesn't export it)
- **snippets**: the extension entry point types its API as `ExtensionAPI` instead of `any`
- **session-banner**: imports standardized on `@earendil-works/*`; comments corrected against the pinned Pi 1.1.0 (it emits no `session_switch`/`session_fork`/`session_branch` — those handlers are OMP compatibility; `session_shutdown` reasons are quit/reload/new/resume/fork); README documents that the title color is intentionally not persisted

### Added

- **tests**: 22 new tests across the M batch (picker status/search/panel guards, import-scope + typing guards, emacs archive/dedupe/rollback behavior, note validation)

## [1.0.0] - 2025-07-11

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

## [1.1.0] - 2026-07-18

### Added

- **emacs-feedback**: Source-region and Magit diff-line feedback from Emacs — review Pi-authored changes in Emacs, attach notes, send to Pi, and ask it to address them
- Visual **Done** button in extension picker (reachable with Tab)
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
