---
kind: upgrade-guide
description: "未显式配置代理地址时，Windows 启动会自动采用手动系统 HTTP(S) 代理。"
---

# Windows 系统代理选择

[English](guide.md) | 中文

## 变更

未配置 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY` 地址时，Windows 启动现在默认读取当前用户的手动系统 HTTP(S) 代理。已有显式地址保留优先级。Loopback 保持直连。无效系统设置、PAC 脚本或发现失败会中止启动并显示可操作的诊断，而非选择未知路由。其他操作系统保留基于环境的路由。

## 迁移

1. 保持默认自动模式即可使用代理软件的 Windows 系统代理设置。更改设置后需重启 DSH；选中代理时，启动输出 `Using Windows system proxy`。
2. 如需保留仅基于环境的路由，将 `DSH_PROXY_MODE=environment` 写入 `$DSH_HOME/.env`，或在启动前导出。使用 `DSH_PROXY_MODE=direct` 可禁用所有代理。
3. 对 PAC 或 SOCKS 配置，通过 `HTTP_PROXY` 与 `HTTPS_PROXY` 提供显式 HTTP(S) 端点，或明确选择直连模式。[代理指南](../../../user/guide/network-proxy.zh.md)说明配置与限制。
