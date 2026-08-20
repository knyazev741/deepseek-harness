# Agent Note: Command Remote 参数同步

Status: implemented

[English](2026-08-20-command-remote-argument-sync.md) | 中文

## 问题

命令执行器的 Host 签名在保留的取消参数 `signal` 之前新增了必需的业务参数 `images`，但 Client 调用方与生成的 Host-for-Client 产物没有一起更新。陈旧 descriptor 仍暴露 `execute(agentId, line, signal?)`，因此 Gateway 把 carrier signal 作为第三个位置参数追加给 `CommandRuntime.execute(agent, line, images, signal)`。执行器随后从 `undefined` 读取 `signal.aborted`，UI 在 `/compact` 到达 handler 之前就显示 `command.execute failed`。直接 Host 测试一直通过，因为它们已经传入了 `[]`；只有组装后的 Remote 路径暴露了这个不匹配。

图片信封决策仍由[命令图片附件信封 Note](../feature/2026-08-17-command-image-attachment-envelope.md)负责。本 Note 记录该共享方法签名变化时跨平面同步所需的规则。

## 决策

`CommandRuntime.execute` 继续把 `images` 作为必需的业务参数；普通命令调用显式传入 `[]`。所有现有 Client 调用方——命令 composer、Session 便捷方法和 plan 控件——现在都传入这个空批次，fixture endpoint 也接受并转发同一个可选 wire 字段。

Typert 的 Host reflection、Host-for-Client Remote 投影和组装后的 `api-remotes` Client bundle 是同一组生成产物，必须从 Host 源码重新生成，然后 Client 才能编译或打包。因此生成的 descriptor 会在 `parameters` 中列出 `images`，并只在 `cancellation` 中保留 `signal`；不增加 Gateway 兼容分支或位置参数回退。这遵循 [Typert Remote 方法调用决策](../architecture/2026-08-02-typert-remote-method-calls.md)及[生成约定的有序构建](../process/2026-08-08-api-remotes-generated-contract-build.md)。

built-library 回归测试通过生成的 Client Remote、真实 HTTP `/api` 路由、Host Gateway 和 `CommandRuntime` 调用 `/compact`，因此陈旧的位置参数 descriptor 不能躲在直接 Service 测试之后。

## 备选方案

**从 Host 方法中移除 `images`，或让取消参数容忍位置错误。** 拒绝：这会丢掉已经发布的图片信封契约，或掩盖生成参数缺失，未来带图命令仍会在同一位置发生错误。

**增加能够检测旧参数数量的 Gateway 兼容 shim。** 拒绝：预发布仓库不承诺陈旧生成产物的兼容性，回退会让源码与已发布 descriptor 静默漂移，而不是让构建依赖显式失败。

**只更新 `/compact` 的 UI 调用。** 拒绝：Remote 签名由所有命令调用方共享，包括 plan 控件、Session helper、fixture 和未来的普通调用；留下任何旧调用都会保留同一个位置参数缺陷。

## 后果

普通命令调用方即使没有图片，也必须声明完整的业务信封。带图调用方必须在同一位置传入编码图片数组，不能把取消 signal 作为第三个参数。生成的 `lib` 产物仍是派生文件，因此 clean 或 production build 必须先运行 Host Typert pass，再运行 Client pass。除了直接命令和 compaction 测试之外，回归测试现在还覆盖用户可见的 `/compact` 路径。

## 测试

新增的 UI 回归测试先以收到 `undefined` 而不是 `[]` 失败，更新调用方后通过。目标 Client TypeScript project 均可编译；命令 UI、fixture Remote、Session、plan、命令注册表和 compaction 包的聚焦套件共 207 个测试通过。built-library HTTP Remote 测试通过，`/compact` 返回成功并产生两条 lifecycle 事件。
