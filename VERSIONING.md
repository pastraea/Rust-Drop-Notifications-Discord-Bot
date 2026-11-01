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

Releases are published by `.github/workflows/release.yml` when a version tag is pushed.

1. Create `release/<version>` from `main`.
2. Set the version in `package.json` and `package-lock.json` (`npm version <version> --no-git-tag-version`) and move the `[Unreleased]` changelog entries under a heading of the form `## [<version>] - YYYY-MM-DD`. The workflow publishes this section as the release notes.
3. Validate locally in this order: `npm ci`, `npm run lint`, `npm run build`, `npm test`, `npm run test:installer`, `src/installer/Test-Executable.ps1` (builds the setup EXE into `artifacts/`), then `npm run test:updater`. The updater suite only runs its embedded-payload checks when the current version's EXE already exists.
4. Merge to `main` and confirm CI passes.
5. Create an annotated tag whose subject line becomes the release title, for example `git tag -a v<version> -m "v<version> - Short Title"`, and push it. The workflow verifies that the tag, `package.json`, `package-lock.json`, and changelog agree, repeats the validation on Windows, builds the EXE, and creates the release.
6. Confirm the release has exactly one asset, `Rust-Drop-Notifications-Discord-Bot-Setup-<version>.exe`, then delete the release branch. The opt-in updater only accepts a stable release with that asset name, the expected URL and size, and GitHub's SHA-256 digest, so do not rename or add assets.

If the workflow fails nothing is published. Fix the cause, delete and re-push the tag, or as a last resort build the EXE locally and create the release by hand with `gh release create`, keeping the same asset name. The workflow refuses to run if a release for the tag already exists.

## Practical Rules for This Project

- Changes to command names, env vars (including accepted values and ranges), database schema, installer or updater behavior, or message contract should be treated as potentially breaking.
- Dependency-only upgrades can be patch releases unless they alter runtime behavior.
