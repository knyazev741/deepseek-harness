/**
 * Package-owned invariant companion for `@knyazevai/dsh-fork-base`.
 * @module @knyazevai/dsh-fork-base/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@knyazevai/dsh-invariants'

const PACKAGE_NAME = '@knyazevai/dsh-fork-base'

/** Cordis companion plugin name. */
export const name = 'fork-base-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: this package carries only a static patch list. The
// mounted fork packages own the runtime relations and their package-specific
// invariant companions.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
