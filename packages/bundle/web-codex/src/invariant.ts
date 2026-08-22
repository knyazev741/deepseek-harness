/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-web-codex`.
 * @module @deepseek-ai/dsh-web-codex/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-web-codex'

/** Cordis companion plugin name. */
export const name = 'web-codex-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: this bundle owns only a static patch list. The
// external-session registry, provider, bridge, and gateway each own their
// runtime relationships and invariants; this package has no mutable relation
// to audit itself.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
