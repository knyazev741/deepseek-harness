# @deepseek-ai/dsh-client-ui-session-mode

English | [中文](README.zh.md)

Web new-session mode picker: the "模式" seat at session creation that chooses between the native DSH agent loop (`dsh`) and each registered external console agent (Codex, …), plus, when an external mode is selected, a model seat fed by that provider's model directory.

## Role

A client-only plugin. It consumes the host surface built by the external interactive-agent session feature:

- `session.create` accepts and validates `mode` at the host gate (task 3): absent/`dsh` creates the native agent loop; a registered external provider name creates a bare session stamped with `header.mode`, owned by the external-session-bridge driver.
- The external-session registry (`ctx.externalSessions`) answers the provider catalog (`listAgents`) and, per mode, the model directory (`listModels`), following the same per-session channel as `session.models`.

The picker is presentation over those surfaces: it renders the mode rows from the registry, enables a model seat for the selected external mode, and submits creation with `mode` + `model`.

## Model Experience

None, as this browser-side new-session mode picker renders no model-facing surface.

#### KV Cache effect

None; mode and model selection change host session metadata and external transcript presentation, not a parent model request.

## Known Limitations and Deferred Work

- **Provider-dependent rows** — an external mode appears only while its provider is registered in the current host composition.
- **Creation-time selection** — changing mode or model after creation uses the session APIs; the picker does not rewrite an existing session's durable driver identity.
