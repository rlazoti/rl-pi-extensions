# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [Unreleased]
