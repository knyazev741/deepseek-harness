# Knyazev Preset Overlay 发布实现计划

[English](2026-08-23-knyazev-preset-overlay-release.md) | 中文

> **面向 agent（智能体）工作者：** REQUIRED SUB-SKILL：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，按任务逐项实现本计划。步骤使用复选框（`- [ ]`）语法跟踪。

**目标：** 将 `@knyazevai/dsh@0.1.4` 发布为向后兼容的提供方 overlay；当宿主支持 preset patch 贡献时，额外向 `standard` Agent Preset 应用有界的 Knyazev 压缩策略；随后发布对应的 Harness fork。

**架构：** `AgentPresets` 增加一个带 effect 生命周期、以 symbol 为键、面向既有 preset 的有序 patch registry。贡献是仅在挂载该 preset 时应用的部署层；存储的 preset 文件、用户副本、会话事件和子 agent 组装保持不变。独立包保留其根提供方／默认模型 patch，并增加一个通过 feature-detect 使用该 registry 的运行时插件：当前 fork 宿主收到压缩 patch，而较旧的官方宿主保留提供方功能，并记录未安装可选 preset patch。

**技术栈：** TypeScript、Cordis、`@deepseek-ai/cordis-plugin-include`、Vitest、YAML 组合包 patch、npm 包导出和 GitHub Actions。

**规格：** [Plugin-first fork overlay roadmap](2026-08-22-plugin-first-fork-overlay-roadmap.zh.md)

## 全局约束

- 不得更改或移除 Background UI 贡献。
- 绝不提交 `KNYAZEV_AI_API_KEY` 的值；配置只包含凭据引用。
- 即使 preset patch 贡献不可用，也必须保留 `@knyazevai/dsh` 在 `@deepseek-ai/dsh@0.1.1-rc.2` 上的提供方安装。
- 只对 `standard` Agent Preset 应用压缩；`minimal` 和用户选择的 preset 保持不变。
- 用户设置仍高于组装默认值；只有用户没有覆盖时，提供方才保持为 `knyazev-ai/deepseek-v4-flash`。
- 子 agent 继续使用 `AgentPresets.composeFrom()`，因此加入父方的精确常驻组装。
- 注册使用 `ctx.effect()` 并返回 disposer；移除贡献只影响之后创建的挂载。
- 不得增加新的 Service Definition/Provider/Consumer 能力 seam：这是现有 `AgentPresets` registry 的扩展。
- 用普通 merge 将 `origin/master` 合并进 fork，并保留远程发布协调与本地 plugin-first 行为；绝不 force-push。
- 只有完成组装后的干净安装验证和独立评审后，才能发布 npm。

---

### 任务 1：整合最新 fork 基线

**文件：**
- 通过语义合并修改：`.github/`、`apps/cli/`、`apps/web/`、`packages/boot/app-boot/`、`scripts/client-build-environment*`，以及 `git merge origin/master` 报告的已同步 Agent Note sidecar
- 测试：`packages/boot/app-boot/tests/profile.spec.ts`
- 测试：`apps/cli/tests/built-bin.e2e.ts`
- 测试：`scripts/client-build-environment.spec.ts`
- 测试：`scripts/client-build-environment.client.spec.ts`

**接口：**
- 消费：本地 plugin-first `master` 和已获取的 `origin/master`。
- 产出：一个包含远程协调的 profile 发布修复和 shell-theme 修复、且不回归 `fork-web` 的合并提交。

- [ ] **步骤 1：** 在不修改 `master` 的情况下重现合并冲突。

仅在 `codex/knyazev-preset-release` 中运行 `git merge --no-ff origin/master`，确认预期的八个冲突路径。

- [ ] **步骤 2：** 语义解决每个冲突。

保留本地动态 UI-theme 实现、`boot.ts` 别名、`fork-web` profile 元组、本地化 `.zh.md` 链接，以及动态 theme 的正反测试。增加远程 `initProfile()` 执行、既有 profile 的旧 workspace 升级，以及 `@knyazevai/dsh@0.1.3` 的精确 `minimumReleaseAgeExclude` 条目。重新记录受影响的双语 sidecar，不要手工选择哈希。

