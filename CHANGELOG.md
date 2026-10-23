# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog principles and this project uses Semantic Versioning.

## [Unreleased]

- No changes yet.

## [0.3.0] - 2026-10-23

### Added

- Opt-in, launch-time automatic updates for the setup EXE and installer-managed bot, using the repository's latest stable GitHub release.
- Separate one-shot updater process with no periodic polling, additional startup task, or permanent Windows service.
- Independent installer checkbox and a More preference control, disabled by default, with the installation choice shown in final confirmation.
- Expected release-asset URL, size, and GitHub SHA-256 verification; stable-version comparison, private setup cache, and bounded download/API timeouts.
- Staged bot builds/configuration validation, preserved local configuration/database/shortcut ownership, private previous-installation backups, and restoration on activation failure.
- Shared install/removal/update maintenance locking, explicit update diagnostics, and matching-installation update disabling during uninstall.
- Isolated update tests and operational, architecture, privacy, and testing documentation.

### Changed

- Positioned the automatic-update preference first in More, above all diagnostic and advanced controls.

### Upgrade Notes

- Updates run only on subsequent setup EXE or installed-bot launches after opt-in, not while the bot stays running. Direct npm/development launches bypass updating.
- Executables remain unsigned. Updates trust the repository's release assets and digest over HTTPS, not a verified publisher signature.
- No automatic shared Node.js upgrade, Discord command deployment, or runtime/database-readiness rollback is performed. Previous-installation backups are retained for manual recovery.

## [0.2.3] - 2026-10-23

### Added

- Windows executable company metadata identifying studio bijou.
- Executable assembly/file/product versions generated from the package version, with regression checks for company and version metadata.

### Installation Notes

- The setup EXE remains unsigned. Company metadata is not a verified publisher identity or digital signature; Windows may display unknown-publisher or SmartScreen warnings.
- The repository's MIT licence and existing copyright attribution are unchanged.
- No bot runtime, dependency, or database-schema changes are included.

## [0.2.2] - 2026-10-18

### Changed

- Moved installer source into `src/installer` and updated launch commands, executable packaging, CI, and tests to use the new location.

### Added

- Single-file Windows setup executable that embeds the existing setup UI and bot source and opens without Node.js, npm, or a repository checkout.
- Windows-native build script and optional `npm run build:installer` command, with no additional compiler/package dependencies.
- Private temporary extraction, duplicate-setup prevention, explicit launch/cleanup errors, and cleanup after closing setup.
- Packaging tests covering embedded-file contents, private-data exclusion, a real UI launch without Node.js/npm on PATH, and temporary extraction cleanup.
- Windows CI executable build/testing and downloadable workflow artifact.

### Installation Notes

- The executable is unsigned and uses Windows PowerShell 5.1/.NET Framework included with normal Windows 10/11 installations. Run as administrator under the intended bot user for installation.
- Node.js/npm are still required to install and run the bot; downloading Node.js remains opt-in. No release asset is published automatically.

## [0.2.1] - 2026-10-18

### Changed

- Renamed installer headings, window titles, and newly created shortcuts to Rust Drop Notifications Discord Bot, retaining compatibility with existing startup identifiers and older shortcuts.
- Corrected the main actions to Check installation, Uninstall, and Install / Reinstall; Uninstall now opens removal options directly without a reinstall-choice prompt.
- Renamed the Windows setup window's "More options" section to "More".
- Moved scan status, the installation selector, and diagnostic reports inside the collapsed-by-default More section alongside advanced controls.
- The setup window now fits its visible content, showing only the heading, subtitle, three main actions, and More toggle when collapsed.

### Added

- Regression checks for the exact product name, button labels, direct uninstall routing, shortcut names/descriptions, and actual WPF visibility and expansion/collapse sizing.
- Checks that scan completion and cancellation leave More collapsed and that expanding it preserves scan results and installation selection.

### Upgrade Notes

- Existing startup task, launcher, installation-folder, and database identifiers are unchanged. Older installer-owned shortcuts remain supported by uninstallation; newly created shortcuts use the full product name.
- No bot runtime, Discord command, dependency, or database-schema changes are included in this patch.
- Expand More to review scan results, select an installation for uninstalling, or access diagnostic and advanced controls. Installation/removal confirmations remain separate from the hidden diagnostics.

## [0.2.0] - 2026-10-18

### Added

- Windows desktop setup window with read-only detection and confirmed uninstallation of the legacy RustDropsBot scheduled-task setup.
- Optional credential/database and old installation-folder removal with path protections, plus isolated uninstall safety tests.
- Simplified three-button Windows setup screen, automatic startup/common-folder discovery, and optional deep fixed-drive scanning with access warnings.
- Opt-in unsaved environment-file copies in a separate editable window, without modifying originals or creating temporary credential files.
- Windows install/reinstall options screen with destination, masked credentials, configuration/database reuse, logon startup, command registration, desktop/Start menu shortcuts, and opt-in Node.js LTS provisioning.
- Staged dependency installation/build before confirmed old-installation cleanup, private recovery data backups, and installer-owned shortcut cleanup.

### Installation Notes

- Launch the Windows 10/11 desktop setup with `npm run installer`. Installation requires administrator PowerShell under the intended bot user.
- Startup runs at the current user's sign-in, not before sign-in at machine boot.
- Node.js 22.12 or newer and npm are required for installation; downloading Node.js LTS through winget is opt-in.
- Review the fresh scan and explicit removal confirmation before reinstalling. The setup/source folder and unrelated applications are protected; unsupported startup entries and incomplete startup discovery block automatic removal.
- Old configuration and database backups are retained in a private recovery folder shown in the result. Verify the new installation before manually deleting these sensitive backups.
- This is a repository-launched Windows setup interface, not a packaged standalone executable. Real-machine installation and live Discord connectivity still require manual validation.

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
