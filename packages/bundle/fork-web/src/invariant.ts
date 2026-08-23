/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-fork-web`.
 * @module @deepseek-ai/dsh-fork-web/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-fork-web'

/** Cordis companion plugin name. */
export const name = 'fork-web-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// The composition is entirely represented by the static patch list. Mounted
// runtime relations belong to the fork package and its own invariant.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
