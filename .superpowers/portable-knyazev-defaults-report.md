# Portable Knyazev AI defaults report

## RED

`pnpm exec vitest run packages/bundle/fork-base/tests/fork-base.spec.ts` was run after changing the test and before changing `cordis.patch.yml`. It failed as expected: 2 tests failed and 2 passed because the patch still had one row group instead of three patch entries, and the composed `llm-pi-ai` row had no portable provider config.

## GREEN

- `pnpm exec vitest run packages/bundle/fork-base/tests/fork-base.spec.ts` — 4 tests passed.
- `pnpm exec vitest run packages/bundle/fork-base/tests/fork-base.spec.ts packages/bundle/fork-web/tests/fork-web.spec.ts packages/boot/app-boot/tests/profile.spec.ts` — 22 tests passed.
- `pnpm exec vitest run packages/llm/llm-pi-ai/tests/config.spec.ts` — 10 tests passed.
- The built `@deepseek-ai/dsh-llm-pi-ai` `assertServiceable` check over the composed route — PASS.
- Keyless `fork-web --dump-default-config` smoke from a temporary profile home with local fork bundle links — PASS; both id-targeted rows and portable route values appeared in the assembled dump.
- `pnpm run verify-cordis-config` — 134 config files passed.
- `pnpm exec tsc -p packages/bundle/fork-base/tsconfig.json --noEmit` — PASS.
- `pnpm exec oxlint packages/bundle/fork-base` — PASS.
- Scoped translation pairing, `verify-md-wrap`, `verify-doc-budgets`, `verify-agent-note-format`, and `git diff --check` — PASS.

## Changed files

- `packages/bundle/fork-base/cordis.patch.yml`
- `packages/bundle/fork-base/tests/fork-base.spec.ts`
- `packages/bundle/fork-base/package.json`
- `packages/bundle/fork-base/src/invariant.ts`
- `packages/bundle/fork-base/README.md`
- `packages/bundle/fork-base/README.zh.md`
- `packages/bundle/fork-base/README.i18n.yaml`
- `.agents/notes/implemented/architecture/2026-08-22-fork-web-profile-composition.md`
- `.agents/notes/implemented/architecture/2026-08-22-fork-web-profile-composition.zh.md`
- `.agents/notes/implemented/architecture/2026-08-22-fork-web-profile-composition.i18n.yaml`
- `.superpowers/portable-knyazev-defaults-report.md`

## Architectural decisions

`dsh-fork-base` first inserts its three fork-owned plugin rows, then id-targeted replaces the upstream `llm-pi-ai` and `agent-default-model` configs. The route carries the exact Knyazev AI endpoint, protocol, timeout, model, reasoning, and ordered normal retry defaults; the default selection is `knyazev-ai/deepseek-v4-flash` without a composition `reasoningEffort`. Only `apiKeyEnv: KNYAZEV_AI_API_KEY` is committed. The settings seam remains above the composition base, while profile/home/`--patch` rows can replace targeted configs wholesale.

## Omissions and concerns

`.fork/features.yaml` was not changed because repository history did not expose a real historical source commit for these portable defaults; inventing an inventory source would be incorrect.

`pnpm run doc-sync` completed 26 gates and reported two unrelated baseline failures: existing type-equivalence drift and existing documentation code-block type errors. `pnpm run verify-package-invariants` also reports two unrelated pre-existing missing explanations in `packages/bundle/fork-web/src/invariant.ts` and `packages/fork/ui-workspace-overlay/src/invariant.ts`; the fork-base invariant remains clean. No secret value was read or added.

## Commit SHA

This report is committed atomically with the implementation. The final hexadecimal SHA is returned in the handoff; resolve it in this checkout with `git rev-parse HEAD`.
