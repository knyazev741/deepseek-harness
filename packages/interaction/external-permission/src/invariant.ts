/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-external-permission`.
 * @module @deepseek-ai/dsh-external-permission/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-external-permission'

/** Cordis companion plugin name. */
export const name = 'external-permission-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this bridge owns no independent event or data stream.
 * The permission-channel lifecycle (at-most-one registration, disposal
 * restoring the fail-closed default, duplicate rejection) is exercised by the
 * `dsh-external-session` service tests and this package's own tests; the
 * channel registration relation itself is owned by that consumer seam.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
