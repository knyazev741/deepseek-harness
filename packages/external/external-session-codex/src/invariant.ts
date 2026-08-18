/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-external-session-codex`.
 * @module @deepseek-ai/dsh-external-session-codex/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ExternalAgentDescriptor } from '@deepseek-ai/dsh-external-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-external-session-codex'

/** Cordis companion plugin name. */
export const name = 'external-session-codex-invariant'
/** Services required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Assert the codex provider's registry relation: whenever the `codex`
 * descriptor enters the registry (`external/provider-added`), it must answer
 * models natively (`modelDirectory === 'provider'`, per the 0.147.0 model/list
 * evidence) and register exactly once. This checks the authoritative registry
 * transition event, not service/method presence.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  let seen = false
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'external/provider-added') return
    const descriptor = args[0] as ExternalAgentDescriptor
    if (descriptor.provider !== 'codex') return
    if (descriptor.modelDirectory !== 'provider') {
      fail('codex provider must answer models natively (model/list exists in 0.147.0 evidence)')
    }
    if (seen) {
      fail('codex provider registered more than once')
    }
    seen = true
  }, { global: true })
}, { inject: ['externalSessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - plugin context carrying the invariant registry.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
