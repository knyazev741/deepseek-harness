# Task 2 report: general Workspace contribution points

## Root cause

The upstream `ui-workspace` package owned the Workspace browser and row presentation but exposed no client service for list extensions and no row render slots. A plugin therefore had to replace the browser to add a filter, ordering rule, badge, or action. The extension patch adds those seams while keeping the upstream default path intact. Fork-specific behavior is not included.

## Implementation

- Added `ctx.workspaceContributions` with typed view, policy, and row-context contracts.
- View and policy entries are sorted by `(order, id)`, reject duplicate ids, publish stable observable snapshots, and are installed and removed through Cordis effects. A contributing fiber disposal removes its entries.
- Kept the browser's default view as an internal non-removable fallback. Contributed views render a tablist only when at least one view exists; the active view filters sessions, and every policy runs after filtering, including for the fallback.
- Added root list slots `workspace.session-row.badges` and `workspace.session-row.actions`. Rows receive the same session, Workspace, and selected context used by view and policy callbacks.
- Updated both README locales and re-recorded the translation-pair sidecar.

## Diff budget

Selected upstream parent: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (from `.fork/migration/upstream-commit`).

| Source file | Added | Deleted | Changed |
| --- | ---: | ---: | ---: |
| `src/client/WorkspaceBrowser.tsx` | 125 | 20 | 145 |
| `src/client/contract/contributions.ts` | 11 | 0 | 11 |
| `src/client/contract/slots.ts` | 15 | 2 | 17 |
| `src/client/contributions.ts` | 43 | 0 | 43 |
| `src/client/index.ts` | 22 | 2 | 24 |
| `src/client/rows/Rows.tsx` | 13 | 2 | 15 |
| **Total** | **229** | **26** | **255** |

The patch changes exactly six source files and stays below the 260-line source limit. The focused test adds 143 lines; README and translation-record changes are outside the source budget.

## Commands and results

- `pnpm exec vitest run packages/client/ui-workspace/tests/contributions.client.spec.tsx --reporter=dot` — PASS, 4 tests.
- `pnpm exec vitest run packages/client/ui-workspace --reporter=dot` — PASS, 9 files and 132 tests.
- `pnpm exec tsc -p packages/client/ui-workspace/tsconfig.json --noEmit` — PASS.
- `pnpm exec oxlint` on the six changed source files and the focused spec — PASS.
- `pnpm run verify-export-jsdoc` — PASS.
- `pnpm run test:gui` — PASS, 284 files (1 skipped), 3998 tests (4 skipped).
- `pnpm run verify-translation-pairing --write packages/client/ui-workspace/README.md` — PASS.
- `pnpm run verify-translation-pairing packages/client/ui-workspace/README.md` — PASS.
- `git diff --cached --check` — PASS.
- `DSH_SNAPSHOT=replay pnpm run test:web` — BLOCKED by the selected upstream baseline: the frontend build cannot load missing `packages/client/web/src/boot.tsx`; the path is absent in both `HEAD` and the selected upstream parent. The client library build completed before this unrelated frontend entrypoint failure.
- `pnpm run lint` — FAILS in the repository-wide contracts gate on existing `apps/cli` type-aware diagnostics; the changed ui-workspace files pass the direct Oxlint command above.

## Concerns

The throwing-predicate test intentionally emits React's error diagnostic stack while asserting that the callback error is surfaced; the test and GUI gate still exit successfully. The web replay result is not a product regression signal until the missing baseline frontend entrypoint is restored.

## Review fix round 1

### Root cause and fixes

The first extension pass supplied the filtered view snapshot to `SessionTree` and `FlatList`. Their existing persistence effects and drag commits therefore saw a partial account and could overwrite stored ordering with only the visible ids. The components now keep the full upstream session hook for effects, account reconciliation, and drag commits; only their render derivations use the active filtered snapshot. Hidden and stale ids remain in the account order while filtered rows are omitted from the DOM.

Policy comparison previously sorted raw account ids while looking up contexts in a filtered list. Missing contexts returned zero and prevented a policy from ordering the valid candidates. The comparator now receives only valid candidates from the render projection, while the mapping back to the original account sequence preserves excluded and stale positions. Callback errors remain uncaught and therefore surface to the caller or renderer.

The runtime rejects the browser-owned `workspace.default` id before registering a contributed view. The default tab remains the fallback when a contributed view is removed, and contributor tabs therefore cannot collide with the fallback key.

Added evidence covers zero-contributor DOM and account-order preservation, runtime-backed policy ordering with a stale Workspace id, comparator failure propagation, reserved-id rejection, and a contributor fiber composed through the real applied client service. An implemented bilingual Agent Note records the full-state/render-projection split, failure and lifetime rules, and the maintenance/retirement contract.

