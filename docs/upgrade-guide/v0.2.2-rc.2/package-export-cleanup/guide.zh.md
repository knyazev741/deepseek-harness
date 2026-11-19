---
kind: upgrade-guide
description: 更新已移除的包子路径；保留入口上的标识符构造函数仍可用。
---

# 更新已移除的包子路径导入

[English](guide.md) | 中文

## 变更

从 v0.2.2-rc.2 升级会移除下列七个包子路径。既有字符串恒等构造函数在保留的入口上仍然可用，其实现和品牌类型定义均保留。`/types` 入口仅再导出这些类型，不导出运行时值。持久化字符串、Session 格式、校验和 ID 生成行为不变。

| 已移除子路径 | 类型导入或受支持的替代方式 |
|---|---|
| `@knyazevai/dsh-commands/brand` | `@knyazevai/dsh-commands/types` |
| `@knyazevai/dsh-browser-use/brand` | `@knyazevai/dsh-browser-use/types` |
| `@knyazevai/dsh-computer-use/brand` | `@knyazevai/dsh-computer-use/types` |
| `@knyazevai/dsh-jobs/brand` | `@knyazevai/dsh-jobs/types` |
| `@knyazevai/dsh-llm/brand` | `@knyazevai/dsh-llm/types` |
| `@knyazevai/dsh-tools/presentation` | 从 `@knyazevai/dsh-tools` 导入类型 |
| `@knyazevai/dsh-file-reference-local/search` | 使用 `fileReferences` 服务；没有替代的公开搜索辅助值 |

## 迁移

1. 将标识符类型导入从五个 `/brand` 路径移至对应 `/types` 入口，并使用 `import type`。这些入口不能替代运行时构造函数导入。
2. 对原来从已移除路径调用构造函数的代码，commands、jobs 和 LLM 调用方可以改从包根入口导入保留的构造函数。Browser/computer provider-name 构造函数原本不是根出口，应使用 `brandString<ProviderName>(value)` 并从 `/types` 导入类型。导入这个运行时辅助函数时，应将 `@knyazevai/dsh-brand` 加为直接依赖。保留原有位置上的校验和 UUID/计数器生成操作。

   ```ts
   import { brandString } from '@knyazevai/dsh-brand'
   import type { BrowserUseProviderName } from '@knyazevai/dsh-browser-use/types'

   const providerName = brandString<BrowserUseProviderName>('my-browser-provider')
   ```

3. 编译并运行插件/SDK 测试，再用 Node 加载纯 JavaScript fixture。检查是否出现 `ERR_PACKAGE_PATH_NOT_EXPORTED` 或缺少具名出口错误；仅靠 TypeScript 检查覆盖不到 `.mjs` 消费者。
