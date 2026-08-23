# Plugin-First Fork 覆盖层路线图

[English](2026-08-22-plugin-first-fork-overlay-roadmap.md) | 中文

本路线图将已批准的[Plugin-First Fork 覆盖层设计](../specs/2026-08-22-plugin-first-fork-overlay-design.zh.md)拆分为四个相互依赖的实施计划。按顺序在一个隔离的迁移分支上执行。每个计划都以可评审、可测试的检查点结束；任何计划都不得为下一个计划隐藏失败的检查。

1. [覆盖层清单和验证门禁](2026-08-22-overlay-manifest-gate.zh.md)构建清单解析器、Git diff 分类器、预算、冲突检查和 fixture 测试，但暂不将不完整的旧 fork 清单变为必需的仓库门禁。
2. [主机能力覆盖层迁移](2026-08-22-host-capability-overlay.zh.md)正常合并选定的 upstream 基线，记录每项旧功能的处置，通过 fork 包或范围受限的补丁保留所需的 Host 行为，并移除旧 Codex 实现。
3. [Upstream Client 和 Fork Web 组合](2026-08-22-upstream-client-fork-web.zh.md)恢复完整的 upstream client，仅在必要处添加通用 workspace 贡献点，从 fork Web 组合包挂载 fork UI 贡献，并从干净产物证明默认和 fork Web 组合都成立。
4. [安全 upstream 同步和切换](2026-08-22-safe-upstream-sync-cutover.zh.md)激活 `.fork/overlay.yaml`，替换 `-X ours`，添加解析器／评审人报告和合并模拟，运行真实的 dry-run 同步，并将经过评审的迁移切入 `master`。

控制器将实现任务分配给使用最大推理强度的 `gpt-5.6-luna`，为每个工作者分配独占的文件所有权，先按规范合规性、再按代码质量进行评审，并运行跨计划的最终验收。工作者不得编辑或删除主 checkout 中其他无关的未跟踪文件。
