# External Codex Web UI 实施计划

[English](2026-08-20-external-codex-web-ui.md) | 中文

> **面向 agent（智能体）执行者：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 子技能，逐项执行本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 完成原生 Codex external-session 路径，使本地用户可以完全在 DeepSeek Harness Web UI 内创建、对话、批准、恢复会话，并从 Codex 使用已允许的 Harness 工具。

**架构：** 现有 `ctx.externalSessions` provider 继续作为驱动边界。Codex 作为官方 app-server 在 Harness sandbox 下运行，并使用私有状态根；类型化 live frame 与持久化提交事件进入现有 conversation UI；显式 external tool principal 通过普通工具管线承载 Harness policy；经过认证的 loopback MCP gateway 暴露固定 allowlist。独立 Web bundle 让功能保持 opt-in。

**技术栈：** TypeScript ESM、Cordis plugins、Typert RPC、React client plugins、Codex app-server JSONL RPC、带 Streamable HTTP 的 MCP TypeScript SDK、Vitest、Loader real-composition fixture、Web snapshot replay。

**规格：** `docs/superpowers/specs/2026-08-20-external-codex-web-ui-design.md`

## 全局约束

- 每个实现和评审 agent 使用 `gpt-5.6-luna` 与 `reasoning_effort=max`；controller 不写生产代码。
- 遵循 red-green TDD：在修改生产代码前记录失败命令及输出，修改后记录通过命令及输出。
- 只在 `/Users/knyaz/deepseek-harness-external-codex` 的 `codex/external-codex-ui` 上工作；不要触碰用户的主 checkout 或无关的未跟踪文件。
- 保持默认 Web 行为：Codex 仍是 opt-in bundle，external session 绝不注册 native Agent 或运行 native agent loop。
- 绝不直接调用 `ToolDefinition.execute()`；MCP 调用必须进入 `ctx.tools.execute`，并保留 restrictions、guards、approvals、events、validation 与 durable results。
- 绝不把受限 session 弱化为不受限执行。`read-only` 不授予状态写入，`workspace-write` 只授予 workspace 加一个 host-owned state root，只有 `danger-full-access` 绕过 confinement。
- credentials、bearer token、原始 session id 和 Codex 状态路径绝不进入 logs、session events、URLs、命令行、snapshots 或 diagnostics。
- provider resume 要求持久化 Codex thread id，绝不回退到 `thread/start`。
- live delta 保持非持久化；reconnect 清除 partial，已提交的 `external/message-added` 才是权威状态。
- 同一任务中更新受影响的 README/JSDoc contract 及中英文配对，并在最终验证前更新所属的 implemented Agent Note。
- 不要编辑 `vendor/` 或 `.agents/notes/archived/`。

### 任务 1：有状态子进程 confinement

**文件：**
- 修改：`packages/sandbox/sandbox/src/index.ts`
- 修改：`packages/sandbox/sandbox/src/roots.ts`
- 修改：`packages/sandbox/sandbox-local/src/profiles.ts`
- 修改：`packages/sandbox/sandbox-local/src/index.ts`
- 修改：`packages/sandbox/sandbox-windows-acl/src/index.ts`
- 修改：相关 sandbox README/JSDoc 的中英文配对
- 测试：`packages/sandbox/sandbox/tests/roots.spec.ts`
- 测试：`packages/sandbox/sandbox-local/tests/profiles.spec.ts`
- 测试：`packages/sandbox/sandbox-local/tests/local.spec.ts`
- 测试：实现报告中点名的 Windows ACL focused tests

**接口：**
- 使用：现有 `SandboxExecutionPolicy`、`SandboxProvider.confine`、`writableRoots`。
- 产出：`SandboxExecutionPolicy.stateRoot?: string`；每个已发布的 local backend 只在 `workspace-write` 下授予 canonical state root。

