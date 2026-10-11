# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **emacs-feedback**: queued feedback was orphaned when switching away from a session and back — every activation minted a random descriptor id (new inbox), so notes left in the old inbox were unreachable. Descriptors are now keyed by the stable Pi session id, so switch/resume/reload re-attaches to the same inbox until notes are addressed or cleared

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
