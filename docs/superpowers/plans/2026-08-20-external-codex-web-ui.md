# External Codex Web UI Implementation Plan

English | [中文](2026-08-20-external-codex-web-ui.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the native Codex external-session path so a local user can create, converse with, approve, resume, and use allowlisted Harness tools from Codex entirely inside the DeepSeek Harness Web UI.

**Architecture:** The existing `ctx.externalSessions` provider remains the driver boundary. Codex runs as the official app-server under the Harness sandbox with a private state root; typed live frames and durable committed events feed the existing conversation UI; an explicit external tool principal carries Harness policy through the normal tool pipeline; and an authenticated loopback MCP gateway exposes a fixed allowlist. A separate Web bundle keeps the feature opt-in.

**Tech Stack:** TypeScript ESM, Cordis plugins, Typert RPC, React client plugins, Codex app-server JSONL RPC, MCP TypeScript SDK with Streamable HTTP, Vitest, Loader real-composition fixtures, Web snapshot replay.

**Spec:** `docs/superpowers/specs/2026-08-20-external-codex-web-ui-design.md`

## Global Constraints

- Every implementation and review agent uses `gpt-5.6-luna` with `reasoning_effort=max`; the controller writes no production code.
- Follow red-green TDD: record the failing command/output before production changes and the passing command/output after them.
- Work only in `/Users/knyaz/deepseek-harness-external-codex` on `codex/external-codex-ui`; do not touch the user's primary checkout or unrelated untracked files.
- Preserve default Web behavior: Codex remains an opt-in bundle and an external session never registers a native Agent or runs the native agent loop.
- Never call `ToolDefinition.execute()` directly; MCP calls must enter through `ctx.tools.execute` and preserve restrictions, guards, approvals, events, validation, and durable results.
- Never weaken a confined session to unconfined execution. `read-only` grants no state writes, `workspace-write` grants the workspace plus one host-owned state root, and `danger-full-access` alone bypasses confinement.
- Credentials, bearer tokens, raw session ids, and Codex state paths never enter logs, session events, URLs, command lines, snapshots, or diagnostics.
- Provider resume requires the durable Codex thread id and never falls back to `thread/start`.
- Live deltas remain non-durable; reconnect clears partial state and committed `external/message-added` is authoritative.
- Update affected README/JSDoc contracts and English/Chinese pairs in the same task; update the owning implemented Agent Note before final verification.
- Do not edit `vendor/` or `.agents/notes/archived/`.

---

### Task 1: Stateful child confinement

**Files:**
- Modify: `packages/sandbox/sandbox/src/index.ts`
- Modify: `packages/sandbox/sandbox/src/roots.ts`
- Modify: `packages/sandbox/sandbox-local/src/profiles.ts`
- Modify: `packages/sandbox/sandbox-local/src/index.ts`
- Modify: `packages/sandbox/sandbox-windows-acl/src/index.ts`
- Modify: relevant sandbox README/JSDoc English and Chinese pairs
- Test: `packages/sandbox/sandbox/tests/roots.spec.ts`
- Test: `packages/sandbox/sandbox-local/tests/profiles.spec.ts`
- Test: `packages/sandbox/sandbox-local/tests/local.spec.ts`
- Test: Windows ACL focused tests named by the implementation report

**Interfaces:**
- Consumes: existing `SandboxExecutionPolicy`, `SandboxProvider.confine`, `writableRoots`.
- Produces: `SandboxExecutionPolicy.stateRoot?: string`; every shipped local backend grants the canonical state root only under `workspace-write`.

- [ ] **Step 1: Write failing policy/root tests**

  Add cases equivalent to:

  ```ts
  import { expect } from 'vitest'
  import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'

  expect(writableRoots({
    mode: 'workspace-write',
    workspaceRoot: '/workspace',
    stateRoot: '/private/dsh/codex/session-a',
  })).toContain(canonicalPath('/private/dsh/codex/session-a'))

  expect(writableRoots({
    mode: 'read-only',
    workspaceRoot: '/workspace',
    stateRoot: '/private/dsh/codex/session-a',
  })).toEqual([])
  ```

  Pin canonicalization, deduplication, macOS profile rules, Linux/bwrap binding, Landlock argv, and Windows private state grant/revocation.

- [ ] **Step 2: Run the focused tests and save RED evidence**

  Run the exact affected sandbox test files with the bundled Node 22+ runtime. Expected: failures because `stateRoot` is absent or not granted.

- [ ] **Step 3: Implement the minimal state-root policy**

  Add the optional host-owned root to the policy type and grant derivation. Validate an absolute, canonical root before building runner argv. Do not add a generic unbounded writable-root array. Preserve the existing private-temp capability and make state-root cleanup caller-owned.

- [ ] **Step 4: Run focused tests and package typecheck**

  Expected: all new policy/profile/grant tests pass with no new warnings; affected package typechecks pass.

- [ ] **Step 5: Update contracts and commit**

  Update sandbox READMEs/JSDoc with the exact `stateRoot` conditions and commit as `feat(sandbox): confine stateful child storage`.

---

### Task 2: Codex settings, state, and process settlement

**Files:**
- Modify: `packages/external/external-session/src/types.ts`
- Modify: `packages/external/external-session-codex/src/index.ts`
- Modify: `packages/external/external-session-codex/src/run.ts`
- Modify: `packages/external/external-session-codex/src/wire.ts`
- Modify: `packages/host/apiproxy/src/api-proxy.ts`
- Modify: `packages/external/external-session-codex/package.json`
- Modify: relevant README/JSDoc/evidence English and Chinese pairs
- Test: `packages/external/external-session-codex/tests/unit.spec.ts`
- Test: `packages/external/external-session-codex/tests/external-session-codex.spec.ts`
- Test: `packages/host/apiproxy/tests/api-proxy-mode.spec.ts`

**Interfaces:**
- Consumes: Task 1 `SandboxExecutionPolicy.stateRoot`, session sandbox and approval folds.
- Produces: resolved `ExternalSessionStart` settings; confined Codex spawn; stable `thread/start`, `thread/resume`, and `turn/start` overrides; settled active turn on process death.

- [ ] **Step 1: Write failing wire/settings/confinement tests**

  Cover the following request fields and exact mappings:

  ```ts
  import type { SessionId } from '@deepseek-ai/dsh-session'
  import type { ApprovalPolicy, ReasoningEffort, SandboxMode } from '@deepseek-ai/dsh-external-session'

  interface ExternalSessionStart {
    sessionId: SessionId
    provider: string
    cwd: string
    model?: string
    reasoningEffort?: ReasoningEffort
    sandbox: SandboxMode
    approvalPolicy: ApprovalPolicy
  }
  ```

  Assert `ask -> on-request`, `never -> never`, model on thread and turn, `reasoningEffort -> effort`, and exact POSIX/Windows confined argv. Assert explicit secrets survive only through configured env while ambient credential-shaped values remain scrubbed.

- [ ] **Step 2: Write failing process-death test**

  Start a turn, terminate the app-server before `turn/completed`, then submit another prompt. Expected new behavior: the first turn records failure/abortion, old listeners and tree settle, and the second prompt reaches a resumed process instead of hanging on `activeEnd`.

- [ ] **Step 3: Run focused tests and save RED evidence**

  Expected: failures show missing wire fields, raw subprocess argv, and unresolved `activeEnd`.

- [ ] **Step 4: Implement settings and confinement**

  Resolve the live `Session` from the reserved id, fold `ctx.sandboxPolicy` and `ctx.approval`, create a private per-session Codex state directory under configured Harness-owned storage, and pass `{ ...resolvedPolicy, stateRoot }` to `ctx.sandbox.confine`. Resolve the packaged `@openai/codex` launcher without shell interpolation while preserving explicit `command` precedence.

- [ ] **Step 5: Implement stable runtime model/effort switching**

  Replace the unconditional `setModel` rejection. Store the selected model/effort in the live session and apply it to the next stable `turn/start`; record `external/model-switched` only after the setting is accepted. Do not enable experimental app-server APIs.

- [ ] **Step 6: Implement quiescent process failure/disposal**

  One lifecycle controller owns listeners, fatal settlement, active turn, child handle, and teardown. Close listeners before kill, settle the active turn exactly once, terminate, await `waitForExit` and `done`, then permit respawn.

- [ ] **Step 7: Run tests, typecheck, update docs, and commit**

  Regenerate or re-read 0.147.0 schemas/evidence, remove the stale “no model field” claim, update README/JSDoc pairs, and commit as `feat(external-codex): inherit settings and confinement`.

---

### Task 3: Durable thread identity and on-demand resume

**Files:**
- Modify: `packages/session/session-projection/src/external-transcript.ts`
- Modify: `packages/external/external-session/src/types.ts`
- Modify: `packages/external/external-session/src/index.ts`
- Modify: `packages/external/external-session-codex/src/index.ts`
- Modify: `packages/external/external-session-codex/src/run.ts`
- Modify: `packages/external/external-session-bridge/src/index.ts`
- Modify: `packages/host/apiproxy/src/api-proxy.ts`
- Modify: affected README/JSDoc English and Chinese pairs
- Test: `packages/session/session-projection/tests/external-transcript.spec.ts`
- Test: `packages/external/external-session/tests/service.spec.ts`
- Test: `packages/external/external-session-codex/tests/external-session-codex.spec.ts`
- Test: `packages/external/external-session-bridge/tests/driver.spec.ts`
- Test: `packages/host/apiproxy/tests/api-proxy-external-command.spec.ts`

**Interfaces:**
- Consumes: Task 2 process/session settings and Codex state root.
- Produces: durable `providerThreadId`; explicit provider/service `resume`; one on-demand cold attachment per session.

- [ ] **Step 1: Write failing durable identity tests**

  Extend the committed start payload:

  ```ts
  interface ExternalSessionStartedData {
    provider: string
    cwd: string
    model?: string
    providerThreadId: string
  }
  ```

  Assert the event appears only after a successful `thread/start` and projection/replay preserves the opaque id without rendering it.

- [ ] **Step 2: Write failing explicit-resume tests**

  Add `resume(request, bridge, providerThreadId)` to provider and registry contracts. Assert unknown/missing ids reject, duplicate attachment shares one promise, a failed resume removes the live route, and no `thread/start` request occurs.

- [ ] **Step 3: Write failing host restart test**

  Persist a Codex external session to JSONL, create a fresh host composition, read history without spawning a child, issue the first prompt, and assert `SessionPersistence.prepare` restores the same session followed by exactly one `thread/resume`.

- [ ] **Step 4: Run focused tests and save RED evidence**

  Expected: missing id/API and current empty-session recreation produce failures.

- [ ] **Step 5: Implement resume and cold materialization**

  Separate `start` and `resume` paths. Use persistence prepare/enter/announce patterns rather than `ctx.sessions.create` for cold sessions. Keep an in-flight attachment map and roll it back on rejection. History/list operations remain process-free.

- [ ] **Step 6: Run tests, typecheck, update docs, and commit**

  Expected: restart test proves same durable DSH session and same Codex thread. Commit as `feat(external): resume durable Codex sessions`.

---

### Task 4: Live delta transport and UI seat

**Files:**
- Modify: `packages/external/external-session/src/index.ts`
- Modify: `packages/host/apiproxy/src/api/events.ts`
- Modify: `packages/host/apiproxy/src/api/events.schema.ts`
- Modify: `packages/host/apiproxy/src/api-proxy.ts`
- Modify: `packages/client/runtime/src/client/sessions/manager.ts`
- Modify: `packages/client/runtime/src/client/sessions/session.ts`
- Modify: `packages/client/runtime/src/client/sessions/notifier.ts`
- Modify: `packages/client/ui-conversation/src/client/contract/slots.ts`
- Modify: `packages/client/ui-conversation/src/client/chat/ChatView.tsx`
- Modify: `packages/client/ui-session-mode/src/client/transcript/external-nodes.tsx`
- Modify: `packages/client/ui-session-mode/src/client/transcript/register.ts`
- Modify: affected README/JSDoc/locales and Chinese pairs
- Test: exact host/client/UI files named in the implementation report

**Interfaces:**
- Consumes: existing `ExternalBridgeContext.streamDelta` and host mux.
- Produces: typed `external/session-delta` Cordis event; `external/delta` mux frame; per-turn client accumulator; external live UI slot.

- [ ] **Step 1: Write failing service/mux tests**

  Assert a provider delta emits and serializes as:

  ```ts
  const frame = { type: 'external/delta', sessionId: 'session-id', turnId: 'turn-id', delta: 'text' }
  ```

  Invalid ids/data must fail the schema; no session event is appended.

- [ ] **Step 2: Write failing client lifecycle tests**

  Assert ordered accumulation, notifier frame batching, committed-message retirement, and clearing on disconnect/reconnect/subscription replacement/turn failure.

- [ ] **Step 3: Write failing renderer test**

  Assert partial Markdown appears in the external live seat and disappears when durable committed text arrives.

- [ ] **Step 4: Run focused tests and save RED evidence**

  Expected: no mux variant, no accumulator, and no seat.

- [ ] **Step 5: Implement host/client/UI path**

  Emit from the service without importing host types. Broadcast only to subscribed clients. Drop frames for unmaterialized sessions. Use `markFrameDirty`, not durable invalidation, and never synthesize session events.

- [ ] **Step 6: Run tests, GUI checks, update docs, and commit**

  Commit as `feat(client): stream external agent deltas`.

---

### Task 5: External tool execution principal

**Files:**
- Modify: `packages/core/tools/src/index.ts`
- Modify: tool runtime helper/type files discovered by the implementer and named in the report
- Modify: `packages/core/tools/src/invariant.ts`
- Modify: eligible shell/filesystem tool consumers that currently require `exec.agent`
- Modify: affected subsystem docs, README/JSDoc English and Chinese pairs
- Test: `packages/core/tools/tests/scoped.spec.ts`
- Test: `packages/core/tools/tests/tools.spec.ts`
- Test: `packages/core/tools/tests/execution-mode.spec.ts`
- Test: `packages/core/tools/tests/invariant.spec.ts`

**Interfaces:**
- Consumes: native `Agent` execution identity and current tool pipeline.
- Produces:

  ```ts
  import type { Context } from '@deepseek-ai/cordis'
  import type { Session } from '@deepseek-ai/dsh-session'
  import type { ExternalToolPrincipalId, ToolExecutionRecorder } from '@deepseek-ai/dsh-tools'

  interface ExternalToolPrincipal {
    readonly kind: 'external'
    readonly id: ExternalToolPrincipalId
    readonly session: Session
    readonly ctx: Context
    readonly recorder: ToolExecutionRecorder
  }
  ```

  `ToolExecutionInput` accepts exactly one of `agent` or `principal`; shared helpers return scope/session without fabricating an Agent.

- [ ] **Step 1: Write failing identity and pipeline tests**

  Assert XOR validation, scoped registration lookup, restrictions, guards, cancellation, waterfall events, output validation, and result dispatch for both native Agent and external principal. Assert no `ctx.agents` registration occurs.

- [ ] **Step 2: Write failing eligible-tool tests**

  Prove shell/filesystem tools derive the external session policy. Prove ask-user, schedule, workflow, Cordis self-modification, terminal/jobs, and subagent tools are absent from the external allowlist until explicitly adapted.

- [ ] **Step 3: Run focused tests and save RED evidence**

  Expected: current interfaces accept only `agent` or lose session policy.

- [ ] **Step 4: Implement execution subject helpers**

  Add explicit discriminated execution identity, keep all current native call sites source-compatible, and route session/scope reads through one helper. Do not expose internal schedulers or widen hostile-input validation at typed same-process boundaries.

- [ ] **Step 5: Run tests, typecheck, docs, and commit**

  Commit as `feat(tools): execute for external principals`.

---

### Task 6: External approvals and durable tool records

**Files:**
- Modify: `packages/interaction/user-approval/src/index.ts`
- Modify: `packages/interaction/user-approval/src/types.ts`
- Modify: `packages/interaction/user-approval/src/invariant.ts`
- Modify: `packages/session/session-projection/src/external-transcript.ts`
- Modify: `packages/external/external-session/src/types.ts`
- Modify: `packages/external/external-session/src/index.ts`
- Modify: affected README/JSDoc English and Chinese pairs
- Test: `packages/interaction/user-approval/tests/approval.spec.ts`
- Test: `packages/interaction/user-approval/tests/invariant.spec.ts`
- Test: `packages/session/session-projection/tests/external-transcript.spec.ts`
- Test: `packages/external/external-session/tests/service.spec.ts`

**Interfaces:**
- Consumes: Task 5 `ExternalToolPrincipal` and recorder.
- Produces: `ApprovalService.requestExternal`; `external/tool-call` and `external/tool-result` durable events paired by branded call id.

- [ ] **Step 1: Write failing external approval tests**

  Assert effective session policy, scoped answerer routing, allow/reject/cancel/unavailable, abort on principal disposal, and an external audit pair that does not require or fabricate native `turn/start`.

- [ ] **Step 2: Write failing tool record tests**

  Assert one call event precedes one result event, arguments/results are JSON-safe and bounded, errors are explicit, and replay folds them into external transcript tool nodes.

- [ ] **Step 3: Run focused tests and save RED evidence**

  Expected: current approval request requires `Agent` and open native turn; current `external/tool-activity` cannot carry a complete gateway call/result.

- [ ] **Step 4: Implement explicit external approval and recorder**

  Keep native approval semantics unchanged. Add an external waterfall and invariant bracket keyed by principal/session/call id. The recorder appends committed events only at pipeline commit points.

- [ ] **Step 5: Run tests, typecheck, docs, and commit**

  Commit as `feat(interaction): approve external tool calls`.

---

### Task 7: Authenticated MCP gateway and Codex consumer

**Files:**
- Create: `packages/mcp/mcp-gateway/package.json`
- Create: `packages/mcp/mcp-gateway/tsconfig.json`
- Create: `packages/mcp/mcp-gateway/src/index.ts`
- Create: `packages/mcp/mcp-gateway/src/types.ts`
- Create: `packages/mcp/mcp-gateway/src/invariant.ts`
- Create: `packages/mcp/mcp-gateway/README.md`
- Create: `packages/mcp/mcp-gateway/README.zh.md`
- Create: focused gateway tests and Loader composition fixture
- Modify: package aggregates/manifests required by repository gates
- Modify: `packages/external/external-session-codex/src/index.ts`
- Modify: `packages/external/external-session-codex/src/run.ts`
- Modify: Codex provider README/JSDoc pairs

**Interfaces:**
- Consumes: Tasks 5–6 external principal, approval, recorder; host Web server; MCP SDK.
- Produces:

  ```ts
  import type { ExternalToolPrincipal } from '@deepseek-ai/dsh-tools'

  interface McpGatewayLease extends AsyncDisposable {
    readonly url: string
    readonly bearerToken: string
  }

  interface McpGatewayService {
    create(request: {
      principal: ExternalToolPrincipal
      tools: readonly string[]
      signal: AbortSignal
    }): Promise<McpGatewayLease>
  }
  ```

- [ ] **Step 1: Write failing authentication/allowlist tests**

  Cover missing/wrong bearer, route/session mismatch, unknown tool, unlisted tool, duplicate route, oversized/trailing JSON, timeout, abort, and disposal. Authentication must happen before dispatch.

- [ ] **Step 2: Write failing real pipeline test**

  Boot real tools/approval/gateway composition, list one allowed tool, call it through Streamable HTTP, observe `ctx.tools.execute` waterfalls plus durable external call/result, and prove a second registered tool is invisible and uncallable.

- [ ] **Step 3: Write failing Codex config test**

  Assert per-attachment config contains only the loopback opaque URL and `bearer_token_env_var`, the token is explicit env only, resume rotates endpoint/token without deleting rollout state, and gateway disposal precedes child teardown.

- [ ] **Step 4: Run focused tests and save RED evidence**

  Expected: package/service and Codex gateway wiring are absent.

- [ ] **Step 5: Implement the complete capability**

  Register loopback routes through the existing Web server, reconstruct validated MCP requests, map DSH results to MCP content/structured content/isError, apply fixed size/time bounds from validated Config, and return an awaited disposer. Add package invariant and real Loader composition.

- [ ] **Step 6: Run tests, typecheck, hygiene, docs, and commit**

  Commit as `feat(mcp): expose allowlisted Harness tools`.

---

### Task 8: Opt-in bundle, preflight, and Web routing

**Files:**
- Create: `packages/bundle/web-codex/package.json`
- Create: `packages/bundle/web-codex/cordis.patch.yml`
- Create: `packages/bundle/web-codex/src/index.ts`
- Create: `packages/bundle/web-codex/src/invariant.ts`
- Create: `packages/bundle/web-codex/README.md`
- Create: `packages/bundle/web-codex/README.zh.md`
- Create: bundle tests and fixtures
- Modify: workspace/package manifests and resolver dependencies
- Modify: `packages/external/external-session/src/types.ts`
- Modify: `packages/external/external-session/src/index.ts`
- Modify: `packages/external/external-session-codex/src/index.ts`
- Modify: `packages/host/apiproxy/src/api-proxy.ts`
- Modify: `packages/client/runtime/src/client/sessions/lineage.ts`
- Modify: `packages/client/runtime/src/client/sessions/service.ts`
- Modify: `packages/client/runtime/src/client/sessions/session.ts`
- Modify: affected UI locales, README/JSDoc pairs

**Interfaces:**
- Consumes: completed provider, resume, live UI, and MCP gateway.
- Produces: structured provider preflight; opt-in Web composition; durable client `mode`; correct external prompt/command/settled routing.

- [ ] **Step 1: Write failing preflight/catalog tests**

  Assert binary missing, auth unavailable, invalid config, and sandbox incompatibility appear as typed `session.externalModes` failures. Assert successful preflight is rechecked before create and failure publishes no session.

- [ ] **Step 2: Write failing client routing tests**

  Assert external mode survives list/update/reconnect projections; plain prompt and pass-through slash use `api.sessions.command`; `/compact` and `/model` retain specialized routing; unsupported images/queue/steer/goals fail explicitly without native Agent lookup; settled waits for `external/turn-ended`.

- [ ] **Step 3: Write failing bundle composition tests**

  Boot default Web and assert no external provider. Boot base + web-app + web-codex and assert every required row resolves once, Codex appears, and missing provider dependencies fail loud.

- [ ] **Step 4: Run focused tests and save RED evidence**

  Expected: server rows absent, mode lost in client paths, and native Agent lookup rejects prompts.

- [ ] **Step 5: Implement preflight, routing, and bundle**

  Keep secrets out of YAML. Make command, allowed tools, state root, request bounds, and timeouts validated Config fields. Provide a documented local profile overlay or CLI profile command using the bundle.

- [ ] **Step 6: Run tests, build smoke, docs, and commit**

  Commit as `feat(bundle): add opt-in Codex web mode`.

---

### Task 9: End-to-end proof and current-state documentation

**Files:**
- Create: `apps/web/tests/external-codex-session.e2e.ts` or the repository's exact current Web E2E owner selected by the implementer
- Create: keyless Loader/app-server/MCP fixture files beside their owning test
- Modify: Web accessibility snapshot owners
- Modify: `.agents/notes/implemented/feature/2026-08-18-external-interactive-sessions-phase-1.md`
- Modify: `.agents/notes/implemented/feature/2026-08-18-external-interactive-sessions-phase-1.zh.md`
- Modify: pairing sidecar through the repository generator
- Modify or retire: `.agents/notes/proposed/feature/2026-08-18-external-interactive-agent-sessions.md` and its pair only as allowed by remaining unimplemented scope
- Modify: user-facing setup documentation and website mapping when the selected page is published

**Interfaces:**
- Consumes: all prior tasks.
- Produces: keyless real-product transcript/UI proof; accurate implemented authority; a repeatable local launch path.

- [ ] **Step 1: Write the failing real-composition scenario**

  The fixture must boot through Loader with the opt-in bundle and real pinned Codex app-server against a loopback Responses stream. The test creates a workspace, selects Codex/model/effort, starts a session with no native Agent, submits through the Web client route, observes live then committed text, approves a gated action, performs one allowlisted MCP call, rejects an unlisted call, compacts, restarts the host, resumes the same Codex thread, and submits a second turn.

- [ ] **Step 2: Run replay/snapshot test and save RED evidence**

  Expected: the scenario or snapshots fail at the first uncovered product path.

- [ ] **Step 3: Complete only integration defects exposed by the scenario**

  Use fresh failing focused tests for each discovered defect before changing production code. Do not add new feature scope.

- [ ] **Step 4: Record accessibility and durable transcript expectations**

  Pin mode picker, live response, committed external message, command/file activity, approval row, MCP tool row, compaction notice, and resumed second turn. Assert no page/browser/console errors and complete fixture consumption.

- [ ] **Step 5: Rewrite current-state docs and Agent Note**

  Remove false claims, future-tense acceptance inventories, and stale wire limitations. Preserve unique rationale and explicitly name only the remaining ACP/Claude/agent-driven gaps. Update both languages and re-record pairing.

- [ ] **Step 6: Run final relevant gates and commit**

  Run Web snapshot replay, focused package tests, affected aggregate typechecks, lint, build, hygiene, doc-sync, built opt-in profile smoke, and `git diff --check`. Commit as `test(web): prove interactive Codex sessions`.

---

## Final acceptance audit

- [ ] A fresh final Luna/max reviewer reads the spec, plan, every commit, the full diff, implementer reports, deferred minor findings, and verification output.
- [ ] One Luna/max fix agent addresses every Critical/Important final finding; a fresh Luna/max re-review verifies only that fix diff.
- [ ] The controller verifies each explicit spec requirement against source plus runtime/test evidence and records missing evidence as incomplete work rather than inference.
- [ ] The controller runs fresh final commands from the dsh pre-push workflow matched to changed surfaces; CI-owned exhaustive/platform checks are not claimed locally.
- [ ] The local opt-in profile starts successfully with the packaged or explicitly configured Codex binary and displays `Codex` in the mode picker. Any required ChatGPT login remains a user-owned authentication action and receives an exact command/UI instruction.
