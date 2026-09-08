/** Runtime-invariant companion for the provider-neutral external-session registry. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@knyazevai/dsh-invariants'

const PACKAGE_NAME = '@knyazevai/dsh-fork-external-session'

/** Cordis companion plugin name. */
export const name = 'fork-external-session-invariant'
/** The invariant registry is required before this companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns only an in-memory registration map;
 * duplicate and disposer ownership are asserted by the registry's service
 * tests, and no event or durable relation exists for a companion to observe.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's empty invariant companion.
 * @param ctx - context carrying the invariant registry.
 * @returns the installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
