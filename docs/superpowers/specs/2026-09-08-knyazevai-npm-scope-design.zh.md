# KnyazevAI npm Scope Design

[English](2026-09-08-knyazevai-npm-scope-design.md) | 中文

## Goal

该 fork 将完整的 DSH 包族发布到拥有发布凭据的 npm 账户名下。安装命令为 `npx @knyazevai/dsh`；它启动与源码 checkout 中 `pnpm dsh web` 相同的 `fork-web` 产品，并包含半窗口压缩和首 chunk 超时恢复修复。

此次迁移改变包身份，不改变运行时架构。Vendored Cordis 包继续使用 `@deepseek-ai`，因为它们是独立发布且能从 npm 解析的依赖。

## Package identity

名称以 `@deepseek-ai/dsh` 开头的每个 workspace 包都迁移到对应的 `@knyazevai/dsh` 名称。这包括私有 workspace 根名称、CLI、bundle、运行时包、测试支持包和示例。包后缀和 DSH 共享版本保持不变。

这些包身份的引用在 package manifest、TypeScript import 和 module augmentation、Cordis YAML、tsconfig path、构建配置、发布工具、测试、snapshot 和当前文档中一起迁移。仓库 URL 以及 vendored `@deepseek-ai/cordis`、`@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery` 和 `@deepseek-ai/cordis-plugin-*` 名称不变。

冻结的 archived Agent Note 保留其历史文本。定义当前包身份的 active Agent Note 按正常 note 生命周期更新或取代。

## Migration mechanism

仓库自带的 rescope 命令以确定性方式执行包 token 改写，并支持 check 模式。它处理被 Git 跟踪且符合条件的源文件，排除 `vendor/`、生成的构建输出、依赖树和冻结的 archived Agent Note，并且只改写 `@deepseek-ai/dsh` 包名前缀。再次执行不会产生 diff。

Postcondition 让遗漏明确失败：DSH 发布成员使用 `@knyazevai/dsh*`，符合条件的当前源码不包含旧 DSH 前缀，vendored 包名保持不变，而且 CLI manifest 必须恰好是 `@knyazevai/dsh`。迁移完成后，workspace constraint 和 release-family 校验持续执行新身份规则。

该命令保留在 fork 中，使之后的 upstream 同步能够把 fork 的 npm 身份重新应用到新引入的 DSH 包和引用，而不依赖一次性的全局替换。

## Release sequence

DSH family 继续使用一个共享版本和现有 `dsh-v<version>` tag 格式。新 scope 下的首个版本是 `0.1.5`；失败的 `0.1.3` 和 `0.1.4` GitHub tag 作为历史记录保留，而失败的 workflow 未写入任何这两个版本的包。

GitHub release workflow 继续在没有 registry 凭据的情况下构建和打包，验证从生成的 tarball 安装，然后通过受保护的 `npm-publish` environment 发布完全相同的内容。`NPM_TOKEN` 属于 `knyazevai` npm 账户，绝不暴露给 pack job。

发布顺序仍然以依赖优先。Release verifier 在构建前拒绝 private member、旧 DSH 包名、共享版本不一致、tag/版本不一致或无法表示的依赖顺序。

## Installed dependency graph

发布后的 manifest 直接引用 `@knyazevai/dsh-*` sibling。本设计不使用 npm alias、安装时改写、postinstall 下载、GitHub tarball dependency，也不使用委托给 `@deepseek-ai/dsh` 的 wrapper。

这样可保持普通的安装依赖图：npm 从一个自有 scope 解析每个 DSH 依赖，Node 解析 built JavaScript 中相同的 package specifier，Cordis 加载已发布配置中的包名。可读取的 vendored dependency 继续从 `@deepseek-ai` 解析，无需 fork 获得该 scope 的发布权限。

## Verification

只有满足以下全部条件，迁移才算完成：

- source scan 和 rescope check 找不到遗留且符合条件的 `@deepseek-ai/dsh` package token；
- package constraint 和 release verification 接受 `@knyazevai` 下的全部 DSH member；
- 针对 compaction、timeout recovery 和 client bundle 的测试继续通过；
- 无密钥的低压力首 chunk 超时 snapshot 仍会执行压缩并继续；
- official build 生成完整的 Host 和 Web artifact；
- 全部 DSH 和 vendored tarball 能一起安装到空 consumer directory，且 packed executable 报告 `0.1.5`；
- tagged GitHub workflow 成功发布；以及
- `npm view @knyazevai/dsh version` 与不使用缓存的 `npx @knyazevai/dsh@0.1.5 --version` 均报告 `0.1.5`。

仓库级 hygiene 或文档检查中既有且无关的 baseline failure 单独报告，不能替代以上任何 release check。

## Alternatives considered

### Publish only a wrapper CLI

Wrapper 仍然需要不可用的 `@deepseek-ai/dsh-*` 版本，否则就必须在安装时下载并构建 GitHub 仓库。这会使 `npx` 依赖另一个网络来源、可变的仓库状态和安装时代码执行。

### Rewrite package names only inside tarballs

Artifact-time alias 可以让源码 import 保留旧 scope，同时在 alias path 下安装 mirror package。但 peer dependency、自引用、Cordis 配置、诊断和未来新增依赖将依赖第二套普通源码检查无法看到的身份图。

### Obtain access to the `@deepseek-ai` npm organization

使用原 scope 发布可减少 diff，但它依赖 fork owner 无法控制的外部组织成员资格。该 fork 已有自有 npm scope 和可工作的发布 token。

## Risks

由于包身份遍布整个 workspace，机械 diff 会很大。确定性 codemod、明确排除项、幂等性、遗留 token 检查和 packed-install verification 可降低不完整迁移的风险。

现有 `@deepseek-ai/dsh` consumer 不会自动迁移到 fork package。这是有意设计：fork 命令是 `npx @knyazevai/dsh`，不会向 fork 不拥有的 namespace 发布任何包。

未来 upstream merge 可能重新引入原始 DSH 前缀。将 rescope command 及其 check 保留在 fork 中，可在构建或发布前暴露这种 drift。
