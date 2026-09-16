# Agent Note: pnpm 11 native entrypoint spawn

Status: implemented

English | [中文](2026-08-21-pnpm-exe-entrypoint.zh.md)

## Problem

`pnpm run build` failed on Windows, Linux, and macOS under pnpm 11 because `scripts/build.ts` and the other package-script launchers spawned `node` with `process.env.npm_execpath` as a JavaScript file. pnpm 11's `@pnpm/exe` layout points `npm_execpath` at a native binary (`pnpm.exe` on Windows, an ELF `pnpm` on Unix). Node then throws `ERR_UNKNOWN_FILE_EXTENSION` for `.exe` or `SyntaxError: Invalid or unexpected token` on the ELF header. Users cloning the repository and following the from-source install path hit this on the first `pnpm run build`.

## Decision

`scripts/pnpm-invocation.ts` is the single resolver: a `npm_execpath` that ends in `.js` / `.cjs` / `.mjs` still runs through `process.execPath`; every other path is spawned as the command itself. `scripts/build.ts`, `scripts/run-gates.ts`, `scripts/run-web-snapshots.ts`, and `scripts/coverage-partitions.ts` all launch children through that helper and remain shell-free.

## Alternatives considered

**Always spawn `npm_execpath` as the command.** Rejected: npm 7+ still sets `npm_execpath` to `npm-cli.js`, and Windows cannot execute a bare `.js` path without Node.

**Always run `node npm_execpath`.** Rejected: that is the failing assumption for pnpm 11's native entrypoint.

**`shell: true` so the OS resolves `.cmd` / shebang / `.exe`.** Rejected: it changes quoting and metacharacter semantics on every host.

## Consequences

From-source `pnpm run build` works when pnpm 11 supplies a native `npm_execpath`. npm's JavaScript CLI path still runs through Node. Coverage partitions and web snapshot workers inherit the same spawn rule, so a Windows or pnpm-11 CI host does not fail later in the same way.

## Testing

`scripts/pnpm-invocation.spec.ts` covers JavaScript launchers (including `.mjs` and mixed-case `.CJS`) and native paths (`pnpm` with no extension, `pnpm.exe`). `scripts/coverage-partitions.spec.ts` asserts a `.cjs` entrypoint still prefixes Node and a native `/tools/pnpm` entrypoint is the command with `exec` as argv0.
