# Agent Note: Opt-in Codex Web mode

Status: implemented

English | [中文](2026-08-20-opt-in-codex-web-mode.zh.md)

## Problem

The external Codex session provider can drive a durable session, but the shipped Web profile must not start a local app-server, disclose a mode that the deployment cannot use, or route external text through the native Agent command registry. A user also needs the selected mode to survive client list refreshes, creation frames, and reconnects.

## Decision

`@deepseek-ai/dsh-web-codex` is a separate profile patch layered after `dsh-base` and `dsh-web-app`. It mounts the external-session registry, permission bridge, Codex provider, session bridge, and MCP gateway exactly once; the default Web patch remains native-only. The patch contains no credentials and starts with an empty external-tool allowlist and bounded gateway request, response, permission, and process timeouts.

External providers expose a typed preflight result. The Host runs it before `session.externalModes` advertises a catalog and again before publishing an external session. Binary, authentication, configuration, and sandbox failures carry stable categories and leave no session row behind. Codex preflight probes the configured app-server account and model surface in a private temporary state root, then removes that probe root.

The browser stores the durable mode on each session object and list row. External text prompts and provider-owned slash lines use `api.sessions.command`; `/compact` and `/model` remain provider-specific host operations. Images, queue edits, steering, and native goal commands return explicit local errors without looking up a native Agent. A command that starts an external turn remains pending until the next durable `external/turn-ended` event.

## Alternatives considered

**Mount Codex in the default Web patch.** Rejected: installing a local external process and exposing an authenticated mode changes the security and dependency posture of every Web deployment. The opt-in bundle makes that choice explicit.

**Fall back to the native Agent when external routing is unavailable.** Rejected: this would make a durable external mode run under a different driver and could expose native tools or silently lose user input. The Host reports the typed failure instead.

**Send external plain prompts through the native command registry.** Rejected: external sessions deliberately have no native Agent. The dedicated `session.command` route preserves the provider's command namespace and avoids Agent lookup.

## Consequences

The local profile command is documented in the bundle README, and profile resolution fails loud when a required bundle dependency is absent. The Codex provider remains an explicit local-login product; credentials stay outside YAML, logs, events, URLs, and snapshots. Model-visible parent DSH requests are unchanged because the external transcript is projected from log-only events. Browser E2E, assembled transcript snapshots, and the final local authenticated acceptance proof remain Task 9 work.
