# Contributing

Thanks for contributing.

## Branching

- Create feature branches from `main`.
- Use short, descriptive branch names, for example `feat/alerts-status-copy` or `fix/twitch-parser-timeout`.
- Keep pull requests focused on one concern.

## Commit Style

- Use small, logical commits with clear intent.
- Recommended format: `type(scope): summary`.
- Examples:
  - `feat(commands): add alert status output`
  - `fix(provider): handle empty campaign response`
  - `docs(readme): add deployment troubleshooting`

## Development Workflow

1. Install dependencies with `npm install`.
2. Validate build with `npm run build`.
3. Run tests with `npm test`.
4. When changing behavior, add or update tests.

## Pull Request Expectations

- Explain what changed and why.
- Include test evidence (command output or screenshots where relevant).
- Note breaking changes explicitly.
- Update docs when behavior, config, or operations are affected.

## Code Quality

- Preserve existing style and architecture patterns.
- Avoid unrelated refactors in feature/fix PRs.
- Prefer explicit error handling and actionable logs.