- [ ] **步骤 1：编写失败的 policy/root 测试**

  增加等价于以下内容的用例：

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

  固定 canonicalization、deduplication、macOS profile 规则、Linux/bwrap binding、Landlock argv，以及 Windows private state 的授予和撤销。

- [ ] **步骤 2：运行 focused tests 并保存 RED 证据**

  使用 bundled Node 22+ runtime 运行准确的 sandbox 测试文件。预期失败，因为 `stateRoot` 尚不存在或没有被授予权限。

- [ ] **步骤 3：实现最小 state-root policy**

  在 policy 类型与 grant 派生逻辑中加入可选的 host-owned root。在构建 runner argv 之前验证它是绝对、canonical 的路径。不要增加通用且无界的 writable-root 数组。保留现有 private-temp capability，并由调用者负责 state-root 清理。

- [ ] **步骤 4：运行测试和 package typecheck**

  预期所有新的 policy/profile/grant 测试通过且没有新增 warning；受影响 package 的 typecheck 通过。

- [ ] **步骤 5：更新 contract 并提交**

  用精确的 `stateRoot` 条件更新 sandbox README/JSDoc，并以 `feat(sandbox): confine stateful child storage` 提交。

### 任务 2：Codex settings、状态与进程结算

**文件：**
- 修改：`packages/external/external-session/src/types.ts`
- 修改：`packages/external/external-session-codex/src/index.ts`
- 修改：`packages/external/external-session-codex/src/run.ts`
- 修改：`packages/external/external-session-codex/src/wire.ts`
- 修改：`packages/host/apiproxy/src/api-proxy.ts`
- 修改：`packages/external/external-session-codex/package.json`
- 修改：相关 README/JSDoc/evidence 的中英文配对
- 测试：`packages/external/external-session-codex/tests/unit.spec.ts`
- 测试：`packages/external/external-session-codex/tests/external-session-codex.spec.ts`
- 测试：`packages/host/apiproxy/tests/api-proxy-mode.spec.ts`

**接口：**
- 使用：任务 1 的 `SandboxExecutionPolicy.stateRoot`、session sandbox 与 approval fold。
- 产出：解析后的 `ExternalSessionStart` settings；受 confinement 的 Codex spawn；稳定的 `thread/start`、`thread/resume` 与 `turn/start` overrides；进程死亡后 settled active turn。

- [ ] **步骤 1：编写失败的 wire/settings/confinement 测试**

  覆盖以下 request fields 与精确映射：

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

  断言 `ask -> on-request`、`never -> never`、thread 与 turn 上的 model、`reasoningEffort -> effort`，以及精确的 POSIX/Windows confined argv。断言 explicit secrets 只通过配置的 env 保留，而 ambient credential-shaped 值会被清理。

- [ ] **步骤 2：编写失败的 process-death 测试**

  启动一个 turn，在 `turn/completed` 之前终止 app-server，然后提交另一个 prompt。预期新行为：第一个 turn 记录 failure/abortion，旧 listeners 与 tree 完成结算，第二个 prompt 到达恢复后的 process，而不是停在 `activeEnd` 上。

- [ ] **步骤 3：运行 focused tests 并保存 RED 证据**

  预期失败会显示缺少 wire fields、原始 subprocess argv 和未结算的 `activeEnd`。

- [ ] **步骤 4：实现 settings 与 confinement**

  从预留 id 解析 live `Session`，折叠 `ctx.sandboxPolicy` 与 `ctx.approval`，在配置的 Harness-owned storage 下创建每 session 私有的 Codex state directory，并把 `{ ...resolvedPolicy, stateRoot }` 传给 `ctx.sandbox.confine`。解析 packaged `@openai/codex` launcher 时不得进行 shell interpolation，同时保留显式 `command` 优先级。

- [ ] **步骤 5：实现稳定的 runtime model/effort 切换**

  替换无条件的 `setModel` rejection。将选中的 model/effort 存入 live session，并应用到下一个稳定的 `turn/start`；只有 setting 被接受后才记录 `external/model-switched`。不要启用 experimental app-server APIs。

