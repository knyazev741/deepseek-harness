/** Runtime invariant companion for the workspace session pin service. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@knyazevai/dsh-invariants'

const PACKAGE_NAME = '@knyazevai/dsh-fork-workspace-session-state'

/** Cordis companion plugin name. */
export const name = 'fork-workspace-session-state-invariant'
/** The invariant registry is required before this companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: Settings schema validation and its CAS revision own the mutable persisted
 * relation; workspace membership is checked at write admission and may later change independently.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - context carrying the invariant registry.
 * @returns the installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
