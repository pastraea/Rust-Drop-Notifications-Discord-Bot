# Data and Privacy

## Data Stored

This bot stores operational and preference data in SQLite:

- Discord user ids for alert preferences
- Alert toggle settings and reminder channel settings
- Campaign/drop metadata from providers
- Notification history used for deduplication
- Optional user custom GIF metadata

No passwords or OAuth refresh tokens are persisted by the app.

## Storage Location

- Primary datastore is the SQLite file at `DATABASE_PATH`.
- Default path: `./data/bot.db`.
- Optional Windows update preferences (automatic-update flag, installation path, and
  the Preserve .env flag), cached
  setup executables, and a bounded diagnostic log are stored under the current
  user's `%LOCALAPPDATA%\RustDropsBot-Updater`. Automatic updates default to disabled;
  Preserve .env defaults to on. No credentials are stored in these preferences.
- Update staging and previous-installation backups are private sibling
  `.rust-drops-update-<id>` folders. They may contain `.env`, the database, and
  database sidecars and are intentionally retained until manually reviewed.
- Reinstalling with Preserve .env off deletes the old `.env` without keeping a
  recovery copy; with it on, a private recovery copy remains under
  `%LOCALAPPDATA%\RustDropsBot-Setup` until you remove it.

## Retention

- Notification history is pruned periodically to reduce long-term storage.
- Current pruning behavior removes older notification history based on configured retention logic in scheduler/DB services.

## Access and Exposure

- Data is only accessible to the runtime process and host filesystem permissions.
- Operators are responsible for securing host access, backups, and log handling.
- When updates are enabled, GitHub receives normal HTTPS API/download requests
  (including the client's IP address and updater user-agent), not bot tokens,
  environment-file contents, or database contents. No GitHub token is required.

## Operational Privacy Practices

- Keep `.env` and DB files out of version control.
- Do not log secrets.
- Share only minimal diagnostic data in public issue reports.
