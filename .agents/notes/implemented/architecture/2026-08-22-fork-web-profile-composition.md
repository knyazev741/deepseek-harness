# Agent Note: Fork Web profile composition

Status: implemented

English | [中文](2026-08-22-fork-web-profile-composition.zh.md)

## Problem

The upstream Web profile and the fork Host capabilities need independent ownership. Adding fork rows or portable provider defaults to upstream bundles would make the default browser surface opt into fork behavior and would make later profile patches unable to distinguish Host rows from the Workspace UI overlay.

## Decision

The shipped `fork-web` profile template layers `@knyazevai/dsh-base`, `@knyazevai/dsh-web-app`, `@knyazevai/dsh-fork-base`, and `@knyazevai/dsh-fork-web` in that order. The `dsh-fork-web` patch contains one `insert` row for `ui-workspace-overlay`; `dsh-fork-base` first inserts the session source identity, workspace-session state, and first-chunk timeout rows, then overrides the upstream `llm-pi-ai` and `agent-default-model` configs with portable Knyazev AI defaults and the `knyazev-ai/deepseek-v4-flash` selection. The provider stores only the external `KNYAZEV_AI_API_KEY` reference, and the user settings layer remains above these composition defaults. The `web` template remains the two upstream layers and contains no fork rows. The repository-local `pnpm dsh web` launcher and the packaged CLI's `dsh web` alias select `fork-web`; explicit `pnpm dsh --profile web` remains the upstream-only template.

The CLI declares both fork bundles as installation dependencies, so `healProfilesModuleFallback` traverses their transitive plugin closure and an empty `$DSH_HOME` can resolve `fork-web` without profile-local links or an existing settings document. The built CLI dump regression covers that clean-install path; a Loader test covers the settings file's partial provider/default overlay separately because config dumps do not evaluate the runtime settings seam.

The composition tests parse and apply the actual bundle patch files, asserting unique fork rows, portable model/default selection, no secret literal, and later id-targeted replacement behavior. The profile test pins both template tuples so a future edit cannot silently make the default Web profile fork-enabled or reorder the opt-in layers. The repository launcher test runs `pnpm dsh web --dump-default-config` and requires the fork bundle, while the built CLI test runs `fork-web --dump-default-config` from an empty harness home. The Loader test writes a partial settings document and asserts the user values over the portable base.

## Alternatives considered

**Add the Workspace UI row to `dsh-web-app`.** This loses opt-in behavior because every default Web profile receives fork presentation and makes the upstream bundle own a fork package.

**Add all fork Host and UI rows to `dsh-fork-web`.** This duplicates Host ownership already provided by `dsh-fork-base` and permits duplicate Loader rows when both layers are composed.

**Replace the upstream Web patch with a fork-specific copy.** This expands the upstream template diff and allows upstream UI identities or configuration to drift; an additive one-row patch keeps the upstream layer authoritative.

**Keep the Knyazev AI defaults only in the user settings document.** This leaves a fresh `fork-web` home dormant or dependent on an existing `~/.dsh/settings.yaml`, so the distribution cannot provide a reproducible model route.

**Commit the Knyazev AI key in the bundle.** This would turn a distribution default into a repository secret and make rotation or deployment-specific credentials unsafe; the bundle carries only the `apiKeyEnv` reference.

## Consequences

The explicit `web` profile template remains upstream-only, while `fork-web` is a complete opt-in composition with explicit CLI installation dependencies and a portable Knyazev AI route even without a pre-existing settings file. The packaged CLI's `dsh web` alias selects that fork composition. User settings can override provider fields or the default model, and later profile/home/`--patch` layers can replace targeted plugin configs wholesale. A missing `KNYAZEV_AI_API_KEY` remains an external credential failure rather than a committed value. Deployments can disable the UI overlay by id without changing Host fork rows. The profile requires the four bundle packages and the UI overlay package to resolve from the same installation dependency graph; out-of-tree profile bundles continue to use the profile's pnpm-managed directory.
