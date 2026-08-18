# Phase 1 — External interactive sessions: foundation + Codex dialect

> **For executors (cheap-model subagents):** you receive ONE task from this plan per dispatch. The task block is self-contained; the Global Constraints below bind every task. Do not read the whole plan unless a task tells you to. Steps are checkbox-tracked; do not tick them — the orchestrator tracks state.

**Goal:** a user opens a session in this GUI in mode `codex`, chats multi-turn with streamed transcript, answers permission prompts, runs `/compact`, switches Codex models — all under harness sandbox policy, replayable from the durable log.

**Architecture:** new capability family `packages/external/` — Service Definition `external-session` (`ctx.externalSessions`) with named providers; first provider `external-session-codex` drives `codex app-server --stdio` persistently. A host-side bridge driver projects agent activity into log-only `external/*` session events; live deltas travel the frame channel without durability. Permissions ride the ask-user interaction channel. The native agent loop is untouched.

**Spec:** [`.agents/notes/proposed/feature/2026-08-18-external-interactive-agent-sessions.md`](../../notes/proposed/feature/2026-08-18-external-interactive-agent-sessions.md) — the plan argues from it; read its Proposal and Risks before your first task.

**Sequencing note (not a contradiction of the spec):** the Codex dialect lands first because its wire code already exists in `packages/subagent/subagent-codex` as evidence and the product demo targets Codex; the ACP provider (the primary wire for the general case) is Phase 2.

## Global Constraints

- Repo rules bind: root `AGENTS.md`, `packages/AGENTS.md`, and — for browser packages — `packages/client/AGENTS.md`. Every package follows `docs/cookbook/adding-a-package.md`.
- ESM everywhere, `strict: true`, no implicit `any`; registrations are effects (`ctx.effect()`/`ctx.on()`); capability seam complete (Service Definition + Provider + Consumer roles) or the task says otherwise.
- New `SessionEventMap` members carry `@mode` and payload `@param` JSDoc and `ignorable: true`; `SESSION_FORMAT_VERSION` stays `0`.
- Misconfiguration fails loud; no hardcoded tunables (validated `Config` fields); opaque ids branded where cross-boundary.
- Product UI copy is Chinese; code comments English; README pairs EN/ZH with Model Experience sections; every package owns `./invariant`.
- Product-visible plugins need a non-unit REAL-composition test through the Loader; model-/user-visible behavior needs a keyless snapshot through a real runnable example.
- Test selection per `dsh-pre-push-checks`; never run the full suite from a task.
- Commit style: one task = one or few commits, `git diff --check` clean, single trailing newline.

## Execution protocol (all phases)

1. Orchestrator (planner model) dispatches one task per subagent on route `knyazev-ai` / `deepseek-v4-flash` (calibrated 2026-08-18: accurate repo reading, strict TS, schema-clean output).
2. Executor implements exactly its task block, runs the checks named in it, commits.
3. Orchestrator reviews the diff (dsh-code-review standards), requests fixes or approves; blockers escalate to the planner model rather than being improvised around.
4. `verify-*` failures are fixed in the same task, never silenced.

---

### Task 0 — Codex app-server evidence spike

**Files:**
- Create: `packages/external/external-session-codex/tests/evidence/` (recorded JSON-RPC transcripts, one file per topic: `thread-persistence.json`, `turn-notifications.json`, `approvals.json`, `models.json`, `compact.json`)
- Create: `packages/external/external-session-codex/tests/evidence/README.md` (how each transcript was produced: command, codex version, seed config)

**Interfaces:**
- Produces: ground-truth method/notification names every later codex task codes against. If a capability is absent in 0.147.0 (model listing, native compact), the evidence file states `ABSENT` plus the closest alternative; Task 4 then uses the documented fallback. Do not guess method names in later tasks — cite the evidence file line in code comments where a wire name is non-obvious.

**Steps:**

- [ ] Use the dev-dependency `@openai/codex@0.147.0` binary (same fixture path as `packages/subagent/subagent-codex`; read its tests first and reuse its harness for spawning and JSON-RPC framing).
- [ ] Record real transcripts: non-ephemeral `thread/start` then a second turn on the same thread and (if supported) `thread/resume` after wire restart; the full notification family during one turn (deltas, tool events, approvals); model listing or config-roster surface; the compact command path (`/compact` slash passthrough vs a dedicated method).
- [ ] In each file, annotate every method with `stable` / `observed-only` judgments referencing `codex-rs/docs` names where they exist.
- [ ] Commit: `test(external-codex): record app-server 0.147 evidence transcripts`.

