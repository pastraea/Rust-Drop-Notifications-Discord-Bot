# Rust Drops Notifications Bot

Discord bot that tracks Rust drops from Twitch and Kick providers, persists state in SQLite, and posts reminder snapshots to Discord.

## Features

- Scheduled drop polling and campaign reconciliation
- Discord slash commands for channel configuration, alert preferences, and GIF controls
- SQLite persistence for user preferences, campaign state, and notification dedupe
- Mock and live provider modes for local testing and production operation

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

### Environment Variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Bot token used to log in |
| `DISCORD_CLIENT_ID` | For deploy script | Application id for slash-command registration |
| `DISCORD_GUILD_ID` | For deploy script | Target guild for command registration |
| `REMINDER_CHANNEL_ID` | Optional | Fallback reminder channel if DB setting not set |
| `DATABASE_PATH` | Optional | SQLite file path (`./data/bot.db` default) |
| `CHECK_INTERVAL_MS` | Optional | Scheduler interval in ms (`300000` default) |
| `TWITCH_CLIENT_ID` | Optional | Enables richer Twitch API data |
| `TWITCH_CLIENT_SECRET` | Optional | Enables richer Twitch API data |
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
   - Ensure reminder channel is configured (`/setchannel`) or `REMINDER_CHANNEL_ID` is set.
   - Confirm alert toggles with `/alerts status`.
   - Check provider mode (mock vs live) and provider source mode output.

4. Provider data appears empty.
   - Twitch/Kick upstream pages or APIs may be temporarily unavailable.
   - Retry later; the scheduler is designed to continue on provider failures.

5. Database issues.
   - Confirm process can write to `DATABASE_PATH` directory.
   - Ensure file system permissions are correct.

For operations-level response steps, see [docs/runbook.md](docs/runbook.md).

## Testing

Current commands:

- `npm test` for unit tests
- `npm run test:coverage` for coverage report output

Current scope includes alert window behavior in [src/services/reminderService.test.ts](src/services/reminderService.test.ts#L1).

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
