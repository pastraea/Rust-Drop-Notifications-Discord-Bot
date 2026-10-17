# Rust Drops Notifications Bot

Discord bot that tracks Rust drops from Twitch and Kick providers, persists state in SQLite, and posts reminder snapshots to Discord.

## Features

- Scheduled drop polling and campaign reconciliation
- Discord slash commands for channel configuration, alert preferences, and GIF controls
- SQLite persistence for user preferences, campaign state, and notification dedupe
- Mock and live provider modes for local testing and production operation
- Official Facepunch Twitch participation lists, with general and streamer-specific drops shown separately

## Architecture Overview

High-level flow:

1. `src/index.ts` starts the Discord client and initializes dependencies.
2. `src/scheduler.ts` runs recurring cycles (`syncDrops` then reminder dispatch).
3. Providers in `src/providers/*.ts` fetch and normalize campaign data.
4. `src/services/dropService.ts` merges provider output and updates DB state.
5. `src/services/reminderService.ts` computes due alerts and posts announcements.
6. `src/commands/handleInteraction.ts` handles user commands and writes user-facing settings to DB.
7. `src/db.ts` is the persistence layer for settings, drops, dedupe, and user preferences.

See the design doc in [docs/architecture.md](docs/architecture.md).

## Command Reference

| Command | Inputs | Output | Typical Permission |
| --- | --- | --- | --- |
| `/setchannel` | `channel` | Sets reminder destination channel | Server admin/moderator |
| `/closingphrase` | `state` (`on`\|`off`) | Enables/disables closing phrase in announcements | Server admin/moderator |
| `/alerts enable` | `types` (optional) | Enables selected alert types for caller | Any member |
| `/alerts disable` | `types` (optional) | Disables selected alert types for caller | Any member |
| `/alerts status` | none | Shows caller alert configuration and provider source modes | Any member |
| `/gifs mode` | `mode` (`default`\|`custom`\|`both`) | Sets GIF source mode | Any member |
| `/gifs add` | `url` | Adds custom GIF URL for caller | Any member |
| `/gifs remove` | `id` | Removes custom GIF entry | Any member |
| `/gifs rename` | `id`, `name` | Renames custom GIF entry | Any member |
| `/gifs list` | `page` (optional) | Lists custom GIF entries | Any member |
| `/gifs status` | none | Shows mode and GIF list counts | Any member |
| `/checkdrops` | `mode` (optional) | Triggers immediate drop check and reminder output | Server admin/moderator |
| `/help` | none | Displays command help text | Any member |

Examples:

- `/alerts enable types:24h 1h checkdrops`
- `/checkdrops mode:full`
- `/gifs add url:https://tenor.com/view/example`

`/checkdrops` shows active and upcoming campaigns with listed participation, including
campaigns more than 24 hours away. General drops count as listed participation even
without named streamers. Use `mode:full` to also include campaigns whose participation
is not yet listed. Timed reminders retain their existing 24h/12h/1h windows.

For Twitch, "listed" means the provider lists participation, not that the channel is
currently live. General drops require a drops-enabled Rust stream; streamer drops
require the specific listed channels. The bot does not guess participants from live
Rust directory results or stream titles.

## Local Development

Prerequisites:

- Node.js 20+
- npm 10+

Setup:

1. Copy `.env.example` to `.env`.
2. Fill required values:
   - `DISCORD_TOKEN`
   - `DISCORD_CLIENT_ID` and `DISCORD_GUILD_ID` (for command deployment)
3. Install dependencies:
   ```powershell
   npm install
   ```
4. Register commands:
   ```powershell
   npm run deploy-commands
   ```
5. Run locally:
   ```powershell
   npm run dev
   ```

## Deployment

### Windows setup window

On Windows, open the desktop setup window from a repository checkout:

```powershell
npm run installer
```

Node.js is not required to launch the window directly:

```powershell
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\installer\Start-Installer.ps1
```

The window has three main buttons, left to right: **Check installation**,
**Uninstall / Reinstall**, and **Install**. Choose **Install** for setup options.
**Uninstall / Reinstall** asks whether to reinstall or uninstall only.
Use **Check installation** and select a discovered folder for uninstall-only.
Checking is read-only and runs in the background. Credentials are never included in
the scan report.
While scanning, the check button becomes **Cancel scan**.

