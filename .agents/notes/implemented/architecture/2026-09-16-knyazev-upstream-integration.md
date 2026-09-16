# Agent Note: Preserve the Knyazev distribution on the September upstream

Status: implemented

English | [中文](2026-09-16-knyazev-upstream-integration.zh.md)

## Problem

The public Knyazev distribution needs upstream session, client, and CLI changes without losing its Gonka routes, recovery policies, workspace plugins, or historical sessions. Package scope changes obscure the functional differences, and retaining every conflicting fork hunk would retain obsolete upstream implementations.

## Decision

Use upstream `0.1.6-alpha.1` as the implementation base and preserve the fork master containing the GLM and React test fixes as the other merge parent. Port functional differences explicitly, then rescope current DSH packages to `@knyazevai/dsh`. Vendored libraries keep their existing names. The released upstream event inventories remain frozen; a separate audited fork event inventory admits only the coordinate-free `fork/session-source` marker during historical migration and validates its exact payload.

Keep the first-chunk timeout, compaction recovery, exhausted-budget cooldown, session source, pin persistence, and workspace UI packages. The new Session Controller supplies projection sequence watermarks for unread state and retires queued messages when they become durable. Workspace contributions integrate with the current row slots and retain upstream navigation, pending-interaction indicators, and drag ordering. The previously deferred Background tab remains absent; the extension registry supports contributed views.

DeepSeek V4 Flash and GLM 5.3 Flash use their shipped 400,000-token context, 20 transient retries, 50% compaction pressure, and 131,072-token summary input budget. The standard, ptc, and cordis presets retain two compaction and overflow retries. The original model-selection service supplies allowed Gonka routes for spawn and fork delegation. Existing user settings still override deployment defaults. GLM advertises only `low`, `high`, and `max`, with a model-level OpenAI effort dialect so the shared Qwen on/off configuration cannot suppress its selected depth. Saved model entries require the same metadata; the live file settings watcher applies that correction without restarting active Sessions.

The repository launcher calls the current CLI's exported entry explicitly. `dsh web` selects `fork-web`; explicit `--profile web` retains the original composition. Browser opening is opt-in through `--open`. The npm package remains the complete CLI, distinct from the legacy provider-only plugin.

## Alternatives considered

A blanket conflict preference would discard either upstream behavior or fork behavior. Replaying thousands of package-name edits before functional adaptation would obscure moved packages and newly introduced protocols. Copying old client code would discard the new Session Controller, navigation service, and interaction state. Treating all ignorable historical events as safe to migrate would permit unknown embedded sequence coordinates; only the audited fork marker is admitted.

## Consequences

Both histories remain available for future merge bases. Future updates must validate fork recovery, composition, installation, and historical-session tests alongside upstream checks. The event marker keeps its data and ignorable flag across formats 0, 1, and 2 into format 3, while historical code presets migrate to ptc. The current source version follows upstream's prerelease version; source integration alone does not publish a new npm release.
