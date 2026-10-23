# Operations Runbook

## Daily Checks

- Confirm bot process is running and connected to Discord.
- Watch logs for:
  - login failures
  - provider fetch failures
  - scheduled cycle failures
  - database write errors

## Key Log Signals

- Startup: successful login and provider mode summary
- Scheduler: cycle duration and skipped-cycle warnings
- Provider: fetch errors and fallback mode changes
- Interaction: command handling failures and response fallback errors

## Restart Behavior

- Safe restart sequence:
  1. stop process
  2. verify no stale lock/process remains
  3. start process (`npm start` in production)
- Prefer process managers with automatic restart policies.

## Incident Playbooks

### Provider Data Failure

Symptoms:

- empty or stale drop updates
- provider source mode reports fallback/error

Actions:

1. Verify outbound network connectivity.
2. Check upstream provider/API availability.
3. Validate env vars for Twitch credentials.
4. Keep bot running; it is designed to recover on next successful poll.

### Discord API Failure

Symptoms:

- login failure
- interaction replies failing
- message send failures

Actions:

1. Confirm token is valid and not rotated unexpectedly.
2. Confirm bot has required guild/channel permissions.
3. Retry command registration if command metadata is out of sync.
4. Restart process after credential updates.

### Database Failure

Symptoms:

- SQLite open error
- write failures
- missing settings not persisting

Actions:

1. Verify `DATABASE_PATH` directory exists and is writable.
2. Check disk space and filesystem health.
3. Backup DB file before manual recovery.
4. If file corruption suspected, restore from backup and restart.

## Backup Guidance

- Snapshot the SQLite file during low activity windows.
- Keep versioned backups and retention policy external to the app.
- Validate restore procedure periodically.

## Removing the Legacy Windows Startup Setup

Launch `npm run installer` on the host, elevated if task permissions require it.
Run **Check installation**, select a detected folder, and inspect the report
before selecting **Uninstall** to review removal options.
The scan includes scheduled tasks, services/NSSM, machine and loaded-user startup
registry entries, profile Startup folders, processes, and common folders.
**More** contains scan status, discovered installations, diagnostic reports, and
advanced controls, including a deep fixed-drive scan or a specific-folder check.
It is collapsed by default and remains collapsed during scans; expand it to review results.
Access errors are shown and incomplete startup coverage blocks automatic removal.

Automatic startup removal supports the `RustDropsBot` scheduled task
that launches `%ProgramData%\RustDropsBot\start-rust-bot.ps1` at user logon.

Data deletion and old-folder deletion are opt-in and permanent. Back up the
configured database and credentials first. The running installation and development
folders cannot be deleted by the tool. External database paths, unknown task
actions, ambiguous relative-path processes, and unrecognized folder contents
require manual resolution. The tool does not remove shared runtimes or undo
Discord-side bot registrations, permissions, or previously sent messages.
Detected services, registry startup entries, and other task configurations must be
removed manually before this version can remove their associated installation.
Deep scans are not exhaustive: links, dependency/system metadata folders,
unloaded-user registry hives, containers, and remote drives are not inspected.

If an uninstall fails, its error is shown and some prior steps may already have
completed. Recheck before retrying; a task disabled during a failed removal will
not restart automatically until explicitly re-enabled or reconfigured.

## Windows Install / Reinstall

The standalone setup EXE opens the same UI without npm, Node.js, or a checkout.
Right-click the EXE and choose **Run as administrator** for installation, under
the intended bot account. It uses the Windows-provided .NET Framework and Windows
PowerShell 5.1. Only opening/checking the setup UI is independent of Node.js/npm;
installing and running the bot still require them.

Setup extracts its embedded source to a private, unique temporary folder and
removes that folder after the setup window closes. Recovery backups below are
separate and intentionally retained. Cleanup failures report the exact folder
to remove. The executable is unsigned; no automatic update or release download
is performed by the launcher.

Run the setup window as administrator using the intended bot account. Select
**Install / Reinstall**. Fill in the
destination and masked credentials, or opt into reusing a scanned configuration.
Select startup, start-now, registration, and shortcut settings independently.
**Cancel** dismisses the options without changes. **Install** rescans and requests
explicit confirmation of the removal list before any installation changes.

Staging/build and optional Discord command registration precede destructive
cleanup. Registration changes the selected server even if a later step fails.
Old credential/database recovery copies are retained under the private
`%LOCALAPPDATA%\RustDropsBot-Setup` directory; error/success output identifies the
specific location. Preserve it until recovery or verification is complete.
Never upload its contents. Failed installs may be partial: inspect the reported
destination, startup task, launcher, and recovery paths before retrying.

Installed startup uses the original `RustDropsBot` launcher/task identity so the
uninstaller can recognize it. It starts at the current user's logon, not boot.
Shortcuts are ownership-recorded and removed only when their target still matches.
Node.js/npm remain shared prerequisites and are not removed during uninstall.

## Launch-Time Automatic Updates (Windows)

Automatic updating is opt-in in the install/reinstall screen and changeable under
**More**. It applies to the current Windows user's setup EXE launches and the
one installer-managed bot recorded in
`%LOCALAPPDATA%\RustDropsBot-Updater\settings.json`. There is no separate permanent
service or polling task: the updater is a separate one-shot process before launch.
Stopping the bot and opening its shortcut triggers one check. A bot that remains
running never polls GitHub. Direct npm/development launches bypass the updater.

The latest stable GitHub release must include the expected EXE asset and GitHub
SHA-256 digest. Checks have a 15-second API timeout; downloads have a 120-second
timeout. Dependency build duration depends on the machine/network. No automatic
Node.js upgrade or Discord command deployment occurs. A network/build failure
is logged and leaves the old version available to launch. A maintenance-lock
conflict or failed restoration blocks launch rather than starting during mutation.

Review `%LOCALAPPDATA%\RustDropsBot-Updater\updater.log` for failures and retained
backup paths. Setup displays a warning if its check fails. Bot launcher failures
continue to use its existing logs; the dedicated updater log persists even when
the launcher is hidden. Fix permissions, prerequisites, or network access, then
retry on the next launch; there is no retry loop.

On successful bot update the entire old installation is retained under
`.rust-drops-update-<id>\previous` beside the bot. It includes sensitive `.env` and
database files. Staging failures may also retain a private `prepared` folder.
For recovery: disable automatic updates under More, stop the bot/startup task,
verify no process is using either copy, and restore the complete previous copy to
the original path. Do not mix old code with a newly migrated database. Restart and
verify Discord status; remove only the specific obsolete backup folders after
verification. Do not delete all similarly named directories blindly.

Uninstall disables the preference only when its recorded installation matches.
Caches, logs, and backups are retained, not registered as startup services.
Changing preferences during an active update affects the next launch only.
Opening an old setup EXE can hand off to the latest verified cached EXE without
overwriting the downloaded original. Failed bot readiness after activation does
not trigger an automatic database rollback.
