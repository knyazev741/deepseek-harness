# @knyazevai/dsh-fork-session-source

[English](README.md) | 中文

该函数插件记录：在创建会话时，配置的环境变量是否恰好等于字符串 `true`。默认变量是 `GITHUB_ACTIONS`；功能由部署环境选择性启用，不属于普通会话头。

## 组合

```yaml
- id: fork-session-source
  name: '@knyazevai/dsh-fork-session-source'
  config:
    enabledWhenEnv: GITHUB_ACTIONS
```

插件要求 `sessions`，并且只在存在 `sessionProjections` 时注册投影。没有投影注册表时加载事件生产者仍会保留持久事件。卸载插件会移除创建监听器和 `forkSessionSource` 投影注册。

## 持久事件与投影

启用后，权威的 `session/created` 会追加一个带有 `{ source: 'github-actions' }` 的仅日志 `fork/session-source` 事件，并在事件信封中标记 `ignorable: true`。标记在会话创建的同步生命周期中写入，不会改变 `SessionHeader.origin`。从已有日志创建会话时，插件会先检查已有事件，因此重放和重复发布不会再次添加标记。

`forkSessionSource` 投影从 `null` 开始；最新的有效标记会折叠为 `'github-actions'`，无关事件会返回相同的状态引用。严格的 JSON 安全模式会在重放期间拒绝格式错误的持久载荷。线上的值与该可空值相同：`null` 表示标记不存在或该会话未启用来源插件；省略投影键表示没有组合投影插件。

`ignorable` 标记让未加载这个可选插件的读取器跳过未知日志事件，同时保留会话的其余内容。配套不变量会检查已有会话及未来追加事件中的字面载荷、仅日志信封和最多一个标记关系。

## 模型体验

无。本插件记录部署元数据并提供面向客户端的投影，不注册模型上下文。

#### KV Cache 影响

无；不会改变 provider 请求或模型可见前缀。

## 已知限制与延后工作

- 标记只记录权威会话创建时的进程环境；它不证明工作流身份、仓库、引用、操作者或运行器。
- 来源值目前只有一个固定字面量。扩展其他来源需要经过评审的事件和投影扩展，不能静默放宽本包的持久载荷。