- [ ] **步骤 6：实现 quiescent process failure/disposal**

  一个 lifecycle controller 负责 listeners、fatal settlement、active turn、child handle 与 teardown。先关闭 listeners，再 kill，恰好一次结算 active turn，terminate，等待 `waitForExit` 与 `done`，然后才允许 respawn。

- [ ] **步骤 7：运行测试、typecheck、更新文档并提交**

  重新生成或重新读取 0.147.0 schemas/evidence，删除过时的“没有 model field”说法，更新 README/JSDoc 配对，并以 `feat(external-codex): inherit settings and confinement` 提交。

### 任务 3：持久化 thread identity 与按需 resume

**文件：**
- 修改：`packages/session/session-projection/src/external-transcript.ts`
- 修改：`packages/external/external-session/src/types.ts`
- 修改：`packages/external/external-session/src/index.ts`
- 修改：`packages/external/external-session-codex/src/index.ts`
- 修改：`packages/external/external-session-codex/src/run.ts`
- 修改：`packages/external/external-session-bridge/src/index.ts`
- 修改：`packages/host/apiproxy/src/api-proxy.ts`
- 修改：受影响 README/JSDoc 的中英文配对
- 测试：`packages/session/session-projection/tests/external-transcript.spec.ts`
- 测试：`packages/external/external-session/tests/service.spec.ts`
- 测试：`packages/external/external-session-codex/tests/external-session-codex.spec.ts`
- 测试：`packages/external/external-session-bridge/tests/driver.spec.ts`
- 测试：`packages/host/apiproxy/tests/api-proxy-external-command.spec.ts`

**接口：**
- 使用：任务 2 的 process/session settings 与 Codex state root。
- 产出：持久化的 `providerThreadId`；显式 provider/service `resume`；每 session 一次按需 cold attachment。

- [ ] **步骤 1：编写失败的 durable identity 测试**

  扩展已提交的 start payload：

  ```ts
  interface ExternalSessionStartedData {
    provider: string
    cwd: string
    model?: string
    providerThreadId: string
  }
  ```

  断言事件仅在 `thread/start` 成功后出现，且 projection/replay 保留 opaque id 而不渲染它。

- [ ] **步骤 2：编写失败的 explicit-resume 测试**

  在 provider 与 registry contract 中加入 `resume(request, bridge, providerThreadId)`。断言 unknown/missing ids 会拒绝，重复 attachment 共享一个 promise，失败的 resume 移除 live route，并且不会发生 `thread/start` request。

- [ ] **步骤 3：编写失败的 host restart 测试**

  将 Codex external session 持久化到 JSONL，创建新的 host composition，在不 spawn child 的情况下读取 history，发出第一个 prompt，并断言 `SessionPersistence.prepare` 恢复同一个 session，随后恰好一个 `thread/resume`。

- [ ] **步骤 4：运行 focused tests 并保存 RED 证据**

  预期缺少 id/API 与当前空 session recreation 会产生失败。

- [ ] **步骤 5：实现 resume 与 cold materialization**

  分离 `start` 与 `resume` 路径。cold session 使用 persistence prepare/enter/announce 模式，而不是 `ctx.sessions.create`。保留 in-flight attachment map，并在 rejection 时回滚。history/list 操作仍保持不启动 process。

- [ ] **步骤 6：运行测试、typecheck、更新文档并提交**

  预期 restart test 证明同一个 durable DSH session 与同一个 Codex thread。以 `feat(external): resume durable Codex sessions` 提交。

### 任务 4：Live delta transport 与 UI seat

