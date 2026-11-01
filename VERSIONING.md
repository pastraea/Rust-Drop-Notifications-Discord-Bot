# Versioning Policy

This project uses Semantic Versioning.

## Version Format

`MAJOR.MINOR.PATCH`

- MAJOR: incompatible API or behavior changes
- MINOR: backward-compatible features
- PATCH: backward-compatible bug fixes and internal improvements

## Release Discipline

- Update CHANGELOG entries before tagging a release.
- Tag releases in git using the version string, for example `v0.4.0`.
- Keep unreleased work in the `[Unreleased]` section until shipped.

## Release Process

1. Create `release/<version>` from `main`.
2. Set the version in `package.json` and `package-lock.json` (`npm version <version> --no-git-tag-version`) and move the `[Unreleased]` changelog entries under a dated version heading.
3. Validate in this order: `npm ci`, `npm run build`, `npm test`, `npm run test:installer`, `src/installer/Test-Executable.ps1` (builds the setup EXE into `artifacts/`), then `npm run test:updater`. The updater suite only runs its embedded-payload checks when the current version's EXE already exists.
4. Merge to `main`, create an annotated tag `v<version>`, and push both.
5. Publish a GitHub release named `v<version> - <title>` containing exactly one asset, `Rust-Drop-Notifications-Discord-Bot-Setup-<version>.exe`. The opt-in updater only accepts a stable release with that asset name, the expected URL and size, and GitHub's SHA-256 digest, so do not rename or add assets.
6. Confirm CI passed on `main`, then delete the release branch.

## Practical Rules for This Project

- Changes to command names, env vars (including accepted values and ranges), database schema, installer or updater behavior, or message contract should be treated as potentially breaking.
- Dependency-only upgrades can be patch releases unless they alter runtime behavior.
