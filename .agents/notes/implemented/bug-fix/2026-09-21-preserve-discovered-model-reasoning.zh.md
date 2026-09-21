# Agent Note: 在模型发现时保留 reasoning 元数据

Status: implemented

[English](2026-09-21-preserve-discovered-model-reasoning.md) | 中文

## Problem

OpenAI 兼容的模型目录可以发布模型级 reasoning 等级，但 DSH 发现流程过去只保留 id、名称、上下文窗口和最大输出 token。采纳该结果会写入用户拥有的 `models` 数组，而该数组会替换 bundle 目录。因此，GLM 5.3 Flash 之类的模型仍可选择，却会失去 Effort 菜单，即使本地 checkout 已经是最新版本。拉取新源码也无法修复已经保存的模型行。

KnyazevAI bundle 还包含了与线上 API 不一致的目录信息：Kimi 2.6 仍在列表中，DeepSeek 声明的输出上限高于端点实际值，而且独立 provider 与完整 fork 的 reasoning 兼容配置不同。

## Decision

`LlmDiscoveredModel` 增加可选的 `reasoningEfforts`。pi-ai 发现解析器从 OpenAI 兼容目录读取 `reasoning.efforts`。只有 off 的列表转换为 `false`；其他发布等级全部保留。若目录声明默认值是某个 thinking 等级，Off 会映射为显式的 `off` wire 值，避免省略参数后仍保留默认 thinking；否则 Off 映射为不发送 wire 值。

Models 编辑器会与可见模型行一起采纳这项隐藏能力元数据。当端点发现可以修复已有模型的 reasoning 元数据时，该模型行默认被选中。对已有模型的采纳只更新 reasoning 元数据，保留用户已经调整的名称与容量。

KnyazevAI fork bundle 与线上 `/v1/models` 目录保持一致：DeepSeek V4 Flash、GLM 5.3 Flash 和 MiniMax 2.7；不再包含 Kimi 2.6。路由级 OpenAI reasoning 兼容配置同时用于 DeepSeek 与 GLM，MiniMax 明确标记为不支持 reasoning，输出限制与端点一致。

## Alternatives considered

**在 UI 中写死仅针对 KnyazevAI 的修复。** 这只能修复一个 provider，其他 OpenAI 兼容目录仍会丢失同类元数据。

**启动时自动改写已保存设置。** 启动流程无法可靠判断手工编辑的模型行是否有意移除了 reasoning 支持，而且静默写入会在没有明确采纳动作时改变用户配置。

**继续只发现可见字段。** 这能保持旧的窄返回值，但会让 Fetch available models 操作破坏控制请求行为的能力元数据。

## Consequences

当网关发布 `reasoning.efforts` 时，发现流程可以保留 reasoning 选择器。reasoning 元数据过期的已有模型行会被提示修复，同时不会覆盖用户调整过的容量。未发布该字段的网关保持原有行为。完整 KnyazevAI fork 与独立 provider 现在共享同一份线上模型目录和 reasoning 语义。
