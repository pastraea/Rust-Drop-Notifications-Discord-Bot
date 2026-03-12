# Architecture

## Goal

Track Rust drops from multiple providers, store campaign/user state, and send timely Discord announcements.

## Components

- Entry point: `src/index.ts`
- Scheduler: `src/scheduler.ts`
- Providers: `src/providers/twitch.ts`, `src/providers/kick.ts`
- Sync service: `src/services/dropService.ts`
- Reminder service: `src/services/reminderService.ts`
- Interaction handlers: `src/commands/handleInteraction.ts`
- Persistence: `src/db.ts`

## Runtime Flow

1. Boot config and open SQLite database.
2. Start Discord client.
3. On scheduler cycle:
   - fetch normalized drops from providers
   - reconcile active/upcoming/ended drop state in DB
   - compute due reminder windows and send notifications
4. On slash commands/components:
   - parse command
   - update per-user or global settings in DB
   - reply ephemerally or post channel update

## Design Decisions and Tradeoffs

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
