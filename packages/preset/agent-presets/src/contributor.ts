/** Runtime extension point for deployment-owned patches applied at mount time. */

import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/**
 * Symbol-keyed feature-detection key for the preset patch contributor.
 *
 * The global symbol registry keeps this key stable across package copies, so a
 * plugin can discover a compatible Host without importing a version-specific
 * Agent Presets package.
 */
export const AGENT_PRESET_PATCH_CONTRIBUTOR = Symbol.for('dsh.agent-presets.patch-contributor')

/** One deployment contribution applied to a named preset at standing mount creation. */
export interface AgentPresetPatchContribution {
  /** Existing preset id receiving the contribution. */
  readonly presetId: string
  /** Ordered Include patches appended as one contribution layer. */
  readonly patches: readonly PatchOptions[]
}

/** Symbol-discovered registration face exposed by {@link AgentPresets}. */
export interface AgentPresetPatchContributor {
  /**
   * Register one ordered patch contribution.
   * @param contribution - target preset and its non-empty patch list.
   * @returns a disposer that removes the contribution.
   */
  register(contribution: AgentPresetPatchContribution): () => void
}
