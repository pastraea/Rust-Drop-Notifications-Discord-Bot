# Testing Strategy

## Current Coverage

Current automated tests cover alert-window timing in `src/services/reminderService.test.ts`,
Twitch campaign parsing in `src/providers/twitch.test.ts`, environment validation in
`src/config.test.ts`, graceful shutdown ordering in `src/shutdown.test.ts`, and scheduler
overlap/stop/failure behavior in `src/scheduler.test.ts`, and schema migrations in
`src/migrations.test.ts` (fresh, legacy, up-to-date, newer, failing, and backup-failure databases,
rollback, backup contents and retention, and numbering rules). `npm run lint` runs Biome static analysis.
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
- Windows uninstall detection, process-tree isolation, confirmation preconditions,
  data preservation/deletion, protected folders, and WPF layout loading in
  `src/installer/Test-WindowsUninstall.ps1`; scheduled-task and process calls are mocked
- Windows discovery adapters for tasks, services/NSSM, registry startup entries,
  Startup scripts and processes; identity checks on renamed/unrelated folders,
  bounded common scans, deep scans, and incomplete-scan removal blocking
- Desktop button order and opt-in environment copies: editable in-memory text,
  original-file preservation, no automatic credential files, installation selection,
  missing/changed-target handling, and no secret contents in scan reports
- Collapsed-by-default More section containing all diagnostics/advanced controls,
  compact layout sizing, expansion/collapse resizing, and scan-result preservation
  without automatically expanding diagnostics on completion or cancellation
- Install/reinstall screen controls, masked credentials, independent settings and cancel,
  and the default-on Preserve .env checkbox that locks credential fields.
- Staged installation before cleanup, database reuse, private recovery ACLs,
  changed-scan rejection, fresh-install isolation from bundled secrets, command-output
  redaction, opt-in Node.js provisioning, and limited current-user logon task settings.
  Preserved `.env` files (with comments, quotes, `$`, duplicate keys, CRLF, no trailing
  newline) are checked for byte-for-byte equality; guards for entered credentials,
  custom `DATABASE_PATH`, missing command-registration IDs, and edits between
  confirmation and install; the opt-out path lists and skips the `.env` backup; and
  appended options are tested for idempotence, CRLF and BOM handling.
  `src/installer/Test-WindowsInstall.ps1` is invoked by the main installer test script.
  A temporary live-WAL SQLite backup is tested when Node.js/dependencies are present.
- Standalone EXE compilation using the Windows .NET Framework compiler, embedded
  payload completeness/content and exclusion of private/build files, extraction
  verification, and a real UI open/close with Node.js/npm absent from PATH.
  Temporary extraction cleanup is checked after the launcher exits.
- An offline compiled bootstrap fixture hands off to another real EXE and reopens
  the setup window exactly once, retaining the cache and cleaning temporary source
  extractions. No GitHub requests or bot installation occur in this handoff test.
- Optional updater controls, persisted opt-in/opt-out, uninstall preference cleanup,
  and default-disabled EXE startup without a live GitHub request.
- Isolated updater release/version/digest/URL validation, cached downloads,
  rejection of malformed payload paths, maintenance locking, running-bot refusal,
  staging failure preservation, activation restoration, and config/database/WAL/SHM
  preservation. GitHub/download/Node/process adapters are mocked; actual temporary
  directory moves and compiled EXE resource extraction are exercised.

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

Bot build, tests, and coverage require Node.js 22.12+ and npm 10+.
CI runs the build and tests on Node.js 22 and 24, with coverage on Node.js 22.
Node.js 20 is not supported by the existing `better-sqlite3` 13 dependency.

- `npm run lint`
- `npm test`
- `npm run test:coverage`
- `npm run test:installer` (Windows only; also runs in the separate Windows CI job)
- `npm run test:updater` (Windows only; build the setup EXE first for embedded-payload checks)
- `powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\src\installer\Test-Executable.ps1`
  (Windows only; builds the executable and opens/closes the setup UI without installing anything)

## Quality Bar

- All behavior changes should include or update tests.
- Fixes for production incidents should include regression tests where feasible.
