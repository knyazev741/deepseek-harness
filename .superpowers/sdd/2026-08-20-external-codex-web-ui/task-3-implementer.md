# Task 3 implementer report — durable Codex session resume

Status: implemented

Implementation commit: `62b22b16f27ac70eb218ffa4d0e4bc0ecb38fc9d`

Report-only commit: follows the implementation commit so this report can record its exact implementation SHA.

## RED

- I-1 added external `session.models` provider-catalog and catalog-failure tests. Before the fix, the route read native `ctx.llm` rows instead of the external provider.
- I-2 added a keyless restart test that writes through the actual JSONL persistence owner, disposes the first Loader composition, creates a fresh Loader composition over the same root, proves list/history are process-free, then spies on `prepare`/`enter`/`announce` and the first live command. The first RED run exposed that JSONL headers dropped durable external `mode`; the header codec now carries `mode` and `model`.
- I-3 added the branded `ExternalProviderThreadId` constructor/parser test. The pre-fix contracts accepted an unbranded `string` through the durable event, projection, bridge, host, registry, and Codex provider.
- I-4 ran the owning persistence catalog generator. Before regeneration, the generated catalog and `KNOWN_SESSION_EVENT_TYPES` rejected replay of the external event family.
- M-1 added a real keyless Codex negative test using a syntactically valid but unknown thread id. It asserts rejection, route rollback, no replacement start, and a readable durable log.

## GREEN

- A successful Codex `thread/start` now returns a branded opaque id and only then appends `external/session-started`; explicit resume accepts only that branded id and never falls back to start.
- Durable replay and projection retain the provider id for host attachment while transcript turns and renderable transcript content never include it. Durable and wire parsing/branding occurs at the untyped boundary.
- External `session.models` calls the selected provider's `listModels` and returns only that provider's catalog, or a typed provider failure without native rows.
- Cold external actions inspect/list/history without attachment. The first live action shares one in-flight attach promise, materializes through `SessionPersistence.prepare`, `SessionStore.enter`, and `SessionStore.announce`, and performs exactly one provider resume. Failed attachment removes the route, aborts the bridge, disposes provider ownership, and leaves the durable log readable.
- Task 2 process settlement, generation, quiescence, and same-provider respawn behavior remain covered by the existing Codex suite.

Focused green evidence:

```text
pnpm exec vitest run packages/session/session-persistence-jsonl/tests/jsonl.spec.ts packages/session/session-persistence-jsonl/tests/zstd.spec.ts --reporter=verbose
2 files passed, 232 tests passed

pnpm exec vitest run packages/session/session-projection/tests/external-transcript.spec.ts packages/external/external-session/tests/service.spec.ts packages/external/external-session-bridge/tests/driver.spec.ts packages/external/external-session-bridge/tests/loader-composition.spec.ts packages/host/apiproxy/tests/api-proxy-external-command.spec.ts packages/host/apiproxy/tests/api-proxy-mode.spec.ts --reporter=dot
6 files passed, 51 tests passed

pnpm exec vitest run packages/external/external-session-codex/tests/external-session-codex.spec.ts packages/external/external-session-codex/tests/unit.spec.ts --reporter=dot
2 files passed, 36 tests passed

pnpm exec tsc -b packages/external/external-session/tsconfig.json packages/session/session-projection/tsconfig.json packages/external/external-session-codex/tsconfig.json packages/external/external-session-bridge/tsconfig.json packages/host/apiproxy/tsconfig.json packages/session/session-persistence-jsonl/tsconfig.json --pretty false
passed

pnpm run verify-persistence-catalog
catalog and packages/core/session/src/known-event-types.ts are up to date
```

## Documentation

Updated the session subsystem and persistence catalog in English and Chinese, including generated `docs/persistence-catalog.md` and `packages/core/session/src/known-event-types.ts`. Paired README/JSDoc changes cover external-session, external-session-codex, session-persistence, session-persistence-jsonl, session-projection, and the implemented Phase 1 Agent Note, with updated i18n records. The JSONL README documents durable external `mode`/`model` header fields and the external-session README documents branded opaque thread identities.

`verify-doc-budgets`, Agent Note format/classification, and relative markdown-link checks pass. Full `verify-translation-pairing` remains blocked by the repository's existing out-of-scope design/spec bilingual counterparts, proposed-note drift, `docs/config-catalog.md`, `packages/README.md`, and `packages/external/README*` drift. `verify-md-wrap` reports the pre-existing hard-wrapped paragraph in `.agents/notes/proposed/feature/2026-08-18-external-interactive-agent-sessions.md`; no new wrap was introduced here. `verify-type-equiv` retains the pre-existing `SessionHeader`/`CreateSessionOptions` drift in `docs/subsystems/persistence.md`.

## Risks and scope

- Provider thread ids remain opaque provider-owned strings at runtime; the public seam, durable event, projection, host, bridge, registry, and provider use `ExternalProviderThreadId`, with parser/constructor use at durable or trusted-wire boundaries.
- Unknown provider ids remain provider-authoritative: Codex rejects them and the registry removes the failed route without creating a replacement thread.
- Live delta muxing, MCP, bundle composition, and browser acceptance remain outside Task 3.