**文件：**
- 修改：`packages/external/external-session/src/index.ts`
- 修改：`packages/host/apiproxy/src/api/events.ts`
- 修改：`packages/host/apiproxy/src/api/events.schema.ts`
- 修改：`packages/host/apiproxy/src/api-proxy.ts`
- 修改：`packages/client/runtime/src/client/sessions/manager.ts`
- 修改：`packages/client/runtime/src/client/sessions/session.ts`
- 修改：`packages/client/runtime/src/client/sessions/notifier.ts`
- 修改：`packages/client/ui-conversation/src/client/contract/slots.ts`
- 修改：`packages/client/ui-conversation/src/client/chat/ChatView.tsx`
- 修改：`packages/client/ui-session-mode/src/client/transcript/external-nodes.tsx`
- 修改：`packages/client/ui-session-mode/src/client/transcript/register.ts`
- 修改：受影响 README/JSDoc/locales 的中英文配对
- 测试：实现报告中点名的准确 host/client/UI 文件

**接口：**
- 使用：现有 `ExternalBridgeContext.streamDelta` 与 host mux。
- 产出：类型化 `external/session-delta` Cordis event；`external/delta` mux frame；每 turn 的 client accumulator；external live UI slot。

- [ ] **步骤 1：编写失败的 service/mux 测试**

  断言 provider delta 发出并序列化为：

  ```ts
  const frame = { type: 'external/delta', sessionId: 'session-id', turnId: 'turn-id', delta: 'text' }
  ```

  无效 id/data 必须被 schema 拒绝；不得追加 session event。

- [ ] **步骤 2：编写失败的 client lifecycle 测试**

  断言按顺序累积、notifier frame batching、committed-message retirement，以及 disconnect/reconnect/subscription replacement/turn failure 时清除。

- [ ] **步骤 3：编写失败的 renderer 测试**

  断言 partial Markdown 出现在 external live seat，并在 durable committed text 到达时消失。

- [ ] **步骤 4：运行 focused tests 并保存 RED 证据**

  预期缺少 mux variant、accumulator 和 seat。

- [ ] **步骤 5：实现 host/client/UI 路径**

  service 发出事件时不导入 host types。只向已订阅 clients broadcast。未 materialize 的 session 丢弃 frame。使用 `markFrameDirty`，而不是 durable invalidation，绝不合成 session events。

- [ ] **步骤 6：运行测试、GUI 检查、更新文档并提交**

  以 `feat(client): stream external agent deltas` 提交。

---

### 任务 5：External tool execution principal

**文件：**
- 修改：`packages/core/tools/src/index.ts`
- 修改：实现者发现并在报告中命名的 tool runtime helper/type 文件
- 修改：`packages/core/tools/src/invariant.ts`
- 修改：当前要求 `exec.agent` 的 eligible shell/filesystem tool consumers
- 修改：受影响 subsystem 文档、README/JSDoc 的中英文配对
- 测试：`packages/core/tools/tests/scoped.spec.ts`
- 测试：`packages/core/tools/tests/tools.spec.ts`
- 测试：`packages/core/tools/tests/execution-mode.spec.ts`
- 测试：`packages/core/tools/tests/invariant.spec.ts`

**接口：**
- 使用：native `Agent` execution identity 与当前 tool pipeline。
- 产出：

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

  `ToolExecutionInput` 只接受 `agent` 或 `principal` 二者之一；共享 helper 从中返回 scope/session，不伪造 Agent。

- [ ] **步骤 1：编写失败的 identity 与 pipeline 测试**

  断言 XOR validation、scoped registration lookup、restrictions、guards、cancellation、waterfall events、output validation 与 result dispatch 对 native Agent 和 external principal 都成立。断言不会注册 `ctx.agents`。

- [ ] **步骤 2：编写失败的 eligible-tool 测试**

  证明 shell/filesystem tools 派生 external session policy。证明 ask-user、schedule、workflow、Cordis self-modification、terminal/jobs 和 subagent tools 在明确适配前不在 external allowlist 内。

- [ ] **步骤 3：运行 focused tests 并保存 RED 证据**

  预期当前 interfaces 只接受 `agent`，或者丢失 session policy。

