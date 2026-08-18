# Codex app-server 0.147.0 — evidence transcripts

Recorded JSON-RPC transcripts of the **real** `codex app-server --stdio` wire for
`@openai/codex@0.147.0`, captured through an in-process OpenAI Responses SSE
fixture. These are the ground-truth method and notification names every later
Codex task codes against.

## Environment

- **Codex version:** `codex-cli 0.147.0` (native binary, not the npm launcher).
  Reproduce: `node record-spike.mjs <native-codex-binary>`.
- **Native binary resolution** in `record-spike.mjs`: a path passed as `argv[2]`
  wins; otherwise it resolves the platform package under the
  `@openai/codex@0.147.0` devDependency of `packages/subagent/subagent-codex`
  (hoisted into the workspace `.pnpm` store, so pass it explicitly on this
  checkout). On this machine:
  `node_modules/.pnpm/@openai+codex@0.147.0/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`.
- **Seed config** (written to `$CODEX_HOME/config.toml`, shared with
  `real-product.spec.ts`): `model = "fixture-model"`,
  `model_provider = "fixture"`, `approval_policy = "on-request"`,
  `sandbox_mode = "read-only"`, `disable_response_storage = false`, and a
  `[model_providers.fixture]` block pointing `base_url` at the loopback fixture
  (`wire_api = "responses"`, `requires_openai_auth = false`,
  `env_key = "OPENAI_API_KEY"`). Ambient network proxies are scrubbed and
  `NO_PROXY` pins `127.0.0.1,localhost`.
- **Fixture:** the same Responses SSE event sequence as
  `packages/subagent/subagent-codex/tests/responses-fixture.ts` (a
  `complete` text turn and a `function_call` turn), served per model request.
- **Framing:** newline-delimited JSON-RPC over the child's stdio. Several turns
  reuse `thread/start { ephemeral: false }` so the thread persists to a rollout
  `.jsonl` under `$CODEX_HOME/sessions/`.

## How each transcript was produced

Every file is produced by one run of `record-spike.mjs` (the recorder named in
the intro above lives in this directory alongside the transcripts):
`node record-spike.mjs /path/to/native/codex`. The recorder drives each scenario,
captures every frame (client requests/notifications, server responses,
server→client requests, server notifications, and trimmed fixture requests), and
writes the JSON files in place. Volatile values (UUIDs, absolute paths,
millisecond timestamps) are replaced with `<volatile:...>` markers for stable
diffs; fixture request bodies are trimmed to model, per-role input text, and
advertised tool names.

| transcript | produced by | what it proves |
| --- | --- | --- |
| `thread-persistence.json` | initialize → `thread/start{ephemeral:false}` → two `turn/start` on the same `threadId` → process close → **fresh process** `thread/resume{threadId}` against the same `CODEX_HOME` | non-ephemeral thread; a second turn on the same thread; cold reattach after a wire restart |
| `turn-notifications.json` | one `complete` turn then one `hold` turn interrupted with `turn/interrupt` | the notification family during one turn and the interrupted-stop path |
| `approvals.json` | two turns, each driving a `shell_command` tool call under `approval_policy = "on-request"`; the recorder answers `item/commandExecution/requestApproval` with `accept` then `decline` | the tool-call → approval-request → decision → resolve round-trip on both arms |
| `models.json` | initialize → `model/list` | the native model-listing surface |
| `compact.json` | one turn, then `thread/compact/start{threadId}` | the dedicated compact path |

## Annotations

Each method below is marked:

- **`stable`** — confirmed against the generated protocol for this exact
  version, `codex app-server generate-ts --out <dir>` /
  `app-server generate-json-schema --out <dir>` (0.147.0 source of truth; also
  where codex-rs/docs-derived names live). Do not expect these names to change
  in a patch bump.
- **`observed`** — present in a real recorded payload in these transcripts
  (the sanity gate is: a name is not annotated `observed` unless it appears in
  a transcript file).

### Client → server requests

