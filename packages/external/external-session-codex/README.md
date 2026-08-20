# @deepseek-ai/dsh-external-session-codex

English | [中文](README.zh.md)

Persistent Codex external-agent session provider. Registers the `codex` mode on [`ctx.externalSessions`](../external-session/README.md): each accepted session spawns the packaged `@openai/codex@0.147.0` app-server unless an explicit command override is configured, opens one non-ephemeral thread in the session workspace, and then serves repeated prompts on that thread. Live assistant text streams out through the per-session bridge's `streamDelta`; committed messages, tool activity, approval asks, and terminal stop reasons are recorded as log-only `external/*` session events; compact runs through the dedicated `thread/compact/start` method; and an unexpected app-server death settles the active turn before the child tree is reaped and the same provider instance respawns with its in-memory thread id. A cold Harness session resumes its opaque durable provider-thread id through explicit `resume` and `thread/resume`; a failed resume never creates a replacement thread. The one-shot sibling [`@deepseek-ai/dsh-subagent-codex`](../../subagent/subagent-codex/README.md) drives its own ephemeral thread; this provider is the interactive, persistent counterpart.

## Start and ownership

`start(request)` publishes a cancellable provider lifecycle record before its first asynchronous state-root operation, resolves the session's sandbox and approval folds, creates its private Codex state directory, and spawns the app-server through [`dsh-subprocess`](../../subprocess/subprocess/README.md) under the session workspace. Disposal cancels that record and waits for startup rollback before returning, so a child cannot spawn after the route is disposed. It performs `initialize` → `initialized` → `thread/start { cwd, ephemeral: false, model?, sandbox, approvalPolicy }` and retains the non-ephemeral thread id for this provider instance. The provider emits `external/session-started` once the thread exists.

`resume(request, providerThreadId)` publishes the same lifecycle but performs `initialize` → `initialized` → `thread/resume { threadId, model?, sandbox, approvalPolicy }`. It requires the persisted opaque id and emits no new `external/session-started`; a missing or unknown id rejects without falling back to `thread/start`. The host materializes a cold session with `SessionPersistence.prepare`, `SessionStore.enter`, and `SessionStore.announce` only when a live operation needs the provider.

`prompt(text)` runs turns strictly serially: it awaits the prior turn's `turn/completed` terminal notification, submits the next `turn/start` on the same thread, and returns the provider-issued turn id immediately. The turn then streams to completion asynchronously: `item/agentMessage/delta` is forwarded to `streamDelta` (live only, never durable), a completed `agentMessage` is committed as `external/message-added { role: 'agent' }`, the submitted prompt as `{ role: 'user' }`, `commandExecution` items as `external/tool-activity { kind: 'call' | 'result' }`, and the terminal `turn/completed` as `external/turn-ended` (`completed` / `aborted` / `error` / `max-tokens`). `interrupt()` sends a best-effort `turn/interrupt`, whose interrupted terminal maps to `aborted`.

Approval asks arrive as `item/commandExecution/requestApproval`. The provider emits `external/permission-asked`, consults the bridge's `requestPermission` (the ask-user permission channel), maps the human's `allowed` / `rejected` / `cancelled` decision onto the wire's `accept` / `decline` / `cancel`, answers the request, and records `external/permission-decided`. A failed, unwired, or dismissing permission channel fails closed to the safest offered decision and `cancelled`.

`compact()` calls the dedicated `thread/compact/start` and records `external/compaction-noticed`; compaction then runs as a background turn on the normal notification path.

When the app-server child dies mid-session, the provider records the active turn as `error`, closes its listeners, waits for the old child tree to settle, and the next operation spawns a fresh child and resumes the in-memory thread id with `thread/resume` (same-process child respawn; protocol evidence `thread-persistence.json`). The same explicit resume path accepts a durable id after a Harness restart. `dispose()` records `external/session-ended` for an attached live session, cancels pending approvals without late decisions, interrupts any active turn, closes the wire, and runs the whole-tree termination ladder (stdin EOF grace, then the shared process-tree SIGTERM → grace → SIGKILL escalation); a cleanup failure remains on the quiescence barrier and blocks respawn.

## Model listing and switching

Evidence confirms native `model/list` exists in 0.147.0 (`models.json`), so the provider answers `listModels` from the live wire's native catalog and advertises `modelDirectory: 'provider'`; no fallback roster config is used. When no session is live, `listModels` runs a short-lived wire against the deployment working directory (the catalog is local, so the workspace is immaterial).