- [ ] **步骤 4：实现 execution subject helpers**

  加入显式的 discriminated execution identity，保持所有现有 native call sites source-compatible，并通过一个 helper 路由 session/scope 读取。不要暴露内部 schedulers，也不要仅因 typed same-process boundary 而扩大 hostile-input validation。

- [ ] **步骤 5：运行测试、typecheck、文档检查并提交**

  以 `feat(tools): execute for external principals` 提交。

### 任务 6：External approvals 与 durable tool records

**文件：**
- 修改：`packages/interaction/user-approval/src/index.ts`
- 修改：`packages/interaction/user-approval/src/types.ts`
- 修改：`packages/interaction/user-approval/src/invariant.ts`
- 修改：`packages/session/session-projection/src/external-transcript.ts`
- 修改：`packages/external/external-session/src/types.ts`
- 修改：`packages/external/external-session/src/index.ts`
- 修改：受影响 README/JSDoc 的中英文配对
- 测试：`packages/interaction/user-approval/tests/approval.spec.ts`
- 测试：`packages/interaction/user-approval/tests/invariant.spec.ts`
- 测试：`packages/session/session-projection/tests/external-transcript.spec.ts`
- 测试：`packages/external/external-session/tests/service.spec.ts`

**接口：**
- 使用：任务 5 的 `ExternalToolPrincipal` 与 recorder。
- 产出：`ApprovalService.requestExternal`；由 branded call id 配对的 `external/tool-call` 与 `external/tool-result` durable events。

- [ ] **步骤 1：编写失败的 external approval 测试**

  断言 effective session policy、scoped answerer routing、allow/reject/cancel/unavailable、principal disposal 时 abort，以及不需要或伪造 native `turn/start` 的 external audit pair。

- [ ] **步骤 2：编写失败的 tool record 测试**

  断言一个 call event 先于一个 result event，arguments/results 是 JSON-safe 且有界，errors 是显式的，并且 replay 将它们折叠为 external transcript tool nodes。

- [ ] **步骤 3：运行 focused tests 并保存 RED 证据**

  预期当前 approval request 要求 `Agent` 与打开的 native turn；当前 `external/tool-activity` 无法携带完整 gateway call/result。

- [ ] **步骤 4：实现显式 external approval 与 recorder**

  保持 native approval 语义不变。增加按 principal/session/call id 标识的 external waterfall 与 invariant bracket。recorder 只在 pipeline commit points 追加 committed events。

- [ ] **步骤 5：运行测试、typecheck、文档检查并提交**

  以 `feat(interaction): approve external tool calls` 提交。

### 任务 7：认证的 MCP gateway 与 Codex consumer

**文件：**
- 创建：`packages/mcp/mcp-gateway/package.json`
- 创建：`packages/mcp/mcp-gateway/tsconfig.json`
- 创建：`packages/mcp/mcp-gateway/src/index.ts`
- 创建：`packages/mcp/mcp-gateway/src/types.ts`
- 创建：`packages/mcp/mcp-gateway/src/invariant.ts`
- 创建：`packages/mcp/mcp-gateway/README.md`
- 创建：`packages/mcp/mcp-gateway/README.zh.md`
- 创建：focused gateway tests 与 Loader composition fixture
- 修改：repository gates 所需的 package aggregates/manifests
- 修改：`packages/external/external-session-codex/src/index.ts`
- 修改：`packages/external/external-session-codex/src/run.ts`
- 修改：Codex provider README/JSDoc 配对

**接口：**
- 使用：任务 5–6 的 external principal、approval、recorder；host Web server；MCP SDK。
- 产出：

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

- [ ] **步骤 1：编写失败的 authentication/allowlist 测试**

  覆盖缺失/错误 bearer、route/session mismatch、unknown tool、unlisted tool、duplicate route、oversized/trailing JSON、timeout、abort 和 disposal。认证必须早于 dispatch。