- [ ] **步骤 3：** 运行有针对性的合并证据。

运行四个所属测试文件、`pnpm run verify-translation-pairing` 和 `git diff --check`；只修复由合并引起的失败。

- [ ] **步骤 4：** 提交解决后的合并。

保留 Git 生成的合并父关系，并使用指明 `origin/master` 集成的合并提交消息。

### 任务 2：增加 Agent Preset patch 贡献

**文件：**
- 创建：`packages/preset/agent-presets/src/contributor.ts`
- 修改：`packages/preset/agent-presets/src/index.ts`
- 修改：`packages/preset/agent-presets/src/mount.ts`
- 修改：`packages/preset/agent-presets/package.json`
- 修改：`packages/preset/agent-presets/README.md`
- 修改：`packages/preset/agent-presets/README.zh.md`
- 修改：`packages/preset/agent-presets/README.i18n.yaml`
- 修改：`docs/architecture.md`
- 创建或更新：`.agents/notes/implemented/architecture/2026-08-23-agent-preset-patch-contributions.{md,zh.md,i18n.yaml}`
- 测试：`packages/preset/agent-presets/tests/contributor.spec.ts`
- 测试：`packages/preset/agent-presets/tests/mount.spec.ts`

**接口：**
- 消费：既有文件系统 preset discovery 和 `Include.Config.patches`。
- 产出：`AGENT_PRESET_PATCH_CONTRIBUTOR`、`AgentPresetPatchContribution`，以及通过现有 `AgentPresets` 服务暴露的带 effect 生命周期的 `register()` API。

- [ ] **步骤 1：** 编写失败的 registry 测试。

覆盖注册顺序、释放、目标隔离（`standard` 改变而 `minimal` 不变）、只在解析时失败的缺失目标，以及后续挂载的代际失效。断言已经加入的会话和通过 `composeFrom()` 创建的子 agent 保留其原来的常驻代际。

- [ ] **步骤 2：** 验证 RED。

运行新的 contributor 测试，确认因为 symbol-keyed registry 和挂载的 patch 不存在而失败。

- [ ] **步骤 3：** 实现公共贡献 API。

使用有文档说明的 `Symbol.for()` key，使 JavaScript 插件无需导入特定版本包即可 feature-detect 宿主。`register({ presetId, patches })` 校验非空 preset id 和非空 patch 列表，按注册顺序保存不可变副本，推进目标代际，并通过 `ctx.effect()` 所有权返回 disposer。

- [ ] **步骤 4：** 在常驻挂载创建时应用 patch。

把目标 preset 展平且有序的 patch 通过 `Include.Config.patches` 传入 `PresetTree`。以组装文件 stamp 加贡献代际作为常驻代际的键。存储的 `read()`／`copy()` 仍然是文件操作，不会物化部署 overlay；为此补充文档。

- [ ] **步骤 5：** 验证 GREEN 和相邻行为。

运行 contributor、mount、authoring、session 和 package invariant 测试。为新源码运行限定范围的覆盖率，并保持每文件 100% 阈值。

- [ ] **步骤 6：** 编写文档并提交。

更新包参考、架构扩展点映射和双语 Agent Note；重新记录配对记录，并将代码、测试和文档一起提交。

### 任务 3：构建 `@knyazevai/dsh@0.1.4`

**`/private/tmp/knyazevai-dsh-v014` 中的文件：**
- 修改：`cordis.patch.yml`
- 创建：`src/agent-preset.js`
- 创建：`test/agent-preset.test.js`
- 修改：`test/config.test.js`
- 修改：`package.json`
- 修改：`README.md`
- 修改：`.github/workflows/publish.yml`
- 创建：`package-lock.json`

**接口：**
- 消费：任务 2 定义的 symbol key 和注册对象。
- 产出：包导出 `@knyazevai/dsh/agent-preset`、根提供方／默认模型 patch，以及可选的 `standard` preset 压缩贡献。

- [ ] **步骤 1：** 编写失败的包测试。

