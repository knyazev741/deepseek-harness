# @deepseek-ai/dsh-client-web

[English](README.md) | 中文

Web 外壳内核：`new AppWebEntry(el, seams?).run()` 通过两阶段启动（web2）挂载整个客户端。第一阶段（模块侧）：构建客户端模块系统（`@deepseek-ai/dsh-client-modules`），以主机推送的配置项图（`window.__DSH_BOOT__`）为基础，并行预取 `immediately` 层级；执行组合包只会注册 factory。第二阶段（插件侧）：挂载仓库内置的 Cordis Loader，并通过其 `internal` 约定注入模块系统；为每一行图数据创建一个 loader 配置项，另创建外壳自身的 app-shell 组装配置项（tree.import 会物化各模块）；以 settle 作为 AppRoot 的门禁（loader 完全停稳 + 每个配置项 fiber 都为 ACTIVE → 一次切换显示完整 UI）。组合完全由主机图决定：花名册和 immediately 层级都位于负责组合的应用中；外壳不作任何组合决策。

启动页只使用原生 DOM 与本地 CSS，因此客户端 bundle 或插件激活失败时仍能显示。其回退字体和颜色与加载期间到达的主题 token 一致。fiber 更新会保留同一个 spinner 节点，并在 entry 首次进入 active 时增长其 CSS 圆弧；hydrate 会继续保留该节点及其动画相位，直到应用提交。Modules bundle 会缓存自身已物化导出，并在其普通图 entry 激活时提供闭包中的系统；Cordis service 等待使图 row 创建顺序不依赖该激活时点。

`PLATFORM_MODULES`（src/platform.ts）是共享模块接口的唯一真源：种子表 key、tsdown 客户端 external 和 vite alias 集都是它的投影。

可选的覆盖参数 `seams` 会为外部 `<script>` 执行无法到达页面上下文的环境转发模块系统的 `loadBundle` 传输覆盖（`BootSeams`）；普通浏览器调用方省略此参数。预注入的页面传输是位于其前的默认值：当 `globalThis.__DSH_TRANSPORT__`（connection 包的 `ClientTransportHooks`）携带 `loadBundle` 时，模块阶段将其采纳为 bundle 传输并跳过 immediately 层级的 HTTP 预取——显式 `seams` 仍然优先。

外壳拥有浏览器标题投影。选中带有持久标题的会话时，它会渲染 `<session title> — <existing HTML title>` 并响应后续标题修订；未选择会话或选中无标题会话时，会保留现有标题；外壳卸载时恢复标题。现有 HTML 标题仍是可配置的产品后缀。

## 模型体验

无。入口外壳负责启动浏览器插件树；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **有意采用一次性渲染**：UI 等待启动 settle；只要一个配置项失败，加载页面就会保留并逐项显示醒目的报告，不提供部分可用性（渐进式渲染将作为独立项目恢复）。
- **窄窗口外壳行为缺少组装后演练**：ui-layout 已实现让步链，但该包没有外壳级窄视口验收用例。
