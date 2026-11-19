---
kind: upgrade-guide
description: "Agent Teams defaults off for new Sessions and uses a saved per-Session selection."
---

# Select Agent Teams per Session

English | [中文](guide.zh.md)

## Change

Agent Teams ships with base-backed profiles; new Sessions default to off. The Plugins page has no separate Agent Teams switch. The root Session’s selection controls task tools and Team guidance throughout its subagent tree. The model and reasoning menu offers **Use Agent Teams**, and the root conversation’s Subagent header control opens members above shared tasks in one panel while enabled. Child conversations retain navigation without a shared task board.

Disabling Team retains tasks and subagents. Admitted task operations finish; queued operations check the current mode when they start. The selection survives restart. A historical task board without a saved selection remains enabled. The required `team/mode` event records selections; older readers reject this unfamiliar event. See the [persistence acknowledgement](../../../persistence-changes/2026-10-19-session-team-mode.md).

## Migration

1. Start each existing profile once. Profile loading removes the retired `@knyazevai/dsh-experimental-agent-team-profile` bundle selection; the base and Web bundles supply its plugins. Keep `agent-team`, `tool-agent-team`, and `ui-agent-team` row overrides. Custom compositions replace package names `@knyazevai/dsh-experimental-agent-team`, `@knyazevai/dsh-experimental-tool-agent-team`, and `@knyazevai/dsh-experimental-client-ui-agent-team` with `@knyazevai/dsh-agent-team`, `@knyazevai/dsh-tool-agent-team`, and `@knyazevai/dsh-client-ui-agent-team`.
2. Toggle **Use Agent Teams** in the root conversation’s model and reasoning menu. The `/team on` and `/team off` commands are removed.
3. Verify that enabling shows shared tasks in the root conversation below the Subagent tree in the same panel and exposes four task tools. Reload the Session to confirm the saved selection. Re-enabling after disabling restores the existing tasks.

Client plugin consumers replace `TeamActionProps` with `TeamBoardProps`; task content registers in `conversation.session.header.actions.subagent.footer` instead of the header actions slot.
