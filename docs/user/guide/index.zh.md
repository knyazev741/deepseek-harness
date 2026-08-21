# 使用 Web UI

[English](index.md) | 中文

请先按照[根目录 README](../../../README.md#run) 中的说明启动 Web UI；命令会打印其访问地址。本指南从服务器已经运行的状态开始。`dsh` 进程会把启动时所在的目录作为默认文件系统位置；全新的 Web UI 则不会选中任何工作区，你需要添加一个工作区。

## 配置模型

打开**设置 → 模型**，输入 [DeepSeek API 密钥](https://platform.deepseek.com/)并保存。模型路由会立即可用，不需要重启服务器。

[模型配置指南](./providers.md)介绍其他提供方和自定义 OpenAI 兼容端点。

## 使用可选的 Codex mode

请把 Web 与 Codex bundle 安装到独立 profile；如果需要指定可执行文件，把 `DSH_CODEX_COMMAND` 设置为 Codex 的绝对路径，然后启动该 profile：

```sh
dsh plugin --profile codex-web add @deepseek-ai/dsh-web-app @deepseek-ai/dsh-web-codex
DSH_CODEX_COMMAND=/absolute/path/to/codex dsh --profile codex-web
```

如果 preflight 报告 `AUTH_UNAVAILABLE`，请运行 `codex login`，在它打开的浏览器中完成 ChatGPT 登录，然后重启 profile。在 Web UI 中选择工作区，在 mode picker 中选择 **Codex**，再选择 model 与 reasoning effort。只有当可执行文件、账户和 sandbox preflight 成功后，Codex 才会列出；环境中的凭证变量会被清除，因此使用 API key 的部署必须通过 profile overlay 显式传入凭证。

## 选择工作区

点击**选择工作区**，添加启动 `dsh` 时所在的项目目录，然后选中它。选中工作区前，会话输入框不可用。

## 运行任务

启动一个会话并发送：

> Summarize this repository and identify its main packages.

Agent（智能体）可以读取和编辑工作区文件、运行命令、委派工作并维护计划。如果根据当前权限策略，某项操作需要审批，Web UI 会先询问你。

## 继续使用

- [配置模型](./providers.md)
- [使用 Python SDK](./python-sdk.md)
- [使用其他 CLI 模式](../../../apps/cli/README.md)
- [开发插件](../develop/basic/)
