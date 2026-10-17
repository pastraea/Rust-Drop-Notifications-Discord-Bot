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
- Install/reinstall screen controls, masked credentials, independent settings and cancel.
- Staged installation before cleanup, database/config reuse, private recovery ACLs,
  changed-scan rejection, fresh-install isolation from bundled secrets, command-output
  redaction, opt-in Node.js provisioning, and limited current-user logon task settings.
  `src/installer/Test-WindowsInstall.ps1` is invoked by the main installer test script.
  A temporary live-WAL SQLite backup is tested when Node.js/dependencies are present.
- Standalone EXE compilation using the Windows .NET Framework compiler, embedded
  payload completeness/content and exclusion of private/build files, extraction
  verification, and a real UI open/close with Node.js/npm absent from PATH.
  Temporary extraction cleanup is checked after the launcher exits.

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
- `npm run test:installer` (Windows only; also runs in the separate Windows CI job)
- `powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\src\installer\Test-Executable.ps1`
  (Windows only; builds the executable and opens/closes the setup UI without installing anything)

## Quality Bar

- All behavior changes should include or update tests.
- Fixes for production incidents should include regression tests where feasible.
