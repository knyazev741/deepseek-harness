# Agent Note: Fork overlay manifest 的所有权与验证

Status: implemented

[English](2026-08-22-fork-overlay-manifest.md) | 中文

## 问题

Fork 差异需要持久的所有权记录，以及相对于 upstream 的有界比较。仅靠 Git diff 无法说明路径属于 fork 插件、组合、扩展点还是不可避免的产品行为，也无法暴露陈旧声明或悄然扩展到整个 upstream 包的补丁。验证证据也需要可检查，同时不能允许 manifest（元数据清单）数据执行任意 shell 命令。

## 决策

`.fork/overlay.yaml` 是 fork 差异的源平面清单。它记录 schema 版本 1、作为比较父提交的不可变 40 位十六进制 upstream SHA `upstreamCommit`，以及带有精确仓库相对路径声明的条目。`exact` 声明只匹配一条路径；`tree` 声明匹配所声明的目录及其后代。路径不使用 glob、遍历、绝对形式、NUL 或反斜杠，tree 声明以 `/` 结尾。`agentNote` 是仓库相对文件路径，遵守相同的安全限制并且不能以 `/` 结尾；解析时不要求该文件已经存在。

所有权分类只有 `fork-owned`、`composition`、`extension-patch` 和 `product-patch` 四种。`workflow` 是面向 fork-owned 工作流文件的额外 exact-path manifest kind，不是第五种所有权分类。`fork-owned`、`composition` 和 `workflow` 是 fork 侧分类，因此它们拥有的每条路径都必须不存在于 upstream tree 中；声明 tree 的根路径若在 upstream 中恰好是文件也属于冲突。composition 条目描述围绕 upstream 包进行的 fork 组合；extension patch 只增加通用的 upstream 注册点，具体行为仍位于 fork 插件中；product patch 记录带有明确预算的狭窄 upstream 行为改动。extension 或 product patch 匹配的每个 diff 都必须至少有一个旧路径或当前路径存在于 upstream 中。删除、重命名和复制使用 diff 记录中的 upstream 一侧作为锚点，因此新目标不必已经存在；没有 upstream 路径的纯新增 diff 会以 `upstream-ownership-mismatch` 失败。patch budget 限制文件数和 changed lines，每个条目还记录 owner、Agent Note、结构化验证目标和退出条件。

workflow 条目只能使用 `.github/workflows/` 下的 exact 路径，并且同样受 fork 侧的 upstream 缺失检查约束。

Git 读取会先删除所有大小写不敏感的 `GIT_*` 环境变量，只设置 `GIT_OPTIONAL_LOCKS=0`，同时保留普通进程和平台环境变量。tree 与 diff 的 revision 参数前会加入 `--end-of-options`，路径限制所需的末尾 `--` 保持不变。

分类器要求每条 changed path 恰好有一个 owner，并在出现重叠或未覆盖路径时失败。rename 或 copy 的旧路径和新路径分别参与所有权检查，但该记录的 Git numstat 在文件数和 changed-line budget 中都只计一次。分类器强制 fork 侧路径不出现在 upstream 中，并要求 patch diff 具有 upstream 锚点。binary 改动计为一条 changed line，因此 binary 内容不能绕过预算。fork 侧路径与 upstream 冲突、没有 upstream 锚点的 upstream 侧补丁、声明整个 upstream 包的补丁、陈旧条目或预算溢出都会导致失败；缺少比较提交以及无效的验证目标也会导致验证失败。

验证目标是结构化声明：一个非空的仓库 `script` 名称，或一组受支持的 Vitest 测试文件。验证器只检查所引用的 package script 或测试文件存在，并符合仓库路径和文件规则；它从不执行声明的目标。行为证据保留在所引用的仓库检查中，而不是由 manifest 解析提供。

激活有意延后到迁移后的 tree 完成整体分类之后。真正的 `.fork/overlay.yaml` 与顶层 CI aggregate 在该 cutover 一起出现；在此之前，验证器接受 fixture（测试前置数据） manifest，不要求默认文件存在。

## 验证

`scripts/fork-overlay/manifest.spec.ts` 固定 manifest 解析、workflow 前缀和安全 agentNote 行为。分类器、重叠、陈旧条目、fork 侧冲突、tree 根文件冲突、upstream 锚点、rename/copy、binary、整个包、以及预算行为由 `scripts/fork-overlay/classify.spec.ts` 固定。`scripts/fork-overlay/git-reader.spec.ts` 和 `scripts/fork-overlay/verify.spec.ts` 固定 Git tree/diff 解析、恶意环境与 revision 处理和验证目标存在性检查，`scripts/verify-fork-overlay.spec.ts` 固定 CLI fixture 的成功与失败行为。真正的 `.fork/overlay.yaml` 与顶层 CI aggregate 在 cutover 之前有意缺席，因此在迁移后的 tree 完成整体分类之前，真实 manifest 和 aggregate-CI 覆盖是明确的缺口。

## 考虑过的替代方案

**镜像分支。** 镜像分支会重复 upstream 状态，使分支同步多出一个事实来源。manifest 中的不可变提交为每个候选树提供直接的比较父提交，同时保留普通 Git 历史作为权威来源。

**重复提交 patch 文件。** 独立的 patch 文件可能与已应用的 tree 漂移，并产生第二份代码表示。manifest 记录所有权、路径、预算、验证声明和退出条件，而 Git 继续作为代码的事实来源。

**通配符或 legacy 分类。** 通配符或 catch-all 所有权分类会隐藏新路径，使重叠和退出变得含糊。exact/tree 声明和封闭的所有权词汇要求每条 changed path 都有明确 owner；`workflow` 仍限制为精确的工作流路径。

**验证 shell 命令。** Shell 命令字符串会赋予仓库数据执行权限，使验证依赖 shell 行为并允许副作用。结构化的 script 和 Vitest 声明只检查存在性，验证器不会运行它们。

**针对未迁移的 legacy diff 激活。** 在迁移后的 tree 完成分类之前要求真实 manifest，会促使使用通配符、临时分类或过大的预算来掩盖已有差异。激活等待完整分类，以便默认 manifest 和 CI aggregate 从首次使用起就执行预期清单。

## 后果

Fork 必须对照记录的 upstream 父提交分类每一项差异；upstream 冲突、没有 upstream 锚点的补丁、重叠、未覆盖路径、陈旧条目、整个包的补丁、无效目标或预算溢出都会拒绝验证通过。这样，普通 fork 改动和 upstream 同步中的所有权漂移都会显现。

Patch budget 无法通过 rename 或 binary 文件绕过，而 exact/tree 覆盖让所有权边界保持可审查。manifest 描述分类和验证声明；它不取代行为测试、包检查或组装产品证据。

验证器不执行目标，因此检查目标声明不会带来执行副作用。真实 manifest 和顶层 CI 要求仍缺席，直到迁移后的 tree 完成分类；因此当前 fixture 检查不会为不完整的 legacy 清单背书。
