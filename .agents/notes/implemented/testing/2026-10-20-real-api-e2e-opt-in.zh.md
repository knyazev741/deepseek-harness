# Agent Note: 自动真实 API e2e 的仓库显式启用

Status: implemented

[English](2026-10-20-real-api-e2e-opt-in.md) | 中文

## 问题

Fork 会继承工作流，但不会继承上游仓库的 API 凭证。自动真实 API 运行会在执行任何测试之前因凭证预检失败，混淆尚未配置的集成与产品回归之间的区别。API 支出也需要由仓库所有者选择。

## 决策

[e2e.yml](../../../../.github/workflows/e2e.yml) 仅在 Actions 仓库变量 `DSH_REAL_API_E2E_ENABLED` 等于 `true` 时自动运行。所有者先配置 Actions secret `DEEPSEEK_API_KEY_EXTERNAL`，再启用该变量。未设置或其他值会在分配 runner 之前跳过整个 job。`workflow_dispatch` 允许独立于该变量显式运行。

这取代了[真实 API CI 决策](2026-06-19-real-api-e2e-ci.zh.md)中的自动运行默认策略；该记录继续负责凭证隔离与可信 PR 策略。即使启用自动运行，fork 和 Dependabot PR 仍会跳过。启用后或手动请求的运行若缺少密钥仍会失败，测试失败也仍然报告为失败。

## 曾考虑的替代方案

**未配置时仍启用自动运行。** 对从未配置此集成的仓库，凭证失败无法提供产品行为的证据。

**让无密钥测试套件静默通过。** 所有者启用真实 API 覆盖后，删除或重命名密钥会被掩盖。显式启用策略保留了强制预检。

## 后果

未配置的仓库获得跳过的检查，而不是凭证失败。自动真实 API 覆盖除 secret 外还需要仓库变量；维护者必须先启用两者，才能依赖该覆盖。无密钥检查和 npm 发布保留现有策略。[工作流测试](../../../../scripts/ci-workflow.spec.ts)会计算自动与手动运行的选择条件，以及 fork 和 Dependabot 限制。
