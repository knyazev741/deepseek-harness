/**
 * Provider-neutral registry for opt-in external-session implementations.
 * Providers add their mode and implementation types by merging
 * {@link ExternalSessionModeMap}; this package owns no provider protocol,
 * transcript vocabulary, process lifecycle, or default registration.
 *
 * @module @knyazevai/dsh-fork-external-session
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ExternalSessionMode, ExternalSessionProvider } from './types.ts'

export type * from './types.ts'

/** Provider types keyed by the mode ids contributed by later packages. */
export interface ExternalSessionModeMap {}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional registry for explicitly composed external-session providers. */
    externalSessions: ExternalSessionRegistry
  }
}

interface Registration {
  readonly provider: unknown
}

/**
 * Effect-owned registry for external-session providers.
 *
 * The service is intentionally valid with zero registrations. A provider
 * package must explicitly compose itself and contribute its mode type; this
 * registry never selects or mounts a default implementation.
 */
export class ExternalSessionRegistry extends Service {
  private readonly registrations = new Map<string, Registration>()

  /**
   * Create the empty registry service at `ctx.externalSessions`.
   * @param ctx - context that owns the registry.
   */
  constructor(ctx: Context) {
    super(ctx, 'externalSessions')
  }

  /**
   * Register one provider under its unique mode id.
   * @param mode - provider mode declared in {@link ExternalSessionModeMap}.
   * @param provider - implementation owned by the registering plugin.
   * @returns a disposer that removes this exact registration.
   */
  register<Mode extends ExternalSessionMode>(mode: Mode, provider: ExternalSessionProvider<Mode>): () => void {
    if (this.registrations.has(mode)) {
      throw new Error(`external session mode "${String(mode)}" is already registered`)
    }

    const registration: Registration = { provider }
    const dispose = this.ctx.effect(function* (this: ExternalSessionRegistry) {
      this.registrations.set(mode, registration)
      yield () => {
        if (this.registrations.get(mode) === registration) {
          this.registrations.delete(mode)
        }
      }
    }.bind(this), 'externalSessions.register()')
    // The registry API intentionally exposes synchronous fire-and-forget disposal.
    return () => { void dispose() }
  }

  /**
   * Resolve a provider for a mode and fail explicitly when it is absent.
   * @param mode - provider mode declared in {@link ExternalSessionModeMap}.
   * @returns the provider registered for `mode`.
   * @throws `Error` when no provider owns `mode`.
   */
  lookup<Mode extends ExternalSessionMode>(mode: Mode): ExternalSessionProvider<Mode> {
    const registration = this.registrations.get(mode)
    if (registration === undefined) {
      throw new Error(`external session mode "${String(mode)}" is not registered`)
    }
    return registration.provider as ExternalSessionProvider<Mode>
  }
}

export default ExternalSessionRegistry
