---
kind: upgrade-guide
description: Explicit permission commands also change the default for future sessions, and model selection waits for default persistence.
---

# New-session preferences

English | [中文](guide.zh.md)

## Change

The `/permission <preset>` command saves a configured preset as the profile default for future Sessions. Existing Sessions keep their own permissions. Auto remains session-local, and programmatic `permissionPresets.set()` calls do not change the default. A failed profile write reports that the Session changed while its new-session default did not save.

New-chat creation waits for admitted profile edits before reading its defaults. `session.selectModel` waits for its default save attempt before acknowledging the selection. A failed write still leaves the Session-local selection in effect and logs a warning. Higher-priority home or command-line overrides remain authoritative and can block profile writes.

## Migration

1. Review the configured permission presets. Choosing Full access now also makes Full access the default for subsequently created Sessions; choosing a configured approval preset changes that default again. Use `permissionPresets.set()` in custom integrations that need a Session-only change.
2. If the model picker returns to an obsolete default, stop the profile and remove the `agent-default-model` override from `$DSH_HOME/cordis.patch.yml` or the command-line overlay that pins it. Keep provider definitions and credentials; only the default-model row needs removal.
3. Select an available model and permission preset, create a new chat, and verify both choices. Reopen an older chat to confirm its permissions remain independent.
