# Agent Note: pnpm 11 原生入口的 spawn

Status: implemented

[English](2026-08-21-pnpm-exe-entrypoint.md) | 中文

## Problem

在 pnpm 11 下，Windows、Linux 和 macOS 上的 `pnpm run build` 会失败：`scripts/build.ts` 和其他 package-script 启动器把 `process.env.npm_execpath` 当作 JavaScript 文件交给 `node`。pnpm 11 的 `@pnpm/exe` 布局把 `npm_execpath` 指到原生二进制（Windows 上是 `pnpm.exe`，Unix 上是 ELF `pnpm`）。Node 随后对 `.exe` 抛出 `ERR_UNKNOWN_FILE_EXTENSION`，或在 ELF 头上抛出 `SyntaxError: Invalid or unexpected token`。按源码安装路径克隆仓库的用户会在第一次 `pnpm run build` 撞上。

## Decision

`scripts/pnpm-invocation.ts` 是唯一解析器：以 `.js` / `.cjs` / `.mjs` 结尾的 `npm_execpath` 仍通过 `process.execPath` 运行；其他路径作为命令本身 spawn。`scripts/build.ts`、`scripts/run-gates.ts`、`scripts/run-web-snapshots.ts` 和 `scripts/coverage-partitions.ts` 都通过该 helper 启动子进程，并且保持无 shell。

## Alternatives considered

**始终把 `npm_execpath` 当作命令 spawn。** 否决：npm 7+ 仍把 `npm_execpath` 设为 `npm-cli.js`，Windows 无法在没有 Node 的情况下执行裸 `.js` 路径。

**始终运行 `node npm_execpath`。** 否决：这正是 pnpm 11 原生入口下失败的假设。

**使用 `shell: true` 让操作系统解析 `.cmd` / shebang / `.exe`。** 否决：它会改变每个宿主上的引号和元字符语义。

## Consequences

当 pnpm 11 提供原生 `npm_execpath` 时，从源码执行的 `pnpm run build` 可以工作。npm 的 JavaScript CLI 路径仍通过 Node 运行。Coverage 分片和 web snapshot worker 继承同一条 spawn 规则，因此 Windows 或 pnpm-11 CI 宿主不会在后续步骤以同样方式失败。

## Testing

`scripts/pnpm-invocation.spec.ts` 覆盖 JavaScript 启动器（包括 `.mjs` 和大小写混合的 `.CJS`）以及原生路径（无扩展名的 `pnpm`、`pnpm.exe`）。`scripts/coverage-partitions.spec.ts` 断言 `.cjs` 入口仍以 Node 为前缀，原生 `/tools/pnpm` 入口作为命令且 argv0 为 `exec`。
