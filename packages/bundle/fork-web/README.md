# `@deepseek-ai/dsh-fork-web`

English | [中文](README.zh.md)

The opt-in fork Web profile bundle. Apply it after the upstream [`dsh-base`](../base/README.md) and [`dsh-web-app`](../web-app/README.md) layers and [`dsh-fork-base`](../fork-base/README.md) to add the fork Workspace UI overlay without changing the upstream Web bundle.

## Composition

The bundle patch is insert-only and mounts one row, `ui-workspace-overlay`, for [`dsh-fork-ui-workspace-overlay`](../../fork/ui-workspace-overlay/README.md). The three Host fork rows remain owned by `dsh-fork-base`; this bundle does not duplicate or reconfigure them.

The shipped `fork-web` profile template layers `dsh-base`, `dsh-web-app`, `dsh-fork-base`, and `dsh-fork-web` in that order. The default `web` profile remains the upstream two-layer composition and contains no fork rows.

## Mounted capability

- [`fork-ui-workspace-overlay/`](../../fork/ui-workspace-overlay/README.md) contributes fork-only pin, unread, source-badge, and session-id actions through the upstream UI extension points. The `Background` Workspace view is not contributed while that feature is not ready, so only the built-in Workspaces view is shown.

The package has no runtime API of its own. Later profile patches can disable `ui-workspace-overlay` by id while retaining the upstream browser rows and Host fork rows.

## Model Experience

### Workspace UI overlay

#### What the model sees

No prompt section, tool schema, message, or model request field is added. The mounted `ui-workspace-overlay` package changes browser presentation and user actions only.

#### Token effect

Zero direct token effect. Browser-only row actions do not add model input or output.

#### KV Cache effect

The overlay does not rewrite model requests or their prefixes, so it has no direct cache effect.

## Known Limitations and Deferred Work

- The bundle requires all four declared layers and the `fork-ui-workspace-overlay` package to be installed in the same profile resolution environment.
- The default `web` template intentionally excludes this bundle; deployments opt in by selecting the `fork-web` profile or composing equivalent layers explicitly.