`setModel` refreshes the native `model/list` catalog when needed, rejects an identifier that is not listed, then stores the accepted model and optional reasoning effort for the next turn, records `external/model-switched`, and sends the stable `model` field on the next `turn/start` (`effort` carries reasoning effort). Initial settings are also sent on `thread/start` and `thread/resume`; no experimental app-server API is used.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `command` | packaged `@openai/codex` | Optional app-server command or path override; the packaged launcher is resolved directly and never shell-interpreted (explicit Windows overrides use `cmd.exe /d /s /c`). |
| `args` | `["app-server", "--stdio"]` | App-server arguments; an empty string fails load. |
| `env` | `{}` | Explicit child environment layered over the subprocess seam's credential-scrubbed parent environment. |
| `stateRoot` | temporary Harness-owned root | Root under which each session receives a private hashed Codex state directory, exported as that child’s `CODEX_HOME`. |
| `reasoningEffort` | unset | Optional initial stable reasoning effort; per-session selection may replace it for the next turn. |
| `sandbox` / `approvalPolicy` | `read-only` / `ask` | Resolved from the session start request and folded session policy; Codex receives `read-only` / `workspace-write` / `danger-full-access` and `on-request` / `never`. |
| `disposeGraceMs` | `3000` | Positive finite grace in milliseconds, no greater than [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md), between the shared process-tree owner's termination tiers. |

Production uses the pinned packaged launcher unless `command` is explicitly configured. The plugin does not log in or probe a version. Credential-shaped ambient variables are removed by the subprocess seam, so an API key intended for the child must be supplied explicitly in `env`; ordinary ambient values such as `PATH` and `HOME` remain available unless overridden. Restricted modes pass the exact launcher argv and `{ ...sandboxPolicy, stateRoot }` through `ctx.sandbox.confine`; the sandbox grants no writable roots from `stateRoot` under `read-only`; a missing confinement provider fails closed. The pre-session model catalog uses an explicit `read-only` policy and the same private state-root handling, never a bare `danger-full-access` preflight.

Production `dsh` does not install or mount this optional provider. A Profile that opts in installs `@deepseek-ai/dsh-external-session-codex` and the `dsh-external-session` registry and mounts both once on the host plane:

```yaml
- id: external-session
  name: '@deepseek-ai/dsh-external-session'

- id: external-session-codex
  name: '@deepseek-ai/dsh-external-session-codex'
  config:
    env:
      OPENAI_API_KEY: !!js process.env.OPENAI_API_KEY
```

## Product compatibility and evidence

The production wire implements only the app-server methods this persistent contract needs; method names and stable request fields are cited against [the 0.147.0 evidence transcripts](tests/evidence/README.md). The shared newline JSON-RPC transport comes from `@deepseek-ai/dsh-sdk-protocol`; the one-shot sibling does not export its wire and its single-ephemeral-thread, unattended-approval dataflow does not fit interactive sessions, so the transport is the reuse boundary and the product methods live here. Development and production resolve the pinned `@openai/codex@0.147.0` package unless an explicit command override is supplied.

## Model Experience

### External agent activity, log-only

#### What the model sees

Nothing in the DSH parent session. The external agent's transcript, tool activity, permission outcomes, and compaction notices are recorded as log-only `external/*` session events (`ignorable: true`) for replay projection; none is woven into a parent session's request context, prompt, or tool schema. The Codex child itself sees the submitted prompts and its own streamed transcript in its non-ephemeral thread.

#### Token effect

Zero direct token effect on any DSH session: the log-only events add no request tokens. The Codex child pays for an independent Codex context and turn; child tokens do not enter any DSH parent context.

#### KV Cache effect

No effect on DSH session caches: the events are appended outside any model request and share no request prefix with one. Codex's own provider and persistent-thread requests govern its cache reuse independently.

## Known Limitations and Deferred Work

- **Model selection applies on the next turn** — `setModel` records the selected model and optional reasoning effort and sends them through the stable `turn/start` fields; a running turn is not mutated.
- **No streaming durability guarantee** — live deltas ride `streamDelta` on the live frame path only and are never written to the durable log; replay reconstructs committed `external/*` units.
- **Approvals depend on the permission channel** — `requestPermission` fails closed (`PERMISSION_UNWIRED`) until a host plugin wires the ask-user channel; the provider then maps to the safe decline and `cancelled`.
- **App-server child closure settles before recovery** — an unexpected child death settles the active turn as `error`, then the next operation respawns and resumes the in-memory thread id; a cold host session uses its durable provider-thread id through explicit `resume`, and the app-server itself does not emit a terminal `turn/completed` for the dead process.
- **Assembled-app acceptance evidence is deferred** — Loader-composition, browser accessibility, and keyless user-visible snapshot evidence belong to Task 9; this package's tests cover the provider seam and pinned keyless fixture only.
- **Failed startup may leave an empty hashed state directory** — the directory is private and provider-owned; process rollback does not remove it because a later explicit resume may still need the retained Codex rollout state.
- **Compaction notice text is a fixed summary, not the wire's compaction details** — 0.147.0 evidence shows `thread/compact/start` returns `{}` immediately with compaction running as a background turn; the durable notice is provider-authored.
- **Compatibility is pinned by development evidence** — upgrading from the verified 0.147.0 protocol baseline requires regenerating upstream schema evidence and rerunning the keyless real-product tests.
