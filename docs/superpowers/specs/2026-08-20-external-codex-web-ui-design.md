# External Codex Web UI Design

English | [中文](2026-08-20-external-codex-web-ui-design.zh.md)

## Goal

The local single-user Web profile can create a `codex` session and use the official Codex app-server through the normal DeepSeek Harness conversation UI. The session streams assistant text, persists and resumes the same Codex thread, uses the selected model and reasoning effort, routes approvals through Harness, runs the Codex process under Harness file confinement, and exposes an explicit allowlist of Harness tools to Codex through an authenticated local MCP gateway.

## Scope

This design completes the existing native `external-session-codex` path. It covers the macOS, Linux, and Windows local providers shipped by the repository, a separately selectable Web bundle, keyless real-composition coverage, and the configuration needed to run the finished bundle locally.

ACP, Claude Code, remote multi-user hosting, seamless recovery of a partial token stream after a transport reconnect, background scheduling, workflows, terminal/jobs, and unrestricted export of every Harness tool are not part of this change. These exclusions do not narrow the Codex conversation flow: prompts, model selection, reasoning effort, live text, committed transcript, command/file activity, approvals, interruption, compaction, restart recovery, and allowlisted MCP calls remain required.

## Existing foundation

`ctx.externalSessions` already registers named providers and dispatches session operations. `external-session-codex` already owns a persistent app-server process and maps committed Codex items into log-only `external/*` events. `external-session-bridge` starts a provider for a new external-mode session. `ui-session-mode` already renders the mode picker and committed external transcript nodes. The host already accepts `session.create({ mode, model })` and has an external `session.command` route.

The incomplete parts are load-bearing: the Web profile does not mount the server-side provider family, live deltas are discarded, the Codex thread id is not durable, cold sessions are recreated instead of resumed, selected model/policy fields are not sent to the 0.147.0 wire, the process bypasses `ctx.sandbox`, external prompts take native-Agent client paths, and no Harness-to-MCP server exists.

## Architecture

### Session creation and provider selection

An opt-in `web-codex` bundle layers on top of `base` and `web-app`. It mounts `external-session`, `external-permission`, `external-session-codex`, `external-session-bridge`, and the MCP gateway. The default Web bundle remains unchanged and does not start or advertise Codex.

The Codex provider has a structured preflight operation. It verifies the configured executable, performs the app-server handshake and account/auth status read without exposing credentials, and returns a typed availability failure to `session.externalModes`. Session creation repeats the decisive preflight before publishing a Codex-mode session. A missing binary, unavailable authentication, unsupported sandbox mode, or invalid configuration fails before a stranded session is visible.

The provider depends on a maintained `@openai/codex` runtime package and may use an explicit configured executable. Explicit configuration wins; otherwise the packaged launcher is resolved without shell interpretation. The provider uses the user's existing Codex authentication under a per-session `CODEX_HOME` managed by Harness.

### Per-session state and file confinement

`workspace-write` confinement permits the session workspace and one host-owned private state directory. `SandboxExecutionPolicy` gains an optional `stateRoot`; it is not derived from model input or a tool call. The caller creates the directory with owner-only permissions, canonicalizes it, and passes it only while confining a stateful child process. Every local sandbox backend grants that exact state directory in addition to its existing workspace and private-temp permissions. `read-only` ignores `stateRoot` and grants no writes. `danger-full-access` continues to bypass confinement.

The provider stores each Codex home beneath a configured Harness-owned root, keyed by an opaque session id. It creates directories with mode `0700` and credential/config files with mode `0600`. It never places Codex credentials in the workspace, command line, logs, session events, or MCP URL. The state directory remains after a live process stops so a cold Harness session can resume. Session deletion removes it through a specific owner operation; ordinary process disposal does not.

The app-server argv is built first, including the Windows `cmd.exe` launcher where required, then wrapped once through `ctx.sandbox.confine`. A confined-mode failure is fatal; the provider never falls back to an unconfined spawn. The subprocess service retains environment scrubbing and whole-tree ownership.

### Codex settings and policy mapping

`ExternalSessionStart` carries resolved `model`, `reasoningEffort`, Harness sandbox mode, and approval policy. Codex receives stable fields on `thread/start`, `thread/resume`, and `turn/start`:

