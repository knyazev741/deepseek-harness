---
description: "Automatic npm publication from the fork's main branch, including version commits, clean installation checks, npm credentials, and recovery after a failed release."
---

# Publishing main to npm

English | [中文](publishing-main.zh.md)

## Summary

The fork's [Publish main to npm workflow](../../.github/workflows/release-main.yml) publishes changes pushed to `main`. It also accepts a manual run from `main`. A successful release updates the npm `latest` channel used by `npx @knyazevai/dsh web`.

## Table of Contents

- [Requirements](#requirements)
- [Release lifecycle](#release-lifecycle)
- [Failures and retries](#failures-and-retries)
- [Dev Note](#dev-note)

<a id="requirements"></a>
## Requirements

GitHub Actions needs permission to push version commits and tags. Branch protection remains authoritative: a refused push stops publication. The repository secret `NPM_TOKEN` must authorize public publication, new packages in the fork's npm scope, distribution-tag updates, and unattended publishing under the account's two-factor policy. Rotate that secret when its npm credential expires or changes. The `npm-publish` environment must admit `main` without required reviewers for unattended releases.

<a id="release-lifecycle"></a>
## Release lifecycle

1. One serialized release reserves a stable version above the source baseline and all published or tagged versions. It commits the family manifests and lockfile, pushes that commit to `main`, and creates its `dsh-v` tag. The workflow's own `GITHUB_TOKEN` push does not start another workflow run.
2. The release verifies the clean source SHA against remote `main` before building and again before publication. It builds the complete official artifacts and packs the DSH family. Vendored and native runtime dependencies must already be available from public npm.
3. The entry-only smoke installs just the CLI into a temporary consumer with a fresh npm cache and profile. A loopback registry supplies packed DSH artifacts; external dependencies come from public npm. The normal npm resolver runs with a 1536 MiB Node heap budget, and Chromium must render the workspace picker without client errors.
4. Publication uploads immutable versions under a version-specific `candidate-` tag. Public-registry smokes repeat installation and browser startup on Node 24 and Node 22. Only then does promotion verify every tarball's public integrity, refuse distribution-tag downgrades, and update the family to `latest`. The CLI tag changes last.

The workflow retains tarballs, redacted startup logs, browser screenshots, and smoke reports for seven days. It does not copy an existing user's credentials or provider configuration into the consumer and does not make paid model calls.

<a id="failures-and-retries"></a>
## Failures and retries

A failure before promotion leaves the CLI's `latest` unchanged; already uploaded candidate versions remain visible by exact version. A failure during promotion may advance other family tags before the CLI changes. A full workflow rerun reserves a new version rather than overwriting published bytes. A newer `main` stops a stale build or publication; the queued run releases the current branch.

Inspect the failed step and its retained evidence before rerunning. Credential failures require a valid `NPM_TOKEN`; source movement requires the current `main`; install or browser failures require a code fix. Disabling peer dependency resolution is not an installation check: it can omit runtime dependencies and fail after npm finishes.

<a id="dev-note"></a>
## Dev Note

The [release-sequence rationale](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md) owns family versioning and immutable publication. The [packed registry](../../scripts/release/packed-registry.ts), [consumer smoke](../../scripts/release/smoke-web-install.ts), and [promotion preflight](../../scripts/release/promote.ts) own the executed checks.
