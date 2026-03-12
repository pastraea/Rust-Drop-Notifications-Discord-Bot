# Versioning Policy

This project uses Semantic Versioning.

## Version Format

`MAJOR.MINOR.PATCH`

- MAJOR: incompatible API or behavior changes
- MINOR: backward-compatible features
- PATCH: backward-compatible bug fixes and internal improvements

## Release Discipline

- Update CHANGELOG entries before tagging a release.
- Tag releases in git using the version string, for example `v0.2.0`.
- Keep unreleased work in the `[Unreleased]` section until shipped.

## Practical Rules for This Project

- Changes to command names, env vars, database schema, or message contract should be treated as potentially breaking.
- Dependency-only upgrades can be patch releases unless they alter runtime behavior.