### Task 1 — `external-session` Service Definition

**Files:**
- Create package `packages/external/external-session/` (package.json, tsconfig per cookbook, `src/index.ts`, `src/types.ts`, `src/invariant.ts`, README EN/ZH + i18n sidecar, tests)
- Modify: workspace aggregate tsconfig (one entry), `packages/README.md` group table (new `external/` group row), root layout mention in `AGENTS.md` repository layout only if the group table requires it (prefer not touching root AGENTS.md)

**Interfaces (Produced — later tasks code against these exact names):**

```ts
/** Named external-agent registry: one provider per mode. */
export interface ExternalSessionsService {
  listAgents(): ExternalAgentDescriptor[];
  start(request: ExternalSessionStart): Promise<void>;
  prompt(sessionId: SessionId, text: string): Promise<{ turnId: ExternalTurnId }>;
  interrupt(sessionId: SessionId): void;
  listModels(provider: string): Promise<ExternalModelInfo[]>;
  setModel(sessionId: SessionId, model: string): Promise<void>;
  dispose(sessionId: SessionId): Promise<void>;
}
export interface ExternalAgentDescriptor {
  readonly provider: string;                       // registry name, also the session mode id
  readonly label: string;                          // UI label (Chinese copy lives client-side)
  readonly modelDirectory: 'provider' | 'config';  // who answers listModels
}
export interface ExternalSessionStart {
  readonly sessionId: SessionId;   // pre-reserved by host session creation (Task 3)
  readonly provider: string;
  readonly cwd: string;            // absolute, names an enterable directory
  readonly model?: string;
}
```

Provider contract (also this package): `ExternalSessionProvider` with the same operations minus registry concerns, plus a `bridge: ExternalBridgeContext` handed at `start` — `appendEvent(sessionId, event)`, `requestPermission(sessionId, ask)`, `streamDelta(sessionId, turnId, delta)` (live-only), and a disposal signal. `SessionId` is imported from `dsh-session` (no cycle: session does not depend on external).

**Steps:**