### Updated diff budget

Selected upstream parent remains `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. The implementation still changes exactly six `packages/client/ui-workspace/src` files:

| Source file | Added | Deleted | Changed |
| --- | ---: | ---: | ---: |
| `src/client/WorkspaceBrowser.tsx` | 126 | 24 | 150 |
| `src/client/contract/contributions.ts` | 11 | 0 | 11 |
| `src/client/contract/slots.ts` | 15 | 2 | 17 |
| `src/client/contributions.ts` | 43 | 0 | 43 |
| `src/client/index.ts` | 22 | 2 | 24 |
| `src/client/rows/Rows.tsx` | 13 | 2 | 15 |
| **Total** | **230** | **30** | **260** |

Tests, README updates, the report, and the bilingual Agent Note are outside this source budget.

### Review-fix commands and results

- `node_modules/.bin/vitest run packages/client/ui-workspace/tests/contributions.client.spec.tsx packages/client/ui-workspace/tests/apply.client.spec.ts` — PASS, 2 files and 14 tests. Expected React diagnostics from the comparator and predicate surfacing tests were emitted.
- `node_modules/.bin/vitest run packages/client/ui-workspace/tests` — PASS, 9 files and 136 tests.
- `pnpm exec tsc -p packages/client/ui-workspace/tsconfig.json --noEmit` — PASS.
- `pnpm exec oxlint` on the six changed source files plus `tests/contributions.client.spec.tsx` and `tests/apply.client.spec.ts` — PASS.
- `pnpm run verify-export-jsdoc` — PASS.
- `pnpm run verify-translation-pairing --write .agents/notes/implemented/architecture/2026-08-23-workspace-list-contributions.md` — PASS.
- `pnpm run verify-translation-pairing .agents/notes/implemented/architecture/2026-08-23-workspace-list-contributions.md` — PASS.
- `pnpm run verify-agent-note-format .agents/notes/implemented/architecture/2026-08-23-workspace-list-contributions.md` — PASS.

### Concerns

The focused callback-failure tests intentionally emit React error stacks while asserting that failures are surfaced; the test processes exit successfully. No fork UI behavior was changed.

## Review fix round 2

### Loader composition evidence

The prior applied-runtime test mounted `ctx.plugin` directly, so it did not prove the browser package entry can be composed through the repository's Cordis loader path. Added a static `cordis.yml` fixture with the real package id (`@deepseek-ai/dsh-client-ui-workspace`) and a test-only contributor id. The Loader resolves that config through `cordis:include`; the module table maps the package id to the package's public `/client` entry namespace, matching the client module system's bare-id convention rather than importing a `src` path. The test proves the runtime service publishes the contributor view, removes it when the contributor entry is removed, and tears down `workspaceContributions` when the composed root is disposed.

The source patch remains unchanged: six source files and exactly 260 changed source lines against the selected upstream parent. The new loader fixture and test are outside that budget.

### Review-fix commands and results

- `node_modules/.bin/vitest run packages/client/ui-workspace/tests/apply.client.spec.ts` — PASS, 1 file and 8 tests; includes the real Loader/cordis.yml composition test.
- `node_modules/.bin/vitest run packages/client/ui-workspace/tests` — PASS, 9 files and 137 tests. Expected comparator/predicate callback diagnostics were emitted while their surfacing assertions passed.
- `node_modules/.bin/tsc -p packages/client/ui-workspace/tsconfig.json --noEmit` — PASS.
- `node_modules/.bin/oxlint` on the six changed source files plus `tests/contributions.client.spec.tsx` and `tests/apply.client.spec.ts` — PASS.
- `pnpm run verify-export-jsdoc` — PASS.
- `pnpm run verify-translation-pairing packages/client/ui-workspace/README.md` — PASS.
- `pnpm run verify-translation-pairing .agents/notes/implemented/architecture/2026-08-23-workspace-list-contributions.md` — PASS.
- `pnpm run verify-agent-note-format .agents/notes/implemented/architecture/2026-08-23-workspace-list-contributions.md` — PASS.
- `BASE=b150a551b8d465e31e418e1b2eaf5e79bbb7d28e; git diff --numstat "$BASE" -- packages/client/ui-workspace/src` — PASS: six files, 230 additions and 30 deletions, 260 changed lines.
- `git diff --check HEAD` — PASS.

### Review-fix concerns

The Loader fixture intentionally uses the repository's package `/client` export as the module-table value while the config retains the bare package id used by browser boot; it does not exercise a built bundle transport. No fork UI behavior was changed.