| Harness | Codex |
|---|---|
| model id | `model` |
| reasoning effort | `turn/start.effort` |
| approval `ask` | `approvalPolicy: "on-request"` |
| approval `never` | `approvalPolicy: "never"` |
| `read-only` | `sandbox: "read-only"` / read-only turn policy |
| `workspace-write` | `sandbox: "workspace-write"` / workspace-write turn policy |
| `danger-full-access` | `sandbox: "danger-full-access"` / danger-full-access turn policy |

The provider uses generated 0.147.0 app-server types as the compatibility authority. It does not retain the current false assumption that model fields are absent. Runtime model and effort changes use stable per-turn overrides. A future use of `thread/settings/update` or named permission profiles requires explicit experimental capability negotiation and is not necessary for this change.

Changing the Harness sandbox mode of a live external session restarts the app-server under the new outer policy, waits for the old process tree to reach quiescence, and resumes the same Codex thread. Updating only the inner Codex sandbox is insufficient.

### Durable thread identity and cold resume

`external/session-started` records the provider thread id after `thread/start` succeeds. The id is opaque provider state and is never inferred from paths. The external transcript projection exposes the latest attachment state needed by the host without making it model-visible.

The external-session service distinguishes `start` from `resume`. Resume requires a durable provider thread id; failure never falls back to creating a new thread. The host restores a cold session through `SessionPersistence.prepare`, enters and announces that prepared session, then asks the provider to resume. Concurrent prompt/command requests share one in-flight attachment. Attachment failure rolls back the live route and leaves the durable session readable.

Cold attachment is on demand. Listing or reading history does not start Codex processes for every persisted session. The first prompt, compact, interrupt-capable operation, or settings change attaches the provider.

If the child dies during a turn, the provider settles the active turn as failed, closes old listeners, awaits the process tree, and only then permits a new app-server plus `thread/resume`. No prompt may wait forever on an `activeEnd` promise owned by a dead process.

### Live transcript transport

`ExternalBridgeContext.streamDelta` emits a typed host event. The host projects it into a new `MuxFrame` variant keyed by session and turn. The frame remains live-only; it never becomes a synthetic session event.

The client session accumulates delta text per external turn and invalidates through the frame notifier, which coalesces visual updates. A committed durable `external/message-added` replaces and clears the accumulator. Disconnect, reconnect, subscription replacement, session close, and turn failure clear partial live state. A reconnect backfills committed history; it does not claim to reconstruct a lost partial token stream.

The conversation view has one external-live seat rendered by `ui-session-mode`. It uses the same Markdown presentation as committed external agent text and is absent when no partial text exists.

### External tool execution identity

The MCP gateway must invoke `ctx.tools.execute`; calling a definition directly would bypass guards, approvals, events, result validation, and rendering. A fake unregistered `Agent` is also invalid because several consumers assume registered native-agent lifecycle and an open native turn.

The tool runtime therefore accepts exactly one execution identity: a native `agent` or an `ExternalToolPrincipal`. The external principal carries an opaque id, its session, its scoped Cordis context, and a recorder for durable external tool call/result events. Shared helpers derive the execution scope and session from either identity. Registration lookup, restrictions, guards, cancellation, `tools/pre-execute`, `tools/execute`, `tools/post-execute`, output validation, and `tools/result` remain one pipeline.

External approval has an explicit operation on the approval service. It uses the same configured policy and fail-closed human decision channel, but records an external approval bracket rather than fabricating native `turn/start`/`turn/end`. Dismissal, timeout, missing answerer, principal disposal, and gateway cancellation reject the action.

The initial MCP allowlist excludes tools whose implementation requires a native Agent or native turn: ask-user, schedule, workflow, Cordis self-modification, terminal, jobs, and subagent orchestration. Shell and filesystem tools are eligible only after their execution helpers derive session/scope from the shared execution identity. Unknown and unlisted tools fail before dispatch.

### MCP gateway

`mcp-gateway` is a complete capability with a Service Definition, loopback HTTP provider, and the external-session Codex consumer. Creating a gateway instance returns an authenticated endpoint and an async disposer. Each instance owns a random route id and bearer token, a session-bound external principal, a fixed allowlist, request-size and execution-time bounds, and an abort signal.

