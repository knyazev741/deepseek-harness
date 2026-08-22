# @deepseek-ai/dsh-external-session-codex

English | [中文](README.zh.md)

Persistent Codex external-agent session provider. Registers the `codex` mode on [`ctx.externalSessions`](../external-session/README.md): each accepted session spawns the official `codex app-server --stdio` command, opens one non-ephemeral thread in the session workspace, and then serves repeated prompts on that thread. Live assistant text streams out through the per-session bridge's `streamDelta`; committed messages, tool activity, approval asks, and terminal stop reasons are recorded as log-only `external/*` session events; compact runs through the dedicated `thread/compact/start` method; and an unexpected app-server death is recovered by respawning the process and `thread/resume`-ing the persisted thread. The one-shot sibling [`@deepseek-ai/dsh-subagent-codex`](../../subagent/subagent-codex/README.md) drives its own ephemeral thread; this provider is the interactive, persistent counterpart.

## Start and ownership

`start(request)` spawns the app-server through [`dsh-subprocess`](../../subprocess/subprocess/README.md) under the session workspace, performs `initialize` → `initialized` → `thread/start { cwd, ephemeral: false }`, and retains the non-ephemeral thread id for the session's lifetime. The provider emits `external/session-started` once the thread exists.

`prompt(text)` runs turns strictly serially: it awaits the prior turn's `turn/completed` terminal notification, submits the next `turn/start` on the same thread, and returns the provider-issued turn id immediately. The turn then streams to completion asynchronously: `item/agentMessage/delta` is forwarded to `streamDelta` (live only, never durable), a completed `agentMessage` is committed as `external/message-added { role: 'agent' }`, the submitted prompt as `{ role: 'user' }`, `commandExecution` items as `external/tool-activity { kind: 'call' | 'result' }`, and the terminal `turn/completed` as `external/turn-ended` (`completed` / `aborted` / `error` / `max-tokens`). `interrupt()` sends a best-effort `turn/interrupt`, whose interrupted terminal maps to `aborted`.

Approval asks arrive as `item/commandExecution/requestApproval`. The provider emits `external/permission-asked`, consults the bridge's `requestPermission` (the ask-user permission channel), maps the human's `allowed` / `rejected` / `cancelled` decision onto the wire's `accept` / `decline` / `cancel`, answers the request, and records `external/permission-decided`. A failed, unwired, or dismissing permission channel fails closed to the safest offered decision and `cancelled`.

`compact()` calls the dedicated `thread/compact/start` and records `external/compaction-noticed`; compaction then runs as a background turn on the normal notification path.

When the app-server process dies mid-session, the next operation spawns a fresh child and reattaches the persisted thread with `thread/resume` (cold reattach; evidence `thread-persistence.json`). `dispose()` records `external/session-ended`, interrupts any active turn, closes the wire, and runs the whole-tree termination ladder (stdin EOF grace, then the shared process-tree SIGTERM → grace → SIGKILL escalation).

## Model listing and switching

Evidence confirms native `model/list` exists in 0.147.0 (`models.json`), so the provider answers `listModels` from the live wire's native catalog and advertises `modelDirectory: 'provider'`; no fallback roster config is used. When no session is live, `listModels` runs a short-lived wire against the deployment working directory (the catalog is local, so the workspace is immaterial).

`setModel` **rejects loud**: the 0.147.0 app-server exposes no runtime model-switch on a live thread and no per-turn model option — the evidence lists no `thread/model` method and `thread/start` / `turn/start` / `thread/resume` accept no `model` field. Select the Codex model in Codex config instead; the native list remains read-only.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `command` | `codex` | App-server command or path, resolved from `PATH`; never shell-interpreted (wrapped in `cmd.exe /d /s /c` on Windows). |
| `args` | `["app-server", "--stdio"]` | App-server arguments; an empty string fails load. |
| `env` | `{}` | Explicit child environment layered over the subprocess seam's credential-scrubbed parent environment. |
| `disposeGraceMs` | `3000` | Positive finite grace in milliseconds, no greater than [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md), between the shared process-tree owner's termination tiers. |

Production resolves `codex` from `PATH` and uses the host's native Codex configuration and authentication. The plugin does not install Codex, log in, or probe a version. Credential-shaped ambient variables are removed by the subprocess seam, so an API key intended for the child must be supplied explicitly in `env`; ordinary ambient values such as `PATH` and `HOME` remain available unless overridden.

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

The production wire implements only the app-server methods this persistent contract needs; method names are cited against [the 0.147.0 evidence transcripts](tests/evidence/README.md). The shared newline JSON-RPC transport comes from `@deepseek-ai/dsh-sdk-protocol`; the one-shot sibling does not export its wire and its single-ephemeral-thread, unattended-approval dataflow does not fit interactive sessions, so the transport is the reuse boundary and the product methods live here. Development evidence is pinned to `@openai/codex@0.147.0` / `codex-cli 0.147.0`; the npm package is a test-only dependency, and deployments still supply `codex` on `PATH`.

## Model Experience

### External agent activity, log-only

#### What the model sees

Nothing in the DSH parent session. The external agent's transcript, tool activity, permission outcomes, and compaction notices are recorded as log-only `external/*` session events (`ignorable: true`) for replay projection; none is woven into a parent session's request context, prompt, or tool schema. The Codex child itself sees the submitted prompts and its own streamed transcript in its non-ephemeral thread.

#### Token effect

Zero direct token effect on any DSH session: the log-only events add no request tokens. The Codex child pays for an independent Codex context and turn; child tokens do not enter any DSH parent context.

#### KV Cache effect

No effect on DSH session caches: the events are appended outside any model request and share no request prefix with one. Codex's own provider and persistent-thread requests govern its cache reuse independently.

## Known Limitations and Deferred Work

- **No runtime model-switch on a live thread** — 0.147.0 (`model/list` exists; no `thread/model` or per-turn model option) makes `setModel` reject loud and the native catalog read-only; Task 6's `/model` surfaces this limitation. Selecting a Codex model is a config change, not a session switch.
- **No streaming durability guarantee** — live deltas ride `streamDelta` on the live frame path only and are never written to the durable log; replay reconstructs committed `external/*` units.
- **Approvals depend on the permission channel** — `requestPermission` fails closed (`PERMISSION_UNWIRED`) until a host plugin wires the ask-user channel; the provider then maps to the safe decline and `cancelled`.
- **App-server closure mid-session is recovered, not prevented** — an unexpected child death is masked by respawn + `thread/resume` on the next operation; an active turn interrupted by death does not emit a terminal `turn/completed` (the next turn's stop reflects the resumed thread).
- **Compaction notice text is a fixed summary, not the wire's compaction details** — 0.147.0 evidence shows `thread/compact/start` returns `{}` immediately with compaction running as a background turn; the durable notice is provider-authored.
- **Compatibility is pinned by development evidence** — upgrading from the verified 0.147.0 protocol baseline requires regenerating upstream schema evidence and rerunning the keyless real-product tests.
