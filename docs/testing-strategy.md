# Testing Strategy

## Current Coverage

Current automated tests cover alert-window timing in `src/services/reminderService.test.ts`
and Twitch campaign parsing in `src/providers/twitch.test.ts`.
`src/services/dropFlow.test.ts` exercises provider HTML through real SQLite and mocked
Discord sends, without logging into Discord or making live network requests.

Covered areas:

- 24h reminder window behavior
- 12h reminder window behavior
- 1h reminder window lookback logic
- no-alert behavior for already-started drops
- Facepunch published UTC date ranges, including upcoming countdowns targeting the start date
- campaign status boundaries, multiple campaigns, and legacy countdown-only pages
- invalid/missing dates and Helix fallback without fabricated timestamps
- official streamer-card parsing without unrelated live-directory channels
- per-campaign participant isolation and refreshed channel lists
- general-drop persistence and migration from databases without the new column
- manual checks for upcoming campaigns beyond 24 hours, including general-only campaigns
- live announcements with correct channels and dedupe preserved
- failed provider syncs retaining stored campaign participation

## Gaps and Next Targets

1. Provider tests

- Twitch and Kick parser behavior under malformed/partial upstream payloads
- fallback mode behavior when API/web sources fail

2. Database tests

- user preference persistence
- notification dedupe correctness
- pruning behavior for retention windows

3. Interaction tests

- command routing and validation
- permission-sensitive command behavior
- error reply fallback behavior

4. Scheduler and integration tests

- cycle concurrency guard behavior
- end-to-end flow from provider sync to reminder dispatch

## Test Commands

- `npm test`
- `npm run test:coverage`

## Quality Bar

- All behavior changes should include or update tests.
- Fixes for production incidents should include regression tests where feasible.
