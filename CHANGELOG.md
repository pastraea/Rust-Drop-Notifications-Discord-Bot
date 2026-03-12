# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog principles and this project uses Semantic Versioning.

## [Unreleased]

- No changes yet.

## [0.1.3] - 2026-03-12

### Added

- `/alerts` now supports targeting either users or roles via `for:<@user|@role>`, while defaulting to the requesting user when omitted.
- Role-based alert preferences are now persisted and included in timed alerts, live drop alerts, and `/checkdrops` mention resolution.

### Changed

- Alert notification dedupe now uses a unified alert-target model so user and role mentions are tracked consistently across reminder types.
- `/alerts` help/confirmation messaging now reflects the updated `type` + `for` command syntax.

### Fixed

- CI workflow YAML formatting was corrected so the workflow parses cleanly without compact-mapping syntax errors.

## [0.1.2] - 2026-03-12

### Fixed

- `/gifs list` no longer falls over with larger custom GIF collections; preview uploads are capped and now gracefully fall back to text output when attachment upload limits are hit.

### Changed

- Removed duplicate closing-phrase slash command registration so only `/closingphrase` is published.
- Removed `REMINDER_CHANNEL_ID` runtime/env fallback behavior; reminder channel is now DB-backed via `/setchannel` only.
- Updated `.env.example` and README environment docs to match current runtime configuration.

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