- [ ] **步骤 2：编写失败的 real pipeline 测试**

  启动真实 tools/approval/gateway composition，通过 Streamable HTTP 列出一个允许的 tool 并调用它，观察 `ctx.tools.execute` waterfalls 与 durable external call/result，同时证明第二个已注册 tool 不可见且不可调用。

- [ ] **步骤 3：编写失败的 Codex config 测试**

  断言每次 attachment 的 config 只包含 loopback opaque URL 与 `bearer_token_env_var`，token 只存在于 explicit env；resume 轮换 endpoint/token 而不删除 rollout state；gateway disposal 先于 child teardown。

- [ ] **步骤 4：运行 focused tests 并保存 RED 证据**

  预期 package/service 与 Codex gateway wiring 尚不存在。

- [ ] **步骤 5：实现完整 capability**

  通过现有 Web server 注册 loopback routes，重建已验证的 MCP requests，把 DSH results 映射为 MCP content/structured content/isError，根据已验证 Config 应用固定 size/time bounds，并返回 awaited disposer。加入 package invariant 与真实 Loader composition。

- [ ] **步骤 6：运行测试、typecheck、hygiene、文档检查并提交**

  以 `feat(mcp): expose allowlisted Harness tools` 提交。

### 任务 8：Opt-in bundle、preflight 与 Web routing

**文件：**
- 创建：`packages/bundle/web-codex/package.json`
- 创建：`packages/bundle/web-codex/cordis.patch.yml`
- 创建：`packages/bundle/web-codex/src/index.ts`
- 创建：`packages/bundle/web-codex/src/invariant.ts`
- 创建：`packages/bundle/web-codex/README.md`
- 创建：`packages/bundle/web-codex/README.zh.md`
- 创建：bundle tests 与 fixtures
- 修改：workspace/package manifests 与 resolver dependencies
- 修改：`packages/external/external-session/src/types.ts`
- 修改：`packages/external/external-session/src/index.ts`
- 修改：`packages/external/external-session-codex/src/index.ts`
- 修改：`packages/host/apiproxy/src/api-proxy.ts`
- 修改：`packages/client/runtime/src/client/sessions/lineage.ts`
- 修改：`packages/client/runtime/src/client/sessions/service.ts`
- 修改：`packages/client/runtime/src/client/sessions/session.ts`
- 修改：受影响 UI locales、README/JSDoc 配对

**接口：**
- 使用：已完成的 provider、resume、live UI 与 MCP gateway。
- 产出：结构化 provider preflight；opt-in Web composition；持久化 client `mode`；正确的 external prompt/command/settled routing。

- [ ] **步骤 1：编写失败的 preflight/catalog 测试**

  断言 binary missing、auth unavailable、invalid config 与 sandbox incompatibility 作为类型化的 `session.externalModes` failures 出现。断言成功 preflight 会在 create 前再次检查，失败不会发布 session。

- [ ] **步骤 2：编写失败的 client routing 测试**

  断言 external mode 在 list/update/reconnect projections 中保留；普通 prompt 与 pass-through slash 使用 `api.sessions.command`；`/compact` 与 `/model` 保留专用 routing；unsupported images/queue/steer/goals 显式失败且不查找 native Agent；settled 等待 `external/turn-ended`。

- [ ] **步骤 3：编写失败的 bundle composition 测试**

  启动默认 Web 并断言没有 external provider。启动 base + web-app + web-codex 并断言每个必需 row 恰好解析一次、Codex 出现，缺少 provider dependencies 时大声失败。

- [ ] **步骤 4：运行 focused tests 并保存 RED 证据**

  预期 server rows 缺失、client paths 丢失 mode，native Agent lookup 拒绝 prompts。

- [ ] **步骤 5：实现 preflight、routing 与 bundle**

  保持 secrets 不进入 YAML。将 command、allowed tools、state root、request bounds 与 timeouts 设为经过验证的 Config fields。提供带文档的 local profile overlay 或使用该 bundle 的 CLI profile command。

