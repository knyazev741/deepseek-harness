---
kind: upgrade-guide
description: "Windows startup automatically adopts manual system HTTP(S) proxies when no explicit proxy address is configured."
---

# Windows system proxy selection

English | [中文](guide.zh.md)

## Change

Windows startup now reads the current user's manual system HTTP(S) proxy by default when no `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` address is configured. Existing explicit addresses retain priority. Loopback remains direct. Invalid system settings, PAC scripts, and discovery failures stop startup with an actionable diagnostic rather than choosing an unknown route. Other operating systems retain environment-based routing.

## Migration

1. Keep the default automatic mode to use a proxy application's Windows system-proxy setting. Restart DSH after changing that setting; startup reports `Using Windows system proxy` when one is selected.
2. To retain environment-only routing, put `DSH_PROXY_MODE=environment` in `$DSH_HOME/.env`, or export it before launching. Use `DSH_PROXY_MODE=direct` to disable all proxies.
3. For PAC or SOCKS configurations, supply an explicit HTTP(S) endpoint through `HTTP_PROXY` and `HTTPS_PROXY`, or explicitly select direct mode. The [proxy guide](../../../user/guide/network-proxy.md) documents configuration and limits.
