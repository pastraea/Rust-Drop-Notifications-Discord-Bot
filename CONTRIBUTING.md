# Contributing

Thanks for contributing.

## Branching

- Create feature branches from `main`.
- Use short, descriptive branch names, for example `feat/alerts-status-copy` or `fix/twitch-parser-timeout`.
- Release preparation uses `release/<version>` branches (for example `release/0.4.0`); see [VERSIONING.md](VERSIONING.md).
- Keep pull requests focused on one concern.

## Commit Style

- Use small, logical commits with clear intent.
- Recommended format: `type(scope): summary`.
- Examples:
  - `feat(commands): add alert status output`
  - `fix(provider): handle empty campaign response`
  - `docs(readme): add deployment troubleshooting`

## Development Workflow

1. Use Node.js 22.12 or newer and npm 10+.
2. Install dependencies with `npm ci` (or `npm install` when changing dependencies).
3. Run static analysis with `npm run lint` and validate the build with `npm run build`.
4. Run tests with `npm test`.
5. If you change the Windows installer, updater, or setup UI, also run `npm run test:installer` and `npm run test:updater` on Windows. They mock OS operations and use temporary folders.
6. When changing behavior, add or update tests. Database changes must be a new numbered migration in `src/db.ts` (never an edit to an existing one) with a test in `src/migrations.test.ts`.
7. Never commit `.env`, tokens, or database files, and never paste them into issues or pull requests.

## Pull Request Expectations

- Explain what changed and why.
- Include test evidence (command output or screenshots where relevant).
- Note breaking changes explicitly.
- Update docs when behavior, config, or operations are affected.

## Code Quality

- Preserve existing style and architecture patterns.
- Avoid unrelated refactors in feature/fix PRs.
- Prefer explicit error handling and actionable logs.
