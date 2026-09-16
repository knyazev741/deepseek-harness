/**
 * Cordis plugin that records and projects the GitHub Actions origin of a
 * session without changing the core session header.
 *
 * @module @knyazevai/dsh-fork-session-source
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@knyazevai/dsh-session'
import { forkSessionSourceProjectionDefinition } from './projection.ts'

// Type-only imports make the optional projection and session event augmentations
// available to aggregate programs that consume this package's root entrypoint.
import type {} from '@knyazevai/dsh-session-projection'

export type * from './types.ts'
import type {} from './types.ts'
export { forkSessionSourceEventDataSchema, forkSessionSourceProjectionDefinition, forkSessionSourceSchema } from './projection.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fork-session-source'

/** The session store is required for the authoritative creation lifecycle. */
export const inject = ['sessions']

/** Configuration for selecting the environment variable that enables the marker. */
export interface Config {
  /** Environment variable whose exact value `true` enables the marker; defaults to `GITHUB_ACTIONS`. */
  readonly enabledWhenEnv: string
}

/** Loader schema for {@link Config}; the default keeps ordinary CI deployments zero-config. */
export const Config: z<Config> = z.object({
  enabledWhenEnv: z.string().min(1).default('GITHUB_ACTIONS'),
})

/** The fixed payload written to every enabled session. */
const SOURCE_EVENT_DATA = { source: 'github-actions' } as const

/** Whether a session already contains the source marker in its persisted log. */
function hasSourceMarker(session: Session): boolean {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing fork history read retained during upstream migration.
  return session.snapshotEvents().some(event => event.type === 'fork/session-source')
}

/**
 * Register the optional projection and the synchronous session-created marker.
 * @param ctx - context carrying the session service.
 * @param config - validated environment-key configuration.
 */
export function apply(ctx: Context, config: Config = { enabledWhenEnv: 'GITHUB_ACTIONS' }): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(forkSessionSourceProjectionDefinition)
  })
  ctx.inject(['sessions'], (sessionCtx) => {
    sessionCtx.on('session/created', (session) => {
      if (process.env[config.enabledWhenEnv] !== 'true' || hasSourceMarker(session)) return
      session.append('fork/session-source', SOURCE_EVENT_DATA, { ignorable: true })
    }, { global: true })
  })
}
