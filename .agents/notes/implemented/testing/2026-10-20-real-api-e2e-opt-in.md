# Agent Note: Repository opt-in for automatic real-API e2e

Status: implemented

English | [中文](2026-10-20-real-api-e2e-opt-in.zh.md)

## Problem

Forks inherit workflows without the upstream repository's API credentials. Automatic live-API runs then fail at credential preflight before any test executes, obscuring the distinction between an unconfigured integration and a product regression. API spending also requires the repository owner's choice.

## Decision

[e2e.yml](../../../../.github/workflows/e2e.yml) runs automatically only when the Actions repository variable `DSH_REAL_API_E2E_ENABLED` equals `true`. Owners first configure the Actions secret `DEEPSEEK_API_KEY_EXTERNAL`, then enable that variable. Unset or other values skip the whole job before runner allocation. `workflow_dispatch` permits an explicit run independently of the variable.

This replaces the automatic-run default in the [real-API CI decision](2026-06-19-real-api-e2e-ci.md); that note retains ownership of credential isolation and the trusted-PR policy. Fork and Dependabot PRs remain skipped even when automatic runs are enabled. An enabled or manually requested run still fails if its key is missing, and test failures remain failures.

## Alternatives considered

**Keep automatic runs enabled without configuration.** Credential failures provide no product evidence on repositories that have never configured this integration.

**Silently pass a keyless test suite.** This would conceal a deleted or renamed key after an owner enables live-API coverage. Explicit opt-in preserves the mandatory preflight.

## Consequences

Unconfigured repositories receive skipped checks rather than credential failures. Automatic live-API coverage requires the repository variable as well as the secret; maintainers must enable both before relying on that coverage. Keyless checks and npm publication retain their existing policies. [Workflow tests](../../../../scripts/ci-workflow.spec.ts) evaluate automatic/manual selection and the fork/Dependabot restrictions.
