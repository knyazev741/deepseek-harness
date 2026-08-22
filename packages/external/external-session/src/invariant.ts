/**
 * Package-owned external-session registry invariants.
 * @module @deepseek-ai/dsh-external-session/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ExternalAgentDescriptor, ExternalModelDirectory } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-external-session'

/** Cordis companion plugin name. */
export const name = 'external-session-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** The closed set of {@link ExternalModelDirectory} values a descriptor may carry. */
const VALID_MODEL_DIRECTORIES: readonly ExternalModelDirectory[] = ['provider', 'config']

/**
 * Install the provider-registry formation checks. The registry↔descriptor
 * relation (the source of every start's provider) is asserted from the
 * `external/provider-added` / `external/provider-removed` pair: an added
 * descriptor is well-formed and uniquely registered, and a removal names a
 * listed provider. Session start enforcement (a started session's provider is
 * always a listed descriptor) lives at the {@link ExternalSessions.start}
 * admission boundary, which fails loud for an unlisted provider before any
 * bridge is handed.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const providers = new Set(ctx.externalSessions.list())
  const stagedAdds = new Map<string, ExternalAgentDescriptor>()
  const stagedRemovals = new Set<string>()

  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName === 'external/provider-added') {
      const descriptor = args[0] as ExternalAgentDescriptor
      if (descriptor.provider.length === 0 || descriptor.label.length === 0) {
        fail('external provider names and labels must be non-empty')
      }
      if (!VALID_MODEL_DIRECTORIES.includes(descriptor.modelDirectory)) {
        fail(`external provider "${descriptor.provider}" has unknown modelDirectory ${JSON.stringify(descriptor.modelDirectory)}`)
      }
      if (providers.has(descriptor.provider)) {
        fail(`external/provider-added repeated ${JSON.stringify(descriptor.provider)}`)
      }
      stagedAdds.set(descriptor.provider, descriptor)
      return
    }
    if (eventName === 'external/provider-removed') {
      const provider = args[0] as string
      if (!providers.has(provider)) {
        fail(`external/provider-removed names unknown provider ${JSON.stringify(provider)}`)
      }
      stagedRemovals.add(provider)
      return
    }
  }, { global: true })

  ctx.on('external/provider-added', (descriptor) => {
    /* v8 ignore next -- internal/dispatch stages the same descriptor object */
    if (!stagedAdds.delete(descriptor.provider)) return
    providers.add(descriptor.provider)
  }, { global: true })
  ctx.on('external/provider-removed', (provider) => {
    /* v8 ignore next -- internal/dispatch stages the same provider name */
    if (!stagedRemovals.delete(provider)) return
    providers.delete(provider)
  }, { global: true })
}, { inject: ['externalSessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