Detection checks scheduled tasks, Windows services (including NSSM launcher settings),
machine and loaded-user Run/RunOnce registry entries, profile Startup folders and
shortcuts, running processes, and common installation folders. It also checks the
original `%ProgramData%\RustDropsBot\start-rust-bot.ps1` launcher, even without its task.
The common-folder scan searches four levels under profile, AppData, ProgramData,
and Program Files locations. **More options** provides a deep scan of all local fixed
drives and a specific-folder check.

The unchecked **Open a found .env as an unsaved text copy** option under
**More options** opens the selected discovered installation's `.env` in a separate
editable text window after scanning. You can also enable it after a scan or select
another discovered installation. Copies stay in memory: no temporary file is
created, and editing does not change the original. Copy any text you want to keep
before closing the window; closing discards it. These windows contain secret
credentials, so do not share screenshots or paste their contents into chat.
Missing or unreadable files are reported; linked credential paths are refused.

Access errors and skipped links/junctions are reported. Deep scans do not follow
links or search dependency folders, filesystem metadata, network drives, containers,
or unloaded users' registry hives. A clean result is not proof that every possible
custom installation was found.

**Uninstall / Reinstall** requires a confirmation and removes only the recognized startup task,
its matched process tree, launcher, and known launcher logs. Credentials and the
configured SQLite database (including WAL/SHM sidecars) are kept unless you select
their deletion. Other detected services/startup entries require manual cleanup before
removal; incomplete startup checks block removal. Close manually launched bot terminals first: relative-path processes
outside the recognized launcher's tree cannot be safely attributed.

The optional old-folder deletion requires data-deletion consent too. It refuses the
running installer's folder, development checkouts, protected paths, junctions/symbolic
links, and folders with unrecognized top-level contents. Back up local changes first:
recognized old-folder contents are permanently deleted when confirmed. External or
nonstandard database paths require manual resolution rather than automatic deletion.

Run the window from an elevated PowerShell if task cleanup requires administrator
permissions. Failures are displayed explicitly; some cleanup may already have
completed, so check again before retrying. Shared Node.js/npm, Discord-side settings,
Windows services, PM2, Docker, and unsupported installations are not automatically
removed. Linux support and packaged downloads are not implemented yet.

#### Install or reinstall

Run setup **as administrator**, using the same Windows account that should run the
bot. A different administrator account would own the resulting startup task and shortcuts.
The installer copies its bundled bot files, not a download from source control.
It requires internet access for `npm ci` and, if selected, Discord command registration.
Node.js 22.12+ and npm are required. The optional Node.js checkbox uses Windows App
Installer (`winget`) to download the exact `OpenJS.NodeJS.LTS` package if needed;
Windows may request consent. If winget is absent, install Node.js LTS manually.

The setup screen includes:

- Editable destination (default `%LOCALAPPDATA%\RustDropsBot`) and folder picker.
- Masked bot token, application ID, and Discord server ID.
- Optional reuse of a scanned installation's configuration and/or SQLite database.
  Blank credential fields keep reused values; entered fields override them.
- Separate checkboxes for current-user sign-in startup, starting immediately,
  registering slash commands, and desktop/Start menu start shortcuts.
- Separate **Cancel** and **Install** buttons.

Opening or cancelling this screen does not install or uninstall anything. After
**Install**, a fresh scan runs (including earlier discovered folders), then a final
confirmation lists the old installations to remove. Unsupported startup entries,
incomplete startup scans, occupied destinations/shortcuts, and protected old folders
block installation. The setup's own folder is preserved. Deep scanning remains opt-in;
only discovered installations can be addressed.

After confirmation, setup validates Node.js, stages clean bundled files, installs
dependencies, and builds the bot **before** removing old installations. If selected,
command registration also runs before old cleanup; it updates the selected Discord
server and cannot be undone by cancelling a later failure. Supported old startup
setups are stopped, old data is backed up, and their confirmed old folders are removed.
The new configuration uses `data\bot.db`; selected database preferences are retained.
The running setup copy can supply a database through SQLite's online backup API.

The private staging/recovery folder is shown in the result under
`%LOCALAPPDATA%\RustDropsBot-Setup\<unique-id>`. It may contain secret credentials.
Recovery copies are intentionally retained: verify the new bot, then remove these
specific folders manually when no longer needed. Errors explicitly report possible
partial changes and the recovery location; automatic rollback is not promised.

