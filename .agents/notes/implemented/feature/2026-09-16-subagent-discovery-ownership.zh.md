# Agent Note: 独立的子代理发现工具持有权

Status: implemented

[English](2026-09-16-subagent-discovery-ownership.md) | 中文

## 问题

此 fork 的预设同时为 spawn 和 fork 启用模型选择。每个实例都注册 `list_subagent_models`，导致新 Session 创建因工具名称重复而失败。

## 决策

`modelSelectionDiscovery` 默认为 true。主委派工具持有发现工具；同级 fork 工具将其设为 false，同时保留相同的已记录路由策略和模型选择参数。注册表仍拒绝两个发现工具持有者。这取代了[模型选择路由](2026-08-18-model-selected-subagent-routes.zh.md)中随附 fork 的选择限制。

## 考虑过的替代方案

**禁用 fork 模型选择。** 这会移除用户要求的 fork 能力。显式路由更改仍被允许，并保留有关继承前缀缓存复用的现有警告。

**静默跳过重复注册。** 这会让发现工具依赖加载和销毁顺序。显式持有权保留正常的 Cordis 注册清理和重复诊断。

## 影响

两个委派工具都能选择已授权模型，而一个发现定义服务于该 Session。自定义组合必须保留一个持有者。包测试覆盖重复创建 Session；随附 fork-Web 进程测试通过真实创建端点覆盖 Standard、PTC 和 Cordis。