- [ ] Write failing unit tests first: registry add/list/dispose (HMR-safety pattern from any `ctx.subagents` provider test), unknown-provider `start` rejects loud, provider `listModels` dispatch, `modelDirectory: 'config'` provider answering from Config.
- [ ] Implement service + types; default-export the service class (packages/AGENTS.md export rule); `Config`: `providers: Record<string, unknown>` passthrough validated by each provider package, not here.
- [ ] `invariant.ts`: register manifest name; assert the registry↔descriptor relation (a started session's provider is always a listed descriptor) via the event stream or explain the empty installer per package rules.
- [ ] README EN/ZH: role, registry, events pointer to Task 2's subsystem section, full canonical Model Experience section (state: no model-visible effect in parent sessions — log-only family).
- [ ] Checks: package tests, `pnpm run typecheck` filtered if available, `verify-package-readme-limitations` concerns (Known Limitations: no streaming durability guarantee statement, provider-agnostic permission semantics pointer).
- [ ] Commit: `feat(external-session): mode registry service definition`.

### Task 2 — `external/*` session events + replay projection

**Files:**
- Modify: `packages/session/…` where `SessionEventMap` lives (declaration-merging home for external events — locate the actual merging example first, e.g. how `subagent/descriptor` or `approval/asked` events merge, and follow it exactly)
- Create: projection units so replay folds external events (same package/mechanism as existing projection units)

**Interfaces (Produced — exact event names; payloads are minimal JSON):**

```
external/session-started { provider, cwd, model? }
external/turn-started    { turnId }
external/message-added   { turnId, role: 'user' | 'agent', text }   // committed units only
external/tool-activity   { turnId, kind: 'call' | 'update' | 'result', title, detail? }
external/permission-asked   { askId, title, options: string[] }
external/permission-decided { askId, outcome: 'allowed' | 'rejected' | 'cancelled' }
external/model-switched  { model }
external/compaction-noticed { notice }
external/turn-ended      { turnId, stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' }
external/session-ended   { stopReason }
```

All `ignorable: true`, log-only, `@mode` documented. Deltas are NEVER logged: `streamDelta` exists only on the live frame path (bridge → host frame channel, cumulative `markFrameDirty`).

**Steps:**

- [ ] Failing tests: each event round-trips through the session log and replays; unknown-`external/*` on read does not corrupt replay (ignorable contract); projection folds a scripted turn sequence into one transcript-shaped state.
- [ ] Implement merging + projection; no changes to `SESSION_FORMAT_VERSION`.
- [ ] Update the session subsystem doc's event table (one row per event, log-only mode) and zh side.
- [ ] Commit: `feat(session): external session event vocabulary`.

### Task 3 — Mode-aware host session creation

**Files:**
- Modify: host session-creation path (locate the RPC the web client's session-create call reaches; add `mode?: string`), `SessionHeader`-adjacent metadata so the mode is durable (follow how `origin: 'subagent'` is stamped — same mechanism, `mode` field with default `'dsh'`)
- Modify: bridge-driver host service (new, small): owns provider lifecycle per external session, wires provider events into the session log through Task 1's bridge, disposes on session close

**Steps:**

- [ ] Failing test: creating a session with `mode: 'codex'` when the provider is registered starts a bridge (observable: `external/session-started` in log, process spawned through the subprocess seam) and no native Agent is created for it; `mode: 'dsh'` path unchanged byte-for-byte; unknown mode fails loud at creation.
- [ ] Implement; snapshot: one keyless REAL-composition boot test creating both modes with a stub provider package (mock only the external process, per REAL-composition policy).
- [ ] Update `docs/subsystems/` host/session docs where session creation is described (EN/ZH).
- [ ] Commit: `feat(host): external session mode at creation`.

### Task 4 — `external-session-codex` provider

**Files:**
- Create: `packages/external/external-session-codex/` (full cookbook skeleton + tests; reuse `packages/subagent/subagent-codex` framing/handshake code by import if it exports it, otherwise extract the shared JSON-RPC wire bits into that package's exported surface rather than duplicating)

**Interfaces:**
- Consumes: Task 1 provider contract, Task 2 bridge events, Task 0 evidence transcripts (wire names), Task 5 permission bridge (`bridge.requestPermission`).

Config (validated, loud): `command` (default resolve `codex` from PATH like subagent-codex), `args`, `env` (over scrubbed ambient), `disposeGraceMs` (default 3000, ≤ MAX_TIMER_DELAY_MS), `modelRoster` (required fallback list when evidence says no native listing: explicit `{ id, label }[]`; misconfiguration — empty roster with `modelDirectory: 'config'` — fails at load).

**Steps:**

- [ ] Failing tests first, using the pinned fixture (keyless; same launch pattern as subagent-codex tests): persistent thread across two `prompt` calls; turn notifications → `external/message-added` + `external/tool-activity` + live deltas through `streamDelta`; `turn/interrupt` on session interrupt → `aborted`; approval request → bridge ask → decision applied (allow/reject arms); disposal ladder (stdin EOF grace → SIGTERM → SIGKILL, whole-tree join); cold reattach if evidence shows `thread/resume` (else: session-ended with `error` and a loud README limitation).
- [ ] Implement: spawn via `dsh-subprocess` under `ctx.sandbox` session policy; `initialize` → non-ephemeral `thread/start { cwd }`; provider-managed depth is out of scope (no parent agent).
- [ ] Compatibility section in README citing Task 0 evidence; Known Limitations: pinned 0.147.0, whatever Task 0 marked ABSENT.
- [ ] Commit (series allowed): `feat(external-codex): persistent app-session provider`.

### Task 5 — Permission bridge (ask-user channel)

**Files:**
- Create: host-side bridge plugin under `packages/interaction/` (name: `external-permission` — follow group naming), wiring `bridge.requestPermission` to the ask-user/user-questions channel with a permission-shaped ask (title, options, optional detail); fail-closed on dismissal/timeout/no-answerer
- Modify: the ask surface's client plugin only if a new ask kind is needed (prefer reusing an existing generic question card with explicit options)

**Steps:**

- [ ] Failing tests: ask → allow path applies the decision to a stub provider; dismissal/timeout → `'cancelled'` and the provider's fail-closed arm runs; no answerer → fail closed without hanging (bounded wait, Config `timeoutMs`).
- [ ] Audit note in README: Phase 1 has no `approval/asked` pair (no open DSH turn — link the spec note); Phase 3 supersedes with the approval seam.
- [ ] Commit: `feat(interaction): external agent permission bridge`.

### Task 6 — Commands: `/compact` and `/model` for external sessions

**Files:**
- Modify: commands service consumer surface to route per-session-mode: in external sessions, `/compact` maps to the provider's native compact (Task 0 evidence names the mechanism; if ABSENT, prompt-passthrough of `/compact` text with the notice event recorded on turn end) and records `external/compaction-noticed`; `/model` opens the mode's model directory (Task 7 seat) and calls `setModel` → `external/model-switched`.
- Unknown slash commands in external mode pass through as prompt text (documented, tested).

**Steps:**

- [ ] Failing tests per arm; keyless snapshot of a `/compact` exchange with the stub provider from Task 3's composition test.
- [ ] Commit: `feat(commands): external session compact and model routing`.

### Task 7 — Client: `ui-session-mode` package

**Files:**
- Create: `packages/client/ui-session-mode/` per the new-plugin checklist in `packages/client/AGENTS.md` (skeleton, three registration surfaces: aggregate tsconfig, `cordis.patch.yml` row, web-app package dependency)

**Interfaces:**
- Consumes: session-create RPC `mode` (Task 3), `ctx.externalSessions.listAgents()`/`listModels` surfaced to the client per the existing session RPC conventions (follow how `session.models` is exposed — same channel, per-session).

UI: mode picker on the new-session surface (Chinese copy: 模式; rows: DSH 智能体 / Codex / …from registry), and when an external mode is selected, a model seat fed by that provider's directory (provider-native ids; `config` roster fallback renders verbatim).

**Steps:**

- [ ] Component tests per client rules (props-driven, jsdom pragma, assert behavior not classes): mode list renders from registry data; model seat disabled with an inline reason when the directory fails; selection submits creation with `mode` + `model`.
- [ ] `pnpm run test:gui`; then `DSH_SNAPSHOT=replay pnpm run test:web` (visible assembled output changed).
- [ ] Commit: `feat(ui): session mode picker with external agent modes`.

### Task 8 — Client: external transcript nodes

**Files:**
- Create: external node definitions inside `ui-session-mode` (or a sibling `ui-external-transcript` if domain-graph verification prefers the split — decide by `verify-client-domain-graph` levels, one domain per conversation feature) registering `ConversationNodeDefinition`s for `external/message-added`, `external/tool-activity`, permission asked/decided card, `external/compaction-noticed`, `external/model-switched`

**Steps:**

- [ ] Follow `docs/cookbook/adding-a-conversation-node.md` exactly (match on current event; fold deterministically by seq; no full-window scans).
- [ ] Tests: replay parity — a scripted log renders identically to the live-streamed session (stub frame channel); permission card shows options and submits the decision callback.
- [ ] `pnpm run test:gui` + `DSH_SNAPSHOT=replay pnpm run test:web`.
- [ ] Commit: `feat(ui): external session transcript nodes`.

### Task 9 — REAL-composition, snapshots, GIF, docs sweep

**Steps:**

- [ ] Keyless REAL-composition boot test: full `cordis.yml` through the Loader + app with the pinned codex fixture; asserts the transcript contains streamed turns, a permission round-trip, `/compact` notice, replay after reload.
- [ ] `test:snapshot` additions (record with key; replay keyless) for the codex-mode transcript.
- [ ] GIF per `record-browser-gif` skill (PR requirement for GUI behavior changes).
- [ ] Docs sweep: `docs/subsystems/external.md` (EN/ZH, register in website mappings via `dsh-doc-site-sync` skill), group README, budget checks, `pnpm run doc-sync`, `git diff --check`.
- [ ] Commit: `test(external): real-composition coverage + docs`.

### Task 10 — Orchestrator review pass

Planner model runs `dsh-code-review` standards over the stack, verifies each acceptance criterion from the spec note against shipped behavior, and updates the note body facts (paths, names) where implementation settled differently. Phase 2 plan is then finalized from Phase 1's settled interfaces.
