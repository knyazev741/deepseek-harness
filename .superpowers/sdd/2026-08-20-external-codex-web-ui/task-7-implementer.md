# Task 7 implementer report

## RED

- `pnpm exec vitest run packages/mcp/mcp-gateway/tests/gateway.spec.ts --config vitest.config.ts --reporter=dot --maxWorkers=1` failed because `packages/mcp/mcp-gateway/src/index.ts` did not exist (`Cannot find module '../src/index.ts'`).
- After the test-only package manifest and fixture were present, the same focused test failed because `McpGateway` had no static injection for `webServer` (`cannot get property "webServer" without inject`).

## GREEN

- `pnpm exec vitest run packages/mcp/mcp-gateway/tests/gateway.spec.ts packages/mcp/mcp-gateway/tests/loader-composition.spec.ts packages/external/external-session-codex/tests/unit.spec.ts packages/core/tools/tests/tools.spec.ts packages/core/tools/tests/scoped.spec.ts --config vitest.config.ts --reporter=dot --maxWorkers=1` — 5 files and 190 tests passed.
- `pnpm exec tsc -b packages/mcp/mcp-gateway/tsconfig.json packages/external/external-session-codex/tsconfig.json --pretty false && pnpm exec tsc -p packages/core/tools/tsconfig.json --noEmit --pretty false` — passed.
- `pnpm exec tsc -p tsconfig.host.json --pretty false` — passed.
- `pnpm exec oxlint packages/mcp/mcp-gateway/src packages/mcp/mcp-gateway/tests` — passed.
- `pnpm run verify-cordis-catalog`, `pnpm run verify-config-catalog`, `pnpm run verify-package-invariants`, `pnpm run verify-doc-refs`, `pnpm run verify-md-links`, `pnpm run verify-package-paths`, `pnpm run verify-config-source-ownership`, `pnpm run verify-node-next-types`, and `pnpm run constraints` — passed.
- The pre-commit hook passed staged translation pairing, staged lint, third-party notices, whitespace, and vendor manifest checks.

## SHA

Feature commit: `86a7e0b613a1d220f0764a7f9b12a1cfe4995d43` (`feat(mcp): expose allowlisted Harness tools`).

## Risks

- Streamable HTTP remains one stateful MCP route per attachment; resources, prompts, client routing, and the opt-in Web bundle remain out of scope.
- Tool cancellation is cooperative and depends on implementations reaching quiescence after the gateway deadline or lease disposal.
- The Codex TOML updater replaces the named Harness MCP section and deliberately does not remove private rollout files.
- Repository-wide `pnpm run typecheck` and `pnpm run lint` still report unrelated pre-existing Client/Task 2–6 diagnostics; the new gateway package has a clean focused lint/typecheck. `verify-runtime-closure`, `publint`, and the corpus-wide translation/doc checks likewise retain pre-existing repository failures.
