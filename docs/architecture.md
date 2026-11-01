# Architecture

## Goal

Track Rust drops from multiple providers, store campaign/user state, and send timely Discord announcements.

## Components

- Entry point: `src/index.ts`
- Configuration: `src/config.ts` (strict, side-effect-free validation used by the bot, command deployment, and installer checks)
- Graceful shutdown: `src/shutdown.ts`
- Scheduler: `src/scheduler.ts`
- Providers: `src/providers/twitch.ts`, `src/providers/kick.ts`
- Sync service: `src/services/dropService.ts`
- Reminder service: `src/services/reminderService.ts`
- Interaction handlers: `src/commands/handleInteraction.ts`
- Persistence: `src/db.ts`
- Schema migrations and pre-upgrade backups: `src/migrations.ts`
- Optional Windows launch-time updater: `src/installer/Invoke-Updater.ps1` and
  `src/installer/WindowsUpdate.psm1`, outside the bot runtime/scheduler.

## Windows Update Lifecycle

An explicit per-user opt-in permits one GitHub latest-stable-release check before
setup EXE or installed-bot startup. The setup EXE invokes the updater as a separate
PowerShell process and hands off to a verified cached newer EXE. The installed
launcher holds the duplicate-bot mutex, leaves the installation working directory,
waits for the separate updater, then starts the bot. No periodic worker, Windows
service, or new scheduled updater task is installed.

The updater validates the fixed repository's release asset URL, SHA-256 digest,
package identity/version, extraction paths, and archive bounds. Bot changes stage
dependencies/build/config checks first, then copy local state while the bot is
idle and move the prepared tree into place. The old tree is retained for recovery.
Activation failure restores the old tree; failed restoration blocks startup.
Installer/removal/update mutations share a maintenance mutex. User credentials
are never sent to GitHub, and updater checks do not use Discord credentials.

## Database Migrations

The schema version lives in SQLite's `user_version`. `BotDb` hands an ordered list of numbered
migrations to `runMigrations` (`src/migrations.ts`) on startup:

- Migration 1 is the original idempotent schema, so databases created before versioning
  (version 0) upgrade in place.
- Each migration runs in its own transaction together with its version bump, so a failure rolls
  back and leaves the database at its previous version.
- Before any pending migration on a database that already has tables, a consistent copy is written
  with `VACUUM INTO` to `data/backups/<db>.<UTC timestamp>.v<from>-to-v<to>.bak` and the newest
  three are kept. If the backup fails, nothing is migrated and the bot does not start.
- A database whose version is newer than the bot knows is refused (`SchemaVersionError`).
- New schema changes are appended as new numbered migrations; existing ones are never edited.

## Configuration Preservation

The installer treats `.env` as user-owned data. With **Preserve my existing .env**
on (the default), reinstalls copy the file byte-for-byte and the updater carries it
forward unchanged; the only permitted modification is appending commented-out lines
for options added by a newer release. Setup never re-parses or rewrites it. Turning
the option off is the single path that deletes an old `.env`, and it requires a
separate confirmation naming each file. The preference is stored with the update
settings (see Windows Update Lifecycle) and defaults to on when absent or unreadable.

## Runtime Flow

1. Validate configuration (exit with a secret-safe message on invalid values), then open the SQLite database and apply any pending schema migrations (backing the database up first).
2. Start Discord client.
3. On scheduler cycle:
   - fetch normalized drops from providers
   - reconcile active/upcoming/ended drop state in DB
   - compute due reminder windows and send notifications
4. On slash commands/components:
   - parse command
   - update per-user or global settings in DB
   - reply ephemerally or post channel update
5. On `SIGINT`/`SIGTERM` or a fatal error: stop scheduling, wait for a running cycle,
   destroy the Discord client, close the database (forced exit after 15 seconds).

## Design Decisions and Tradeoffs

- Twitch participation:
  - Facepunch is the primary authority for campaign dates, named streamer drops, and general drops.
  - General-drop availability is persisted separately from named channels.
  - Live directory results and stream titles are not evidence of campaign participation.
  - Twitch API campaigns are an optional fallback when the official page fails.
  - Manual checks include all published upcoming campaigns; scheduled alerts keep their timing windows.
- SQLite for persistence:
  - Pros: simple deployment, no external DB requirement, reliable local durability
  - Tradeoff: single-file DB requires careful filesystem and backup handling
- Provider fallback strategy:
  - Pros: bot remains useful during partial upstream outages
  - Tradeoff: fallback parsing can be less precise than first-party APIs
- Scheduled polling instead of event-driven source:
  - Pros: deterministic and easy to operate
  - Tradeoff: reminders are bounded by poll interval
- Rich command controls in Discord:
  - Pros: no separate admin panel required
  - Tradeoff: interaction handler complexity grows over time

## Extension Points

- Add provider implementations under `src/providers` using the shared provider interface.
- Add command workflows in `src/commands/handleInteraction.ts` and register schema in `src/commands/definitions.ts`.
- Add tests under `src/**/*.test.ts` for behavior changes.
