/** Package-owned empty invariant companion for the client-only overlay. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@knyazevai/dsh-invariants'

const PACKAGE_NAME = '@knyazevai/dsh-fork-ui-workspace-overlay'

/** Cordis companion plugin name. */
export const name = 'fork-ui-workspace-overlay-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No host relation is owned by this browser-only contribution package. */
const install: InvariantInstaller = () => {}

/** Register the empty companion with the invariant service. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
