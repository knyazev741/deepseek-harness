/** Package-owned invariant companion for `@deepseek-ai/dsh-mcp-gateway`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-gateway'

/** Cordis companion plugin name. */
export const name = 'mcp-gateway-invariant'
/** The invariant registry is required before package ownership is reserved. */
export const inject = ['invariants']

/** No runtime invariant: WebServer asserts route ownership; the lease disposer and owning service effect await cleanup. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
