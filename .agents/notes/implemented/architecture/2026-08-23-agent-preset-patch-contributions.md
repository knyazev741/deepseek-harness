# Agent Note: Agent preset patch contributions

Status: implemented

English | [中文](2026-08-23-agent-preset-patch-contributions.zh.md)

## Problem

Deployment plugins need to adjust an existing Agent Preset without copying its composition file, changing the user's roster, or creating a second preset id. The existing filesystem composition is intentionally the stored input and the standing mount is shared by all agents that join one preset, so a deployment overlay needs an explicit lifetime and generation owner.

## Decision

`AgentPresets` exposes an optional patch-contributor face at `Symbol.for('dsh.agent-presets.patch-contributor')`, exported as `AGENT_PRESET_PATCH_CONTRIBUTOR`. Its `register({ presetId, patches })` method validates a non-empty target id and patch list, deep-copies and freezes the patches, preserves contribution order, and registers the contribution through the caller's Cordis effect. Disposing the owner removes the contribution and advances that target's generation.

Standing mounts snapshot the flattened contributions for their preset and pass the snapshot through `Include.Config.patches`. The standing cache is keyed by the composition file stamp and contribution generation. A later mount creates a new generation after either changes; agents already parented to an older standing key, including children joined with `composeFrom()`, retain that generation. Filesystem `read()` and `copy()` continue to expose and copy the stored composition without deployment overlays.

The contributor face is an extension of `AgentPresets`, not a new capability seam. A plugin can feature-detect the symbol and remain functional on Hosts that do not expose it.

## Alternatives considered

**Materializing patches into preset files:** Rejected because deployment state would become user-authored state, copies would lose the distinction between source and overlay, and shared files could change the composition of already running sessions.

**Creating a virtual preset per deployment overlay:** Rejected because it would duplicate roster ids and default-selection behavior, while child composition would need another identity to preserve the parent's standing generation.

**Replacing the `AgentPresets` service with a separate registry seam:** Rejected because the patch lifetime and generation are owned by standing preset mounts; a second service would split that ownership and add an unnecessary Service Definition/Provider/Consumer seam.

## Consequences

Deployment plugins can layer a bounded patch list onto a shipped preset while preserving user files, session headers, and child-agent composition. Contribution registration is optional and older Hosts remain usable when the symbol is absent. Superseded standing generations remain mounted for existing agents and are reclaimed only with the roster's whole-tree lifetime, matching existing file-generation behavior.
