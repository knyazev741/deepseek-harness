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
import type { ExternalSessionStartFailedData } from '@deepseek-ai/dsh-session-projection'
import { ExternalProviderThreadId, parseExternalProviderThreadId } from '@deepseek-ai/dsh-external-session'
// Type-only: brings in external-session's `Context.externalSessions` merge.
import type {} from '@deepseek-ai/dsh-external-session'

/** Stable Cordis plugin name (loader diagnostics, effect labels). */
export const name = 'external-session-bridge'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * An external provider's `start` rejected for a session already published
     * in an external mode, so no live external process is running. A later
     * phase also records bounded `external/session-start-failed` and terminal
     * `external/session-ended` events; this signal carries the raw host error
     * only for diagnostics and is not the client-facing failure surface.
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

/** Return the durable provider thread id, or null for an invalid persisted id. */
function durableProviderThreadId(session: Session) {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type !== 'external/session-started') continue
    const data = event.data
    return parseExternalProviderThreadId(data.providerThreadId) ?? null
  }
  return undefined
}

function externalModel(session: Session): string | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type === 'external/model-switched') return event.data.model
    if (event?.type === 'external/session-started') return event.data.model ?? session.header.model
  }
  return session.header.model
}

/** Convert a provider start rejection into bounded facts safe for the session log and UI. */
function startupFailure(provider: string, error: unknown): ExternalSessionStartFailedData {
  const code = typeof error === 'object' && error !== null
    && 'code' in error && (error as { readonly code?: unknown }).code === 'SESSION_DISPOSED'
    ? 'startup-aborted'
    : 'startup-failed'
  return {
    provider,
    code,
    message: code === 'startup-aborted'
      ? '外部智能体启动已取消。'
      : '外部智能体启动失败，请检查提供方配置。',
  }
}

/** Append one terminal startup failure exactly once after publication. */
function appendStartupFailure(session: Session, provider: string, error: unknown): void {
  if (!session.events.some(event => event.type === 'external/session-start-failed')) {
    session.append('external/session-start-failed', startupFailure(provider, error))
  }
  if (!session.events.some(event => event.type === 'external/session-ended')) {
    session.append('external/session-ended', { stopReason: 'error' })
  }
}

/**
 * Start or resume the provider's live session for an already-stamped external
 * session. The provider's name is the session's durable header `mode`; the
 * session must carry an absolute `cwd` for the external agent to run in. A
 * rejection surfaces on the typed {@link Events} channel so it is not silently
 * dropped.
 * @param ctx - the plugin context.
 * @param session - the external-mode session just created or materialized.
 * @param mode - the provider/mode name stamped on the session header.
 */
function startOnProvider(ctx: Context, session: Session, mode: string): void {
  const cwd = session.header.cwd
  if (cwd === undefined) {
    throw new Error(`external-session-bridge: external session ${String(session.id)} has no cwd`)
  }
  const model = externalModel(session)
  const request = {
    sessionId: session.id,
    provider: mode,
    cwd,
    // The initial model the create gateway stamped on the durable header; the
    // provider resolves it against its own catalog/roster at start.
    ...model === undefined ? {} : { model },
  }
  const providerThreadId = durableProviderThreadId(session)
  const operation = providerThreadId === undefined
    ? ctx.externalSessions.start(request)
    : ctx.externalSessions.resume(request, providerThreadId === null ? ExternalProviderThreadId('') : providerThreadId)
  void operation.catch((error: unknown) => {
    // A provider that rejects start (e.g. an unavailable child process) must
    // surface: the session is already published, so the failure cannot unwind
    // the creation dispatch. Record bounded facts for replay/UI, then emit the
    // raw host signal for diagnostics rather than an unhandled rejection.
    appendStartupFailure(session, mode, error)
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
      void ctx.externalSessions.dispose(session.id).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'UNKNOWN_SESSION') return
        ctx.emit('external/session-bridge/error', {
          sessionId: session.id,
          provider: session.header.mode ?? 'unknown',
          error,
        })
      })
    }
  })
}
