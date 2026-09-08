/**
 * Package-owned invariant companion for `@knyazevai/dsh-fork-llm-rate-limit-cooldown`.
 * @module @knyazevai/dsh-fork-llm-rate-limit-cooldown/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@knyazevai/dsh-invariants'

const PACKAGE_NAME = '@knyazevai/dsh-fork-llm-rate-limit-cooldown'

/** Cordis companion plugin name. */
export const name = 'llm-rate-limit-cooldown-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this plugin only delays and returns a retry action on
 * the `agent/request-error` waterfall; it writes no durable session event and
 * adds no model-visible surface. Its recovery decision is proven by package
 * tests against the loop's retry action.
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
