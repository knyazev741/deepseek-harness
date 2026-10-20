---
description: "说明 fork 的 main 分支如何自动发布 npm，包括版本提交、干净安装检查、npm 凭据，以及发布失败后的恢复。"
---

# 从 main 发布到 npm

[English](publishing-main.md) | 中文

## 概述

fork 的 [Publish main to npm 工作流](../../.github/workflows/release-main.yml) 发布推送到 `main` 的改动，也接受从 `main` 手动运行。发布成功后，它更新 `npx @knyazevai/dsh web` 使用的 npm `latest` 通道。

## 目录

- [前提条件](#requirements)
- [发布生命周期](#release-lifecycle)
- [失败与重试](#failures-and-retries)
- [开发说明](#dev-note)

<a id="requirements"></a>
## 前提条件

fork 必须启用 GitHub Actions；fork 工作流被停用时，Actions 页面提供重新启用按钮。GitHub Actions 需要推送版本提交与标签的权限。分支保护仍然有效：推送被拒绝时，发布停止。仓库 secret `NPM_TOKEN` 必须允许公开发布、在 fork 的 npm scope 下创建新包、更新分发标签，以及符合账户双因素策略的无人值守发布。npm 凭据过期或变更时更新该 secret。无人值守发布还要求 `npm-publish` environment 接受 `main`，且不要求审核者批准。

<a id="release-lifecycle"></a>
## 发布生命周期

1. 串行发布任务预留高于源码基线及所有已发布或已打标签版本的稳定版本。它提交包族 manifest 与 lockfile，将提交推送到 `main`，并创建对应的 `dsh-v` 标签。工作流自身使用 `GITHUB_TOKEN` 的推送不会启动另一轮工作流。
2. 发布任务在构建前及发布前，将干净源码 SHA 与远端 `main` 核对。它构建完整官方产物并打包 DSH 包族。vendored 与原生运行时依赖必须已在公开 npm 中可用。
3. 仅入口包冒烟检查只向临时消费方安装 CLI，并使用全新的 npm 缓存与 profile。回环 registry 提供打包后的 DSH 产物；外部依赖来自公开 npm。标准 npm resolver 使用 1536 MiB 的 Node heap 预算，Chromium 必须显示工作区选择器且没有客户端错误。
4. 发布使用版本专属的 `candidate-` 标签上传不可变版本。公开可用性检查会先等待两种 registry 元数据中的校验和一致，且 tarball 可下载，再进行消费方安装。它最多等待 60 分钟，容忍 npm 扫描、传播和临时网络故障，每 15 秒轮询一次，并为单个请求设置期限。随后，公开 registry 冒烟检查在 Node 24 与 Node 22 上重复安装及浏览器启动。全部成功后，晋升步骤才核对每个 tarball 的公开 integrity、拒绝分发标签降级，并将包族更新到 `latest`。CLI 标签最后更新。

npm [先扫描版本，再允许安装](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/)；上传成功不代表公开可用。可用性检查会报告待处理的包，并在授权错误、无效元数据、校验和冲突或期限到达时失败。

工作流保留 tarball、已隐藏敏感参数的启动日志、浏览器截图和冒烟报告七天。它不会把现有用户的凭据或提供方配置复制进消费方，也不会发起付费模型调用。

<a id="failures-and-retries"></a>
## 失败与重试

晋升前失败时，CLI 的 `latest` 保持不变；已上传的候选版本仍可通过精确版本访问。晋升中失败可能在 CLI 更新前推进其他包族标签。完整重跑工作流会预留新版本，不会覆盖已发布字节。出现更新的 `main` 时，旧构建或发布停止；排队任务发布当前分支。

重跑前检查失败步骤及保留的证据。凭据失败需要有效的 `NPM_TOKEN`；源码推进需要当前 `main`；registry 扫描或传播迟迟未完成时，需要检查报告中的包状态；公开可用后发生的安装或浏览器失败需要修复代码。关闭 peer dependency 解析不算安装检查：它可能漏掉运行时依赖，并在 npm 完成后失败。

<a id="dev-note"></a>
## 开发说明

[发布序列决策](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.zh.md)拥有包族版本与不可变发布规则。[打包 registry](../../scripts/release/packed-registry.ts)、[消费方冒烟检查](../../scripts/release/smoke-web-install.ts)、[公开可用性检查](../../scripts/release/wait-public.ts)及[晋升预检](../../scripts/release/promote.ts)拥有实际执行的检查。