The server binds only to loopback. Authentication and route lookup happen before JSON parsing and dispatch. The public URL contains an opaque random route, never a raw session id. `tools/list` returns only allowlisted definitions visible in the principal scope. `tools/call` validates the tool name and input, calls `ctx.tools.execute`, and maps the result into MCP text/structured content and `isError` without forwarding untrusted headers or ambient environment.

The provider writes the endpoint into the per-session Codex config and supplies the bearer token through a credential-shaped explicit environment variable. The MCP token is not durable and is regenerated when a session attaches. Resume rewrites only the ephemeral endpoint/token configuration while retaining Codex rollout state. Gateway disposal precedes child termination so late calls fail closed.

### Client routing

Session summaries and client session state retain the durable mode. A native session continues to use the native prompt/command remotes. A Codex session sends plain text and pass-through slash lines through `api.sessions.command`; `/compact` and `/model` keep the dedicated external command behavior. Images, queue/steer, and native goals present an explicit unavailable state until their external provider operations exist; they never silently route into a nonexistent native Agent.

The Web settled barrier recognizes `external/turn-ended` for external sessions. Native `turn/end` behavior remains unchanged.

## Errors and lifecycle

All provider start/resume failures are typed and visible in the session UI. No failure creates a replacement Codex thread, silently removes confinement, changes the tool allowlist, or accepts an approval. Process disposal closes event/request listeners, aborts pending approvals and MCP calls, interrupts the active turn, terminates the process tree, and awaits `done`.

Unexpected callbacks are contained and logged without starving sibling listeners. External delta frames may be dropped for an unmaterialized client session because the committed log remains authoritative. Durable events are appended only after their operation reaches its commit point.

## Verification

Every behavior change follows red-green TDD. Package tests cover wire payloads, model/effort/policy mapping, exact confined argv on POSIX and Windows, environment scrubbing, process-death settlement, thread-id durability, explicit resume without fallback, live delta reset/commit behavior, external principal restrictions/guards/approval, MCP authentication/allowlist/bounds/result mapping, and provider preflight.

A real Loader composition test boots base + Web + the opt-in Codex bundle. A keyless app-server fixture proves that the provider is listed, a Codex-mode session has no native Agent, a UI prompt reaches the same persistent Codex thread, live and committed text render, an allowlisted MCP call passes through `ctx.tools.execute`, a denied tool fails closed, and restart attachment uses `thread/resume` rather than `thread/start`.

The Web accessibility snapshot covers the mode picker, live response, committed transcript, command/file activity, and approval prompt. Default Web composition tests prove Codex remains opt-in. Relevant typecheck, lint, build, hygiene, doc-sync, built profile smoke, and snapshot replay run before completion; the repository-wide full suite remains CI-owned unless a cross-cutting failure makes it necessary locally.

## Documentation

The existing implemented Agent Note is updated to state only shipped behavior and verification. The stale proposed note is either retained with only genuinely unimplemented later phases or replaced by a narrower proposed note; it must not remain current authority for completed Phase 1 work. Every changed package updates its README, JSDoc, known limitations, English/Chinese pair, and generated catalogs through the owning source and repository generators.

## Alternatives considered

**PTY embedding.** Rejected because terminal pixels do not provide structured approvals, durable transcript units, model settings, tool events, or policy enforcement.

**`codex-acp` in the Codex path.** Rejected for this change because the native provider already exists and an extra translation layer weakens thread resume and provider-specific settings. A future generic ACP provider may use it.

**Synthetic native Agent.** Rejected because it would create a partially registered identity without a native loop or turn. Tools that assume the agent registry, inbox, or native approval bracket would fail inconsistently.

**Inner Codex sandbox only.** Rejected because the app-server process and native tools would remain outside Harness confinement.

**Global `CODEX_HOME` under workspace-write.** Rejected because it either fails to persist or requires granting the child write access to the user's entire Codex home. A single host-owned state root is the narrower permission.

**Startup resume sweep.** Rejected because reading the session list would start one process per historical Codex session. On-demand attachment preserves cheap history reads and explicit process ownership.
