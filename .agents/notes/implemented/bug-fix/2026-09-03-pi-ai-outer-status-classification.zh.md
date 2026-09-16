# Agent Note: 在嵌套报错文本之前分类 pi-ai 网关外层状态

Status: implemented

[English](2026-09-03-pi-ai-outer-status-classification.md) | 中文

## 问题

pi-ai 以压平后的 `errorMessage` 文本向适配器交付提供方失败，而不是稳定的 HTTP 状态字段。因此像 `502: {"message":"Upstream returned HTTP 400.","type":"api_error","code":"upstream_error"}` 这样的网关响应同时包含外层状态和嵌套诊断。宽泛的文本分类器可能先选中嵌套的 `400` 并产生 `INVALID_REQUEST`；这个 code 有意不在默认可重试集合中，于是暂时性的网关失败会关闭 agent 轮次，而不会进入已有的提供方重试路径。

## 决策

`dsh-llm-pi-ai` 从压平的 pi-ai 报错开头提取 HTTP 状态，包括单独的状态前缀、`HTTP <status>` 和已知的带括号提供方前缀。`classifyPiAiError` 在检查嵌套文本之前使用这个外层状态：401/403 映射为 `AUTH`，429 保留配额判断或映射为 `RATE_LIMIT`，400/413 映射为 `INVALID_REQUEST`，5xx 映射为 `SERVER`。无法识别外层状态的消息保留原有的文本回退分类。这项修复补充了[pi-ai 传输截断分类](../../archived/bug-fix/2026-07-22-pi-ai-transport-truncation-classification.md)，不会把兜底的 `PI_AI_ERROR` 或真正的 `INVALID_REQUEST` 失败变成可重试。

## 备选方案

**把 `INVALID_REQUEST` 加入可重试 code。** 不采用，因为真正格式错误的请求在输入不变时再次发送仍会失败，并可能消耗完整的重试预算或 always 策略。可恢复的情况是网关外层 5xx，因此应在适配器分类处修正。

**把嵌套的上游状态作为权威状态。** 不采用，因为嵌套状态只是响应正文中的诊断文本；网关请求本身是否暂时失败，应由 pi-ai 实际收到的状态决定。当两者同时存在时，外层状态必须优先。

**用更底层的 fetch 适配器替换 pi-ai。** 不采用，因为这会重复提供方协议和 catalog 的所有权，只为取得一个可以从压平前缀安全分类的状态。适配器继续使用 pi-ai，并保留对没有可用前缀的提供方的原有回退逻辑。

## 后果

包裹了内部 4xx 的网关 5xx 现在映射为 `SERVER`，并进入配置好的提供方重试策略。直接的 400/413 仍然是终止型 `INVALID_REQUEST`，因此该修复不会重试格式错误的请求。适配器仍无法恢复 pi-ai 已丢弃的结构化状态；前缀解析仍是对压平报错文本的最佳努力兼容规则。

## 测试

pi-ai stream 转换测试覆盖了观测到的、包含嵌套 `HTTP 400` 文本的 `502` wrapper，并断言结果为 `SERVER`；同一测试套件中原有的 HTTP 400、413、429、配额、5xx、传输和上下文溢出场景继续保留。
