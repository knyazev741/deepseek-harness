/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-external-session-bridge`.
 * @module @deepseek-ai/dsh-external-session-bridge/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-external-session-bridge'

/** Cordis companion plugin name. */
export const name = 'external-session-bridge-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this driver owns no independent event or data stream.
 * The relations it participates in are owned by the seams it consumes — the
 * external-session start/dispose lifecycle and the session-projections
 * registration are asserted by the `dsh-external-session`,
 * `dsh-session-projection`, and `dsh-host-apiproxy` suites plus this package's
 * own composition test — and the mode-aware creation decision lives in the
 * `dsh-host-apiproxy` gateway rather than here.
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
