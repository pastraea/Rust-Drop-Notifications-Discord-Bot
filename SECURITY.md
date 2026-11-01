# Security Policy

## Supported Versions

Security fixes are released for the latest minor version only. Please upgrade before reporting an issue.

| Version | Supported |
| --- | --- |
| 0.4.1 and later 0.4.x | Yes |
| 0.4.0 and earlier | No (0.4.0 and earlier bundle an `undici` release with known advisories; upgrade) |

## Reporting a Vulnerability

Please do not open public issues for security vulnerabilities.

Report privately by opening a GitHub Security Advisory draft or emailing the maintainer listed in the repository profile. Include:

- Affected component and version
- Reproduction steps
- Impact assessment
- Any proposed mitigation

Never include a real `.env`, bot token, or database in a report. Redact secrets from logs. If you believe a bot token has been exposed, reset it immediately in the Discord Developer Portal.

## Response Targets

- Initial triage response: within 5 business days
- Confirmation and next steps: within 10 business days
- Public disclosure: after fix release or coordinated disclosure date

## Scope Notes

- This project depends on third-party APIs and libraries.
- Dependency updates are proposed weekly by Dependabot (grouped by minor/patch) and reviewed before release. CI runs `npm audit --omit=dev --audit-level=high` on every push to `main` and pull request, and the release workflow repeats it before publishing, so a high-severity advisory in a runtime dependency blocks a release. Advisories in development-only tooling are reviewed at release time; the current ones (in `c8`'s `glob`/`minimatch`) do not ship with the bot.
- The Windows setup EXE is currently unsigned. Automatic updates (opt-in) verify the release asset URL, size, and GitHub-published SHA-256 digest over HTTPS; this does not protect against a compromised repository or maintainer account.
- Configuration (`.env`) and recovery backups can contain secrets. See [docs/data-privacy.md](docs/data-privacy.md).