The installed launcher remains at `%ProgramData%\RustDropsBot\start-rust-bot.ps1`,
with private output/error logs alongside it. Optional `RustDropsBot` startup runs
at **this user's sign-in**, with limited privileges, no saved password, no execution
time limit, and duplicate-task prevention. Shortcuts start the bot (not setup);
a per-session mutex prevents duplicate starts. Starting successfully only verifies
that the process/task stays running briefly, not that Discord connectivity is healthy.
Check the bot's online state and use `/setchannel` and `/checkdrops` afterward.

Run the isolated safety tests with `npm run test:installer`. They mock OS task and
process operations and use temporary fixture folders; they do not uninstall a real bot,
download Node.js, or contact Discord. When local dependencies are available, a real
SQLite WAL backup is also tested on temporary data.

### Environment Variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Bot token used to log in |
| `DISCORD_CLIENT_ID` | For deploy script | Application id for slash-command registration |
| `DISCORD_GUILD_ID` | For deploy script | Target guild for command registration |
| `DATABASE_PATH` | Optional | SQLite file path (`./data/bot.db` default) |
| `CHECK_INTERVAL_MS` | Optional | Scheduler interval in ms (`300000` default) |
| `TWITCH_MOCK_DROPS` | Optional | Use mock Twitch data (`true`/`false`) |
| `KICK_MOCK_DROPS` | Optional | Use mock Kick data (`true`/`false`) |

### Production Host Notes

- Run `npm run build` and then `npm start`.
- Keep `.env` outside source control.
- Persist `data/` on durable storage if deployed in containers or ephemeral hosts.
- Prefer a process manager (systemd, PM2, Docker restart policy) for automatic restarts.

## Troubleshooting

Common issues and fixes:

1. Bot does not come online.
   - Verify `DISCORD_TOKEN` is set and valid.
   - Check startup logs from `src/index.ts` for login errors.

2. Commands do not appear.
   - Re-run `npm run deploy-commands` with correct `DISCORD_CLIENT_ID` and `DISCORD_GUILD_ID`.
   - Confirm bot has `applications.commands` scope in the guild.

3. No drop alerts are sent.
   - Ensure reminder channel is configured with `/setchannel`.
   - Confirm alert toggles with `/alerts status`.
   - Check provider mode (mock vs live) and provider source mode output.

4. Provider data appears empty.
   - Twitch/Kick upstream pages or APIs may be temporarily unavailable.
   - Retry later; the scheduler is designed to continue on provider failures.
   - Twitch uses the official Facepunch campaign page for dates and participation.
     Optional Twitch API credentials are used only as a fallback if Facepunch fails.
   - Twitch timing uses the published Facepunch campaign date range, not the
     countdown target (which is the start date for upcoming campaigns). Discord
     timestamps display in each viewer's local timezone.
   - If both Facepunch and its API fallback fail, Twitch fails the sync cycle rather than
     inventing dates or marking stored campaigns as ended. A successful subsequent
     sync replaces incorrectly timed Facepunch entries automatically.

5. Database issues.
   - Confirm process can write to `DATABASE_PATH` directory.
   - Ensure file system permissions are correct.

For operations-level response steps, see [docs/runbook.md](docs/runbook.md).

## Testing

Current commands:

- `npm test` for unit tests
- `npm run test:coverage` for coverage report output

Current scope includes alert window behavior in [src/services/reminderService.test.ts](src/services/reminderService.test.ts#L1)
and Twitch campaign parsing in [src/providers/twitch.test.ts](src/providers/twitch.test.ts).
The [drop flow tests](src/services/dropFlow.test.ts) exercise official campaign HTML
through real SQLite persistence and a mocked Discord send, including schema migration,
manual snapshots, live alert dedupe, and failed-sync preservation.

Not yet covered in depth:

- Provider integration and parsing edge cases
- DB persistence behavior and schema migration safety
- End-to-end interaction command workflows

See [docs/testing-strategy.md](docs/testing-strategy.md) for detailed strategy and next coverage targets.

## Contributing, Security, and Support

- Contribution guide: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security policy: [SECURITY.md](SECURITY.md)
- Support and maintenance: [SUPPORT.md](SUPPORT.md)
- Changelog: [CHANGELOG.md](CHANGELOG.md)
- Versioning policy: [VERSIONING.md](VERSIONING.md)

## License

MIT. See [LICENSE](LICENSE).
