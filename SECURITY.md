# Security Policy

## Supported Versions

Security fixes are released for the latest minor version only. Please upgrade before reporting an issue.

| Version | Supported |
| --- | --- |
| 0.4.x | Yes |
| 0.3.x and earlier | No |

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
- Dependency updates are proposed weekly by Dependabot and reviewed before release. `npm audit` is run manually when preparing a release; findings in development-only tooling are tracked separately from runtime dependencies.
- The Windows setup EXE is currently unsigned. Automatic updates (opt-in) verify the release asset URL, size, and GitHub-published SHA-256 digest over HTTPS; this does not protect against a compromised repository or maintainer account.
- Configuration (`.env`) and recovery backups can contain secrets. See [docs/data-privacy.md](docs/data-privacy.md).