断言精确的 portable 提供方默认值、按序排列的八种 code 重试策略、不出现 secret 值和 `reasoningEffort`、存在 symbol API 时的运行时注册、缺少 API 时的安静 no-op 与 warning、disposer 行为，以及精确嵌套的面向 `compaction-basic` 的 `compaction` patch。

- [ ] **步骤 2：** 验证 RED。

运行 `npm test`，确认因为运行时入口和同步后的默认值不存在而失败。

- [ ] **步骤 3：** 实现可选运行时插件。

注入 `agentPresets`，feature-detect `Symbol.for()` contributor key，并为 `standard` 注册 patch。嵌套 patch 设置 `maxSummarizationInputTokens: 0`、`compactionRetries: 2`、`maxOverflowRetries: 2`，以及三个封顶为 `131072` 的模型策略。在旧宿主上只 warning 一次，同时保持提供方功能可用。

- [ ] **步骤 4：** 同步提供方默认值。

匹配 `fork-base`：OpenAI Completions、Knyazev endpoint、15／30 分钟 stream／request 超时、覆盖全部八种 code 的 20 次重试、Qwen thinking 兼容性、`reasoning: high`，以及三个精确的模型目录。保持 `agent-default-model` 为 DeepSeek V4 Flash。移除无效的根 compaction 和 subagent 行。

- [ ] **步骤 5：** 修复发布可复现性。

生成并提交 `package-lock.json`，把 workflow 的 `npm ci || npm install` 回退替换为确定性的 `npm ci`，更新 README 声明和兼容性矩阵，并保持 packed artifact 中的 `prepublishOnly: npm test` 有效。

- [ ] **步骤 6：** 验证并提交。

运行 `npm test`、`npm pack --dry-run`，把 tarball 安装到 mock old Host 和新的 Harness worktree，并提交不带 tag 的包 release candidate。

### 任务 4：组装验收与发布

**文件：**
- 如有需要测试／修改：`apps/cli/tests/built-bin.e2e.ts`
- 如有需要测试／修改：`apps/cli/tests/web-agent-presets.e2e.ts`
- 仅通过版本化修改：`/private/tmp/knyazevai-dsh-v014/package.json`、`package-lock.json`

**接口：**
- 消费：任务 1–3 的 release candidate。
- 产出：已验证的 npm `0.1.4`、GitHub plugin `main`／`v0.1.4`，以及 Harness fork `master`。

- [ ] **步骤 1：** 运行组装 RED/GREEN 证明。

在全新的 `DSH_HOME` 中使用 `dsh plugin --profile web add <tarball>` 安装 plugin tarball。启动构建后的 Web，通过真实应用路径创建 standard-preset 会话，并断言挂载的 compaction 服务解析到 Knyazev 策略。断言 `minimal` 未改变，且子 agent 加入父方的常驻代际。

- [ ] **步骤 2：** 运行对外 Harness 证据。

运行有针对性的 preset/profile/CLI/client 测试、`pnpm run build`，按用户要求运行完整的 `pnpm run test`，运行 `pnpm run doc-sync`、相关 hygiene，以及相对获取的 `origin/master` 合并基线的 `git diff --check`。

- [ ] **步骤 3：** 运行独立评审。

评审完整的 Harness 合并／功能 diff 和完整的 npm 包 diff。修复每个 Critical 或 Important 发现，并只重新评审修复部分。

- [ ] **步骤 4：** 准备 npm 发布。

设置版本 `0.1.4`，验证 `npm whoami`、打包内容、包 provenance 字段以及没有 secret 字面量。可以在本地使用发布凭据；将 npm token 复制到 GitHub Actions 仍是安全敏感操作，需要明确的额外批准。

- [ ] **步骤 5：** 发布并验证 npm。

运行 `npm publish`，然后验证 `npm view @knyazevai/dsh@0.1.4 version dist gitHead`，并从公开 registry 重复精确的官方／fork 安装冒烟测试。

- [ ] **步骤 6：** 不重写历史地推送。

显式将 plugin `main` 和 `v0.1.4` 推送到 `github`；显式运行 `git push origin master` 推送 Harness。获取两个实时 ref，并要求其 OID 等于本地 HEAD／tag 目标。不要在 Harness `master` 上使用原始 force 或裸 `git push`。
