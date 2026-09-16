---
description: "Fork distribution package ownership and configuration."
kind: "package-bundle"
---

# `@knyazevai/dsh-fork-web`

English | [中文](README.zh.md)

## Summary

The opt-in fork Web profile bundle. Apply it after the upstream [`dsh-base`](../base/README.md) and [`dsh-web-app`](../web-app/README.md) layers and [`dsh-fork-base`](../fork-base/README.md) to add the fork Workspace UI overlay without changing the upstream Web bundle.

## Table of Contents

- [Composition](#composition)
- [Mounted capability](#mounted-capability)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="composition"></a>
## Composition

The bundle patch is insert-only and mounts `ui-workspace-overlay` and `subagent-model-selection-settings` rows, for [`dsh-fork-ui-workspace-overlay`](../../fork/ui-workspace-overlay/README.md). The three Host fork rows remain owned by `dsh-fork-base`; this bundle does not duplicate or reconfigure them.

The shipped `fork-web` profile template layers `dsh-base`, `dsh-web-app`, `dsh-fork-base`, and `dsh-fork-web` in that order. The explicit `web` profile remains the upstream two-layer composition and contains no fork rows; the packaged `dsh web` alias selects `fork-web`.

<a id="mounted-capability"></a>
## Mounted capability

- [`fork-ui-workspace-overlay/`](../../fork/ui-workspace-overlay/README.md) contributes fork-only pin, unread, source-badge, and session-id actions through the upstream UI extension points. The `Background` Workspace view is not contributed while that feature is not ready, so only the built-in Workspaces view is shown.

The package has no runtime API of its own. Later profile patches can disable `ui-workspace-overlay` by id while retaining the upstream browser rows and Host fork rows.

The model-selection settings enable the four configured Gonka routes for per-call subagent selection. Existing user settings override these defaults.

<a id="model-experience"></a>
## Model Experience

### Workspace UI overlay

#### What the model sees

No prompt section, tool schema, message, or model request field is added. The mounted `ui-workspace-overlay` package changes browser presentation and user actions only.

#### Token effect

Zero direct token effect. Browser-only row actions do not add model input or output.

#### KV Cache effect

The overlay does not rewrite model requests or their prefixes, so it has no direct cache effect.

### Subagent model selection

#### What the model sees

Upstream subagent tools accept per-call provider and model selection from the configured Gonka route list. The selected route is validated before the child starts.

#### Token effect

The upstream tools own the selection argument schema. Choosing another model changes the child request route and its token limits.

#### KV Cache effect

A child using another provider or model cannot reuse the original route's provider cache. The browser overlay itself does not change prompt prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The bundle requires all four declared layers and the `fork-ui-workspace-overlay` package to be installed in the same profile resolution environment.
- The explicit `web` template intentionally excludes this bundle; deployments opt in by selecting the `fork-web` profile (or the packaged `dsh web` alias) or composing equivalent layers explicitly.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintenance context</summary>

Retain focused fork tests when adapting this package to upstream APIs. Configuration and behavior are documented above.

</details>