- [ ] **步骤 6：运行测试、build smoke、文档检查并提交**

  以 `feat(bundle): add opt-in Codex web mode` 提交。

### 任务 9：端到端证明与 current-state documentation

**文件：**
- 创建：`apps/web/tests/external-codex-session.e2e.ts`，或由实现者选择的 repository 当前 Web E2E owner
- 创建：放在所属测试旁的 keyless Loader/app-server/MCP fixture 文件
- 修改：Web accessibility snapshot owners
- 修改：`.agents/notes/implemented/feature/2026-08-18-external-interactive-sessions-phase-1.md`
- 修改：`.agents/notes/implemented/feature/2026-08-18-external-interactive-sessions-phase-1.zh.md`
- 修改：通过 repository generator 更新 pairing sidecar
- 修改或退役：`.agents/notes/proposed/feature/2026-08-18-external-interactive-agent-sessions.md` 及其配对文件，但只能按剩余未实现范围处理
- 修改：选定页面发布时的用户 setup 文档与 website mapping

**接口：**
- 使用：全部前置任务。
- 产出：keyless real-product transcript/UI proof；准确的 implemented authority；可重复的本地启动路径。

- [ ] **步骤 1：编写失败的 real-composition 场景**

  fixture 必须通过 Loader 启动 opt-in bundle，并让真实 pinned Codex app-server 对 loopback Responses stream 运行。测试创建 workspace，选择 Codex/model/effort，启动没有 native Agent 的 session，经 Web client route 提交，观察 live 后再观察 committed text，批准一个 gated action，执行一次 allowlisted MCP call，拒绝一次 unlisted call，执行 compact，重启 host，恢复同一个 Codex thread，并提交第二个 turn。

- [ ] **步骤 2：运行 replay/snapshot 测试并保存 RED 证据**

  预期场景或 snapshots 会在第一个尚未覆盖的 product path 失败。

- [ ] **步骤 3：只完成场景暴露的 integration defects**

  对每个发现的 defect 先用新的 failing focused test，再修改生产代码。不要加入新的 feature scope。

- [ ] **步骤 4：记录 accessibility 与 durable transcript 预期**

  固定 mode picker、live response、committed external message、command/file activity、approval row、MCP tool row、compaction notice 与恢复后的第二个 turn。断言没有 page/browser/console errors，并且 fixture 被完整消费。

- [ ] **步骤 5：重写 current-state 文档与 Agent Note**

  删除错误的说法、未来时态的 acceptance inventory 与过时 wire 限制。保留独有的 rationale，并明确只列出剩余的 ACP/Claude/agent-driven gaps。更新两种语言并重新记录 pairing。

- [ ] **步骤 6：运行最终相关 gates 并提交**

  运行 Web snapshot replay、focused package tests、受影响 aggregate typechecks、lint、build、hygiene、doc-sync、built opt-in profile smoke 与 `git diff --check`。以 `test(web): prove interactive Codex sessions` 提交。

## 最终验收审计

- [ ] 新的 final Luna/max reviewer 阅读 spec、plan、每个 commit、完整 diff、implementer reports、deferred minor findings 与 verification output。
- [ ] 一个 Luna/max fix agent 处理每个 Critical/Important final finding；新的 Luna/max re-review 只验证该 fix diff。
- [ ] controller 对照 source 与 runtime/test evidence 验证每个明确的 spec requirement，并将缺少的证据记录为 incomplete work，而不是推断完成。
- [ ] controller 按 dsh pre-push workflow 对变更表面运行新的最终命令；不声称本地通过 CI-owned exhaustive/platform checks。
- [ ] local opt-in profile 使用 packaged 或显式配置的 Codex binary 成功启动，并在 mode picker 显示 `Codex`。任何需要的 ChatGPT login 都是用户负责的认证操作，并收到精确的 command/UI 指示。
