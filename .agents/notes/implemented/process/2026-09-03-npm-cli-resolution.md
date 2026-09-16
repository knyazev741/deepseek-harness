# Agent Note: npm resolves the repository CLI from repository checkouts

Status: implemented

English | [中文](2026-09-03-npm-cli-resolution.zh.md)

## Problem

The repository uses pnpm as its workspace manager, but npm also reads the root `workspaces` field when `npx @knyazevai/dsh web` runs from a checkout. The broad npm globs matched the `vendor/CLAUDE.md` instruction symlink and the local `apps/cli` package. npm then treated the CLI as an already-present workspace package without creating a root `dsh` shim, so `npx` delegated to a shell command that did not exist; the instruction symlink could also make npm fail with `ENOTDIR` while mapping workspaces.

## Decision

The root npm workspace list excludes `vendor/CLAUDE.md` but includes `apps/cli`. The private root package declares `@knyazevai/dsh: workspace:*` as a development dependency, so `pnpm install` creates a root `node_modules/@knyazevai/dsh` link and the `dsh` executable shim. From a prepared checkout, `npx @knyazevai/dsh web` therefore runs the local CLI and its workspace plugins without contacting npm. The authoritative pnpm workspace list remains unchanged.

The [DSH npm-scope Agent Note](2026-09-08-knyazevai-dsh-npm-scope.md) owns the permanent `@knyazevai` versus `@deepseek-ai` package-family split; this note owns the npm workspace-resolution exception within that split.

The `@knyazevai/dsh` package manifest used for publication declares the repository Node engine range, `^22.19.0 || >=24.0.0`, in its own manifest. Its `bin.mjs` wrapper runs the repository's `scripts/repo-dsh.ts` through `tsx` when the package resolves inside this checkout, and falls back to the packaged `lib/bin.js` outside it. The root README pair states the same prerequisite next to the npm command.

## Alternatives considered

- **Exclude `apps/cli` from the npm workspace match:** `npx` falls back to the registry package, which does not run the checkout's local build or plugins.
- **Remove the root `workspaces` field:** this avoids npm workspace discovery but breaks repository tooling that reads the root manifest to enumerate DSH packages, while pnpm already has a separate authoritative workspace file.
- **Make `npx` execute a separate source wrapper:** this duplicates the CLI entry path and still requires `pnpm install` before the checkout can resolve its workspace dependencies; the root package link reuses the existing CLI entry point.

## Consequences

- After `pnpm install`, `npx @knyazevai/dsh web` runs the checkout's CLI and local plugins; outside a checkout, `npx` continues to resolve the registry package normally.
- The npm-specific exclusion removes only the vendored instruction symlink; the complete pnpm workspace and local CLI package remain available.
- A user must use Node.js 22.19+ or 24+; the next npm publication can report an engine mismatch early instead of allowing the CLI to fail later on an unavailable Node API.

## Testing

- npm's workspace mapper resolves 251 workspaces while excluding both `@knyazevai/dsh` and `vendor/CLAUDE.md`.
- The repository CLI metadata maps `dsh` to `bin.mjs`, and the wrapper's source-checkout path works without `apps/cli/lib`.
- The current registry tarball retains its `dsh` to `lib/bin.js` entry and contains that executable.
- `npx --no-install @knyazevai/dsh --version` and `npx @knyazevai/dsh --version` both return `0.1.1-rc.2` after the workspace install.
- `pnpm dsh --version`, `pnpm run verify-dsh-package-licenses`, the named README pairing check, and relative-link validation pass.
