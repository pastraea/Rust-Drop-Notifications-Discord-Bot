# Testing Strategy

## Current Coverage

Current automated tests focus on alert-window timing behavior in `src/services/reminderService.test.ts`.

Covered areas:

- 24h reminder window behavior
- 12h reminder window behavior
- 1h reminder window lookback logic
- no-alert behavior for already-started drops

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