| method | judgment | notes |
| --- | --- | --- |
| `initialize` | stable, observed | handshake; response carries `userAgent`, `codexHome`, `platformFamily`, `platformOs`. |
| `thread/start` | stable, observed | `{ cwd, ephemeral }`; `ephemeral:false` persists to a rollout `.jsonl` (see `.result.thread.path` and `thread/started`). |
| `turn/start` | stable, observed | `{ threadId, input: [{ type: "text", text, text_elements: [] }] }`; response `{ turn }`, then `turn/started`. |
| `turn/interrupt` | stable, observed | `{ threadId, turnId }`; responds `{}`; settles the turn with `turn/completed` status `interrupted`. |
| `thread/resume` | stable, observed | `{ threadId }` resumes a persisted thread; on the cold-restart process it returned a `thread` plus `initialTurnsPage`, `turnsBackwardsCursor`, `itemsBackwardsCursor`. |
| `model/list` | stable, observed | native model roster; returns `{ data: [...], nextCursor }`. **Not ABSENT** in 0.147.0. |
| `thread/compact/start` | stable, observed | **the** compact path. **Not ABSENT**: a dedicated method (not a `/compact` slash passthrough). Responds `{}` immediately; compaction runs as a background turn (`turn/started`, `item/started`, extra model rounds, `turn/completed`). |
| `initialized` (client notification) | stable, observed | sent once after `initialize`. |

### Server → client requests

| method | judgment | notes |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | stable, observed | tool escalation; params carry `threadId`, `turnId`, `itemId`, `startedAtMs`, `environmentId`, `reason`, `command`, `commandActions`, `proposedExecpolicyAmendment`, `availableDecisions`. Answer `{ decision }`. |
| decision value `accept` | stable, observed | allow arm (transcript `approvals.json`); command actually executed (`true`). |
| decision value `decline` | stable, observed | reject arm; turn continues and completes. |
| decision value `cancel` (and `acceptWithExecpolicyAmendment`) | stable, generated | offered in `availableDecisions` in the recorded approval request; not re-answered in this spike. |

`item/permissions/requestApproval`, `item/tool/requestUserInput` and
`mcpServer/elicitation/request` appear in the generated protocol but were **not
observed** in these transcripts (no unsandboxed write or MCP tool in the script);
the subagent-codex `wire.ts` already answers them and is the reference for their
shapes.

### Server notifications

| method | judgment | notes |
| --- | --- | --- |
| `thread/started` | stable, observed | full `thread` object, emitted after `thread/start`/`thread/resume`. |
| `turn/started` | stable, observed | `{ threadId, turn }`. |
| `item/started` | stable, observed | `{ item, threadId, turnId, startedAtMs }`; item `type` includes `userMessage`, `agentMessage`, `commandExecution`. |
| `item/agentMessage/delta` | stable, observed | streaming assistant text: `{ threadId, turnId, itemId, delta }`. |
| `item/completed` | stable, observed | committed item, `{ item, threadId, turnId, completedAtMs }`. |
| `turn/completed` | stable, observed | terminal: `{ threadId, turn: { id, items, status, ... } }`; `status` ∈ `completed`/`interrupted`/`failed`. |
| `thread/status/changed` | stable, observed | lifecycle including `active`/`idle` and `activeFlags: ["waitingOnApproval"]`. |
| `thread/tokenUsage/updated` | stable, observed | `{ threadId, turnId, tokenUsage }`. |
| `serverRequest/resolved` | stable, observed | `{ threadId, requestId }`, emitted after the client answers a server request. |
| `warning` | stable, observed | e.g. "Model metadata for `fixture-model` not found" — expected with a fixture model. |
| `account/rateLimits/updated`, `remoteControl/status/changed` | stable, observed | ambient lifecycle notifications. |
| `thread/compacted` | stable, generated | in the generated protocol; not observed in the small compact fixture window (compaction completed via `turn/completed` only). |

## Findings for later tasks

- **Model listing exists natively** (`model/list`): no fallback roster is
  required. The recorded roster for this build: `gpt-5.6-sol`, `gpt-5.6-terra`,
  `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.2` (the fixture-provided model is not in it,
  hence the `warning` notification).
- **Compact is a dedicated method** (`thread/compact/start`, async, returns
  `{}`), not a `/compact` slash passthrough. There is no slash-command namespace
  on the app-server wire.
- **Threads persist and cold-resume**: `ephemeral:false` + `thread/resume`
  work across a process restart, so the persistent-session provider can reattach
  instead of ending with `error`.
- **Approval decisions** map cleanly: allow → `accept`, reject → `decline`,
  plus `cancel`. The wire exposes `availableDecisions` to pick from.
