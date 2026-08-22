# fork/ — fork-owned capability overlays

English | [中文](README.zh.md)

The fork group contains opt-in host capabilities that stay in independent plugins while sharing the harness session and projection seams. These packages are not mounted by ordinary profiles unless a deployment explicitly composes them.

| Package | Role | ctx key |
|---|---|---|
| [`session-source/`](session-source/README.md) | Records and projects the GitHub Actions session source | `forkSessionSource` projection |
| [`workspace-session-state/`](workspace-session-state/README.md) | Persists the ordered global pin list for workspace sessions | `forkWorkspaceSessionState` |

Each package owns its durable event, projection or service contract, invariant companion, and lifecycle disposal. The group does not alter `SessionHeader` or the model-visible session surface.
