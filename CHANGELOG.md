# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog principles and this project uses Semantic Versioning.

## [Unreleased]

- No changes yet.

## [0.4.3] - 2026-11-01

### Security

- Development dependencies: `glob` and `minimatch` (used by `c8`) are pinned through npm `overrides` to patched releases, resolving the four moderate advisories noted in 0.4.1 without downgrading `c8`. `npm audit` now reports no vulnerabilities.
- Log output now masks the Discord token, the Twitch client secret, bearer tokens, Discord-token-shaped strings, and `client_secret`/`access_token` values.

### Added

- Leveled logging (`src/logger.ts`). All output goes through a scoped, timestamped logger instead of `console`. The new optional `LOG_LEVEL` setting accepts `debug`, `info` (default), `warn`, `error`, or `silent`, case-insensitive; invalid values stop the bot at startup with an explanation. The installer and launcher pass it through like the other settings.
- Twitch provider tests for malformed payloads, the Helix fallback, token caching, and log redaction (`src/providers/twitch.fallback.test.ts`).
- Tests for Tenor GIF resolution, caching, and download (`src/services/tenorMedia.test.ts`) and for the logger (`src/logger.test.ts`).

### Changed

- The Tenor GIF resolution and download code that was duplicated in the command handlers and the reminder service now lives in `src/services/tenorMedia.ts`. Commands still take the first GIF on the page so they answer quickly, and announcements still pick the largest variant of the page's own GIF.
- Announcement GIF lookups are now cached for 10 minutes, like command lookups. Previously the result for each Tenor link, including a failed lookup, was kept until the bot restarted, so a link that failed once was never retried and a changed page was never re-read.
- `@types/node` updated to 26.6.6.

### Upgrade Notes

- No database or Discord command changes. `LOG_LEVEL` is optional; existing configurations keep working and log at `info`.

## [0.4.2] - 2026-11-01

### Added

- Tests for the Kick provider (`src/providers/kick.test.ts`): API campaign normalization (ids, titles, channel de-duplication, explicit and time-derived statuses, ended campaigns dropped), wrapped API payload shapes, v2-to-v1 endpoint fallback, the Facepunch countdown fallback with channel discovery from the page and tiles (including URL-encoded hashes and caching), a failing tile not losing other channels, invalid and duplicate countdowns, and total failure reporting an error status.
- Database behavior tests (`src/db.test.ts`): alert defaults and toggles, auto-ping recomputation, per-type and per-drop notification dedupe, retention pruning and its one-day floor, campaign upsert/ending/active/upcoming queries, settings and GIF mode fallbacks, per-user custom GIF ownership, secret discovery, and watches.
- Tests for the shared retry helper (`src/providers/http.test.ts`) and Tenor URL helpers (`src/services/tenor.test.ts`).

### Changed

- The retrying fetch logic that was copy-pasted into the Twitch and Kick providers now lives in `src/providers/http.ts`. Behavior is unchanged: two attempts, network errors and 5xx responses are retried after a 250-500 ms jittered delay, and 4xx responses are returned immediately.
- The Tenor URL helpers that were duplicated in the command handlers and the reminder service now live in `src/services/tenor.ts`. Behavior is unchanged.

### Upgrade Notes

- No configuration, database, installer, or Discord command changes.

## [0.4.1] - 2026-11-01

### Security

- Updated the `undici` dependency used by `discord.js` from 6.29.0 or earlier to 6.29.1, resolving eight advisories rated up to high severity (WebSocket and EventSource denial of service, TLS validation bypass, and response splitting). This was a lockfile update only. Four moderate advisories remain in `c8`'s development-only dependencies (`glob`/`minimatch`); they do not ship with the bot and have no non-breaking fix.

### Added

- Versioned database schema migrations. The schema version is stored in SQLite's `user_version`, each migration runs in its own transaction, and the existing schema becomes migration 1, so every existing database upgrades without data loss.
- Automatic pre-upgrade database backups. Before any pending migration on an existing database, a consistent copy is written to `data/backups` (the newest three are kept). If the backup cannot be written, the database is left unchanged and the bot refuses to start with an explanation.
- Newer-database protection: a database written by a newer bot version is refused with a clear message instead of being misread.
- Release automation (`.github/workflows/release.yml`): pushing a `vX.Y.Z` tag runs lint, build, tests, the runtime dependency audit, and the Windows installer, packaging, and updater checks, then publishes the release with the single setup EXE and notes taken from this changelog. Nothing is published if any step fails.
- `npm run lint` using Biome (lint only, no reformatting), an `.editorconfig`, and a runtime dependency audit (`npm audit --omit=dev --audit-level=high`) in CI.

