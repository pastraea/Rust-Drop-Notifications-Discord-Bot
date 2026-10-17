# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog principles and this project uses Semantic Versioning.

## [Unreleased]

- No changes yet.

## [0.1.4] - 2026-10-17

### Added

- Regression tests for Twitch campaign dates and official participating-channel parsing.
- Integration tests covering campaign HTML through SQLite persistence and mocked Discord sends, including schema migration, channel refresh, and live-alert dedupe.

### Changed

- Twitch now uses the official Facepunch campaign page as the primary source for dates and participation, with an optional Twitch API fallback.
- Announcements distinguish general drops from streamer-specific drops and label participation as listed, without claiming a channel is currently live.
- `/checkdrops` includes published upcoming campaigns beyond 24 hours; the default mode includes listed participation, while `mode:full` also includes unknown participation.
- General-drop availability is persisted separately from named channels through an automatic additive database migration.
- Updated command option labels and documentation to explain participation sources and manual-check behavior.

### Fixed

- Upcoming Facepunch countdowns no longer use the campaign start date as the end date or mark the campaign active from the Unix epoch.
- Twitch campaigns no longer receive unrelated live Rust channels inferred from directory results or stream titles.
- Campaign participants remain isolated per campaign and refresh on each successful sync.
- General-only campaigns are no longer hidden by the default manual-check filter.
- Upcoming campaigns remain visible in snapshots when another campaign on the same platform is active.
- Missing or invalid Twitch dates no longer produce fabricated timestamps; if both official sources fail, the sync fails explicitly and preserves stored campaigns.

### Upgrade Notes

- Restart the bot after deploying and re-run `npm run deploy-commands` to refresh command option labels.
- Existing databases migrate automatically; a successful sync replaces stale Facepunch campaign timing and participation data.
- Scheduled 24h/12h/1h alert windows are unchanged. Existing Discord messages are not rewritten.

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
