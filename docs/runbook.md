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
