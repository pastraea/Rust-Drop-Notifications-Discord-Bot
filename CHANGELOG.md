# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog principles and this project uses Semantic Versioning.

## [Unreleased]

- No changes yet.

## [0.1.1] - 2026-03-12

### Fixed

- `/checkdrops` announcements now always include a GIF outcome: attachment when media fetch succeeds, or a mode-selected GIF link fallback when attachment cannot be sent.

### Added

- CI workflow for install, build, and test.
- Coverage reporting command and CI artifact upload.
- Expanded project documentation (README, architecture, runbook, testing, privacy).
- Governance docs: contributing, security, support, issue templates, and PR template.

### Changed

- Command naming polished for professional presentation while preserving legacy alias compatibility.
- Dependency security posture improved; production audit now reports zero known vulnerabilities.

## [0.1.0] - Initial Release

### Added

- Discord bot runtime, provider integrations, scheduler, and SQLite persistence.
- Reminder and alert preference workflows.
- Slash command deployment and interaction handling.
