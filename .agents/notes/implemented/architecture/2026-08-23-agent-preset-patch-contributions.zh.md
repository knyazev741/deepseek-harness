# Agent Note: Agent preset patch contributions

Status: implemented

[English](2026-08-23-agent-preset-patch-contributions.md) | 中文

## Problem

部署插件需要调整既有 Agent Preset，又不能复制组装文件、修改用户 roster，或创建第二个 preset id。现有文件系统组装有意作为存储输入，而常驻挂载由加入同一 preset 的所有 agent 共享，因此部署 overlay 需要明确的生命周期和代际所有者。

## Decision

`AgentPresets` 在 `Symbol.for('dsh.agent-presets.patch-contributor')` 处暴露可选的 patch 贡献接口，并以 `AGENT_PRESET_PATCH_CONTRIBUTOR` 导出。其 `register({ presetId, patches })` 方法校验非空目标 id 和 patch 列表，深拷贝并冻结 patch，保持贡献顺序，并通过调用方的 Cordis 副作用注册贡献。释放所有者时移除贡献，并推进该目标的代际。

常驻挂载会为自己的 preset 截取展平后的贡献快照，并通过 `Include.Config.patches` 传入。常驻缓存以组装文件 stamp 与贡献代际为键。任一者变化后，后续挂载会创建新代际；已经认父到旧常驻 key 的 agent（包括通过 `composeFrom()` 加入的子 agent）继续保留那个代际。文件系统 `read()` 与 `copy()` 仍然展示和复制存储的组装，不会包含部署 overlay。

贡献接口是 `AgentPresets` 的扩展，不是新的能力 seam。插件可以探测该 symbol；在不暴露它的宿主上仍可正常运行。

## Alternatives considered

**把 patch 物化进 preset 文件：**不采用，因为部署状态会变成用户创作状态，副本会失去源文件与 overlay 的区别，而且共享文件可能改变已经运行的会话组装。

**为每个部署 overlay 创建虚拟 preset：**不采用，因为这会复制 roster id 和默认选择行为，而子 agent 还需要另一个身份来保留父方的常驻代际。

**用独立 registry seam 替换 `AgentPresets` 服务：**不采用，因为 patch 的生命周期和代际由 preset 常驻挂载所有；第二个服务会拆分这一所有关系，并增加不必要的 Service Definition/Provider/Consumer seam。

## Consequences

部署插件可以在不改动用户文件、会话 header 和子 agent 组装的前提下，向随附 preset 叠加有界 patch 列表。贡献注册是可选的，缺少该 symbol 的旧宿主仍然可用。被替代的常驻代际会为已有 agent 保持挂载，并且只有在 roster 整棵树卸载时才回收，这与现有文件代际行为一致。
