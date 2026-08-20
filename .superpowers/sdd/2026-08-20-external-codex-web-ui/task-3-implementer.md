# Task 3 implementer report — durable Codex session resume

Status: implemented

Commit: 830347e3517d682bfc4976b03149e204cedb6571

## RED

Before production changes, the focused test command was:

```text
pnpm exec vitest run packages/session/session-projection/tests/external-transcript.spec.ts packages/external/external-session/tests/service.spec.ts packages/external/external-session-bridge/tests/driver.spec.ts --reporter=verbose
```

The new tests failed as intended: `service.resume is not a function`, the projection did not retain `providerThreadId`, and the cold bridge resume test could not materialize the persisted session. This established the missing contract and lifecycle behavior before implementation.

## GREEN

The implementation now:

- records the opaque provider thread id only after successful `thread/start`, preserves it in replay projection state, and leaves it out of transcript turns;
- exposes distinct provider and registry `resume` APIs, with no start fallback;
- deduplicates concurrent start/resume attachment, publishes the in-flight promise before provider work, and rolls back routes, disposal signals, and provider ownership on rejection;
- resumes cold sessions through `SessionPersistence.prepare`, `SessionStore.enter`, and `SessionStore.announce`, with process-free history/list reads and one bridge/service resume;
- routes external prompt, command, model, model-list, and cancel actions through the cold attachment gate;
- preserves Task 2 child settlement, generation, quiescence, and same-provider respawn behavior.

Focused green evidence:

```text
pnpm exec vitest run packages/session/session-projection/tests/external-transcript.spec.ts packages/external/external-session/tests/service.spec.ts packages/external/external-session-bridge/tests/driver.spec.ts packages/host/apiproxy/tests/api-proxy-external-command.spec.ts packages/host/apiproxy/tests/api-proxy-mode.spec.ts --reporter=verbose
5 files passed, 44 tests passed

pnpm exec vitest run packages/external/external-session-codex/tests/external-session-codex.spec.ts packages/external/external-session-codex/tests/unit.spec.ts --reporter=verbose
2 files passed, 35 tests passed
```

The real Codex fixture test starts one durable thread, disposes the provider session, explicitly resumes the captured id, verifies only one `external/session-started`, and proves the second turn sees the first turn's history.

Typecheck evidence:

```text
pnpm exec tsc -b packages/session/session-projection/tsconfig.json packages/external/external-session/tsconfig.json packages/external/external-session-codex/tsconfig.json packages/external/external-session-bridge/tsconfig.json packages/host/apiproxy/tsconfig.json --pretty false
```

## Documentation

Updated English/Chinese README pairs and pairing hashes for external-session, external-session-bridge, external-session-codex, host-apiproxy, and session-projection. Updated the implemented Phase 1 Agent Note in both languages. `verify-translation-pairing` passed for all six edited pairs; Agent Note classification/format, relative links, document references, and budgets also passed. The repository-wide markdown-wrap gate still reports a pre-existing hard-wrapped paragraph in `.agents/notes/proposed/feature/2026-08-18-external-interactive-agent-sessions.md`.

## Risks and follow-up

- The provider thread id is intentionally opaque and remains a plain durable string because the Task 3 public event and resume contracts specify that field; providers remain authoritative for unknown-id rejection.
- External prompt input is text-only for this task; image/queue UI behavior remains an explicit later-phase limitation.
- Live delta muxing, MCP, bundle composition, and browser acceptance remain outside Task 3.