### Changed

- Fixed Windows installs and updates failing on computers without C++ build tools. npm ran `node-gyp rebuild` for `better-sqlite3` during `npm ci`, which fails without Visual Studio Build Tools and Python even though the package ships a prebuilt binary that the bot actually uses. Setup and the updater now run `npm ci --ignore-scripts` followed by `npm rebuild ffmpeg-static` (the only install step needed at runtime), and the new release workflow installs the same way. Verified in a clean folder: `better-sqlite3` loads from its prebuilt binary, ffmpeg downloads and runs, and the bot builds and starts.
- Fixed upgrading databases whose `users` table predates the alert columns: the `users(auto_ping)` index was created before the column it indexes was added, so such a database failed to open. The index is now created after the column additions. Found by testing the new migration path against an old-style schema; earlier releases have the same ordering problem.
- CI no longer runs twice for pull request branches: pushes are tested only on `main`, pull requests run on the PR, superseded PR runs are cancelled, and the workflow token is read-only.
- Dependabot now groups npm minor/patch updates and GitHub Actions updates into single pull requests.
- Uninstalling with data deletion also removes the bot's own automatic `bot.db.*.bak` backups in `data/backups`; other files in that folder are left alone.
- Startup output no longer includes the dotenv banner.
- `BotDb` closes the database file if opening it fails (a refused or failed migration), instead of leaving it locked.

### Removed

- Unused internal code: three unreferenced spelling-quiz sentence helpers and their constants, and an unused timed-alert label function.

### Upgrade Notes

- The first start after upgrading writes one backup of your existing database to `data/backups` and sets schema version 1. No action is needed.
- Downgrading to a bot version older than 0.4.1 after upgrading is safe for data because the schema is unchanged, but those versions do not know about `data/backups`.

## [0.4.0] - 2026-11-01

### Added

- **Preserve my existing .env** option (on by default) in the Install/Reinstall screen and under **More**. An existing `.env` is carried into reinstalls and updates byte-for-byte, so comments, ordering, quoting, and custom settings are never lost. New options from a release are appended only as commented-out lines.
- Explicit opt-out: with Preserve off, Install/Reinstall creates a new `.env` and deletes the old one with no recovery copy, after a separate confirmation that lists every file to be deleted.
- Graceful shutdown on `SIGINT`/`SIGTERM`, `unhandledRejection` and `uncaughtException`: the scheduler stops and finishes its running cycle, then the Discord client and database close (forced exit after 15 seconds).
- Tests for configuration validation, shutdown, and scheduler behavior.
- Release process documented in `VERSIONING.md`; contributor, pull request, and security docs updated to match current tooling (Node.js 22.12+, installer test commands, supported versions).

### Changed

- Configuration is validated strictly at startup. `CHECK_INTERVAL_MS` must be a whole number from 1000 to 86400000; a mistyped value such as `abc` previously made the scheduler fire continuously. `TWITCH_MOCK_DROPS`/`KICK_MOCK_DROPS` accept `true/false/1/0/yes/no/on/off`, and unrecognised values are now an error instead of silently meaning `false`. Blank values use the default.
- The Install screen's "Reuse configuration" checkbox is replaced by Preserve .env. Reinstall no longer re-parses and rewrites `.env`, so valid files that the old reader refused (quotes, `$`, duplicate keys) are now kept as they are.
- `scheduler.startScheduler` returns a handle with `stop()` instead of a raw timer.

### Upgrade Notes

- To change the token or IDs during a reinstall, turn Preserve off (the old `.env` is deleted with no backup) or edit the installed `.env` directly.
- A preserved `.env` must use the installer-managed database path `./data/bot.db`; setup explains and refuses anything else.
- Settings files from earlier versions default to Preserve on.

## [0.3.2] - 2026-11-01

### Changed

- Updated `dotenv` from 18.0.8 to 18.0.9.

## [0.3.1] - 2026-10-23

### Changed

- Updated `zod` from 4.6.6 to 4.6.7, `dotenv` from 18.0.7 to 18.0.8, and `@types/better-sqlite3` from 7.6.13 to 9.6.0.
- Aligned the package and documented Node.js minimum with the Windows installer's existing Node.js 22.12+ requirement.
- Updated CI to test Node.js 22 and 24 instead of Node.js 20 and 22.

### Upgrade Notes

- Use Node.js 22.12 or newer. Node.js 20 is not supported by the existing `better-sqlite3` 13 dependency and fails the SQLite integration tests.
- No Discord command, configuration, database-schema, or automatic-update preference changes are included.

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
