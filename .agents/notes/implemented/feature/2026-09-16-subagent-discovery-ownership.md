# Agent Note: Separate subagent discovery ownership

Status: implemented

English | [中文](2026-09-16-subagent-discovery-ownership.zh.md)

## Problem

The fork presets enable model selection for both spawn and fork. Each instance registering `list_subagent_models` makes new Session creation fail with a duplicate tool name.

## Decision

`modelSelectionDiscovery` defaults to true. The primary delegation tool owns discovery; sibling fork tools set it to false while retaining the same recorded route policy and model-selection arguments. The registry still rejects two discovery owners. This supersedes the shipped fork-selection restriction in [model-selected routes](2026-08-18-model-selected-subagent-routes.md).

## Alternatives considered

**Disable fork model selection.** This removes a requested fork capability. Explicit route changes remain permitted, with the existing warning about inherited-prefix cache reuse.

**Silently skip duplicate registrations.** This makes discovery depend on load and disposal order. Explicit ownership preserves normal Cordis registration cleanup and duplicate diagnostics.

## Consequences

Both delegation tools can select authorized models while one discovery definition serves the Session. Custom compositions must keep one owner. Package tests exercise repeated Session creation; the shipped fork-Web process test covers Standard, PTC, and Cordis through the real create endpoint.
