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
