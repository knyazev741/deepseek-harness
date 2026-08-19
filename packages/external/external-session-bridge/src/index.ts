/**
 * @deepseek-ai/dsh-external-session-bridge — the host-plane drive plugin that
 * connects the external-session registry (`ctx.externalSessions`) to real host
 * sessions created in an external mode. It reacts to each `session/created`
 * whose durable header `mode` names a registered external provider: it starts
 * that provider's live session on the pre-reserved session id (recording the
 * activity the provider writes through its bridge into the owning session's
 * durable log), registers the external-transcript projection unit so replay and
 * client rendering never re-walk the raw event log, and disposes the provider
 * process tree when the session is disposed.
 *
 * The mode-aware creation decision — stamp `mode` on the durable header and
 * create the session WITHOUT a native Agent for an external mode — lives in the
 * session-create gateway (`dsh-host-apiproxy`), not here. This plugin only
 * reacts to already-stamped sessions, so it composes wherever the
 * external-session family is mounted. `session/created` fires after the session
 * entered the store, so the provider's bridge can append events to it. Live
 * transcript deltas ride the provider bridge's `streamDelta`, which the
 * external-session Service Definition owns (routing to the frame channel is a
 * later client-phase concern).
 *
 * @module @deepseek-ai/dsh-external-session-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { externalTranscriptProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
// Type-only: brings in external-session's `Context.externalSessions` merge.
import type {} from '@deepseek-ai/dsh-external-session'

/** Stable Cordis plugin name (loader diagnostics, effect labels). */
export const name = 'external-session-bridge'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * An external provider's `start` rejected for a session already published
     * in an external mode, so no live external process is running. A later
     * phase decides the durable/UI surface; here it is the loud host signal
     * that the create-time mode choice did not come up.
     * @param payload - the session, its chosen provider, and the rejection reason.
     * @mode emit
     */
    'external/session-bridge/error'(payload: {
      sessionId: SessionId
      provider: string
      error: unknown
    }): void
  }
}

/** Services required before this driver can own external sessions. */
export const inject = ['externalSessions', 'sessionProjections']

/** Driver configuration: currently none — the mode-aware choices live in Config of future phases. */
export interface Config {}

/** Empty validated configuration; the driver ships with no tunables. */
export const Config: z<Config> = z.object({})

/**
 * Start the provider's live session for an already-stamped external session.
 * The provider's name is the session's durable header `mode`; the session must
 * carry an absolute `cwd` for the external agent to run in (the create gateway
 * always resolves a project directory before creating). A rejection surfaces on
 * the typed {@link Events} channel so it is not silently dropped.
 * @param ctx - the plugin context.
 * @param session - the external-mode session just created.
 * @param mode - the provider/mode name stamped on the session header.
 */
function startOnProvider(ctx: Context, session: Session, mode: string): void {
  const cwd = session.header.cwd
  if (cwd === undefined) {
    throw new Error(`external-session-bridge: external session ${String(session.id)} has no cwd`)
  }
  void ctx.externalSessions.start({
    sessionId: session.id,
    provider: mode,
    cwd,
    // The initial model the create gateway stamped on the durable header; the
    // provider resolves it against its own catalog/roster at start.
    ...session.header.model === undefined ? {} : { model: session.header.model },
  }).catch((error: unknown) => {
    // A provider that rejects start (e.g. an unavailable child process) must
    // surface: the session is already published, so the failure cannot unwind
    // the creation dispatch. Emit the loud host signal rather than an
    // unhandled rejection.
    ctx.emit('external/session-bridge/error', { sessionId: session.id, provider: mode, error })
  })
}

/**
 * Mount the bridge driver: register the transcript projection unit, then react
 * to external-mode session creation and disposal.
 * @param ctx - the plugin context.
 * @param _config - validated (empty) {@link Config}.
 */
export function apply(ctx: Context, _config: Config): void {
  ctx.sessionProjections.register(externalTranscriptProjectionDefinition)
  // Sessions this fiber started; only those are disposed on `session/disposed`.
  const started = new Set<SessionId>()
  ctx.on('session/created', (session: Session) => {
    const mode = session.header.mode
    if (mode === undefined || mode === 'dsh') return
    const provider = ctx.externalSessions.getProvider(mode)
    if (provider === undefined) {
      throw new Error(
        `external-session-bridge: session ${String(session.id)} was created in mode "${mode}" `
        + 'but no such external provider is registered',
      )
    }
    started.add(session.id)
    startOnProvider(ctx, session, mode)
  })
  ctx.on('session/disposed', (session: Session) => {
    if (started.delete(session.id)) {
      void ctx.externalSessions.dispose(session.id)
    }
  })
}
