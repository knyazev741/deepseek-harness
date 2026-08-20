# Agent Note: Command Remote argument synchronization

Status: implemented

English | [中文](2026-08-20-command-remote-argument-sync.zh.md)

## Problem

The command executor's Host signature gained a required `images` business parameter before its reserved cancellation `signal`, but the Client callers and generated Host-for-Client artifacts were not updated together. The stale descriptor exposed `execute(agentId, line, signal?)`, so the Gateway appended its carrier signal as the third positional argument to `CommandRuntime.execute(agent, line, images, signal)`. The executor then read `signal.aborted` from `undefined`, and the UI surfaced `command.execute failed` before `/compact` reached its handler. Direct Host tests passed because they already supplied `[]`; only the assembled Remote path exposed the mismatch.

The image-envelope decision remains owned by the [command image-attachment envelope note](../feature/2026-08-17-command-image-attachment-envelope.md). This note records the cross-plane synchronization required when that shared method signature changes.

## Decision

`images` remains a required business parameter of `CommandRuntime.execute`; a plain command invocation explicitly supplies `[]`. Every current Client caller — the command composer, the Session convenience method, and the plan control — now passes that empty batch, and the fixture endpoint accepts and forwards the same optional wire field.

Typert's Host reflection, Host-for-Client Remote projection, and the assembled `api-remotes` Client bundle are one generated set. They must be regenerated from the Host source before Client consumers compile or bundle. The generated descriptor therefore lists `images` in `parameters` and keeps `signal` only in `cancellation`; no Gateway compatibility branch or positional fallback is added. This follows the [Typert Remote method-call decision](../architecture/2026-08-02-typert-remote-method-calls.md) and its [ordered generated-contract build](../process/2026-08-08-api-remotes-generated-contract-build.md).

The built-library regression invokes `/compact` through the generated Client Remote, the real HTTP `/api` route, the Host Gateway, and `CommandRuntime`, so a stale positional descriptor cannot hide behind direct service tests.

## Alternatives considered

**Remove `images` from the Host method or make the cancellation argument tolerant.** Rejected: it would discard the shipped image-envelope contract or hide missing generated parameters, and future image-bearing commands would fail at the same seam.

**Add a Gateway compatibility shim that detects the old arity.** Rejected: the pre-release repository has no compatibility promise for stale generated artifacts, and a fallback would allow source and published descriptors to drift silently instead of making the build dependency visible.

**Update only the `/compact` UI call.** Rejected: the Remote signature is shared by every command caller, including plan controls, Session helpers, fixtures, and future plain invocations; leaving any old call preserves the same positional defect.

## Consequences

Plain command callers state the complete business envelope even when it is empty. A caller that has images must pass the encoded image array in the same position; it must not pass a cancellation signal as the third argument. Generated `lib` artifacts remain derived files, so a clean or production build must run the Host Typert pass before the Client pass. The regression now covers the user-visible `/compact` route in addition to direct command and compaction tests.

## Testing

The new UI regression first failed with received `undefined` instead of `[]`, then passed after the caller update. Targeted Client TypeScript projects compile; the focused suite passes 207 tests across command UI, fixture Remote, Session, plan, command registry, and compaction packages. The built-library HTTP Remote test passes with `/compact` returning success and its two lifecycle events.
