/**
 * Fork-owned recovery for a first-chunk idle timeout: force one context
 * compaction, then queue a `continue` follow-up so the agent loop starts a new
 * turn from the replacement surface. Register the listener with `prepend`
 * so it claims the `agent/request-error` waterfall before `dsh-llm-retry`'s
 * fast backoff, which cannot fix a stalled first chunk. When compaction
 * cannot produce durable progress, the listener delegates to downstream
 * retry/cooldown policy; if no downstream policy claims the error, the
 * original `FIRST_CHUNK_TIMEOUT` ends the turn without queuing a continuation.
 *
 * @module @deepseek-ai/dsh-fork-llm-first-chunk-timeout
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'

/** Provider-neutral code emitted when this plugin's first-read timer wins. */
export const FIRST_CHUNK_TIMEOUT_CODE = 'FIRST_CHUNK_TIMEOUT'

/** Model instruction that resumes work from the compacted durable surface. */
const CONTINUATION_TEXT = 'continue'

type RequestErrorPayload = Parameters<Events['agent/request-error']>[0]
type Agent = RequestErrorPayload['agent']

/** The `agent/request-error` recovery listener plus the state it owns. */
export interface RecoveryHandle {
  /** The registered `agent/request-error` waterfall listener; register with `prepend`. */
  readonly listener: (
    payload: RequestErrorPayload,
    next: () => Promise<RequestErrorAction>,
  ) => Promise<RequestErrorAction>
  /** Remove the bookkeeping listener and drop per-agent counters. */
  readonly dispose: () => void
}

/** Queue a new turn after the timed-out driver has reached idle. */
function followUpFromCompaction(agent: Agent): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: CONTINUATION_TEXT }],
    source: { kind: 'plugin', plugin: 'fork-llm-first-chunk-timeout' },
  }))
}

/** Resolve an agent-preset compaction service before falling back to the host. */
function compactionFor(ctx: Context, agent: Agent): Context['compaction'] | undefined {
  const scoped = ctx.get('agentPresets')?.serviceFor(agent, 'compaction')
  return scoped ?? ctx.get('compaction')
}

/** Read an abort signal after an awaited recovery operation. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * Build the recovery handle for one plugin instance.
 * @param ctx - plugin context exposing the optional compaction service.
 * @param maxRetries - maximum first-chunk compactions per continuous agent activity.
 * @returns the request-error listener and its disposer.
 */
export function createRecovery(ctx: Context, maxRetries: number): RecoveryHandle {
  const counters = new Map<Agent, number>()
  const pending = new Set<Agent>()
  const onIdle = ctx.on(
    'agent/status',
    ({ agent, status }: Parameters<Events['agent/status']>[0]) => {
      if (status !== 'idle') return
      if (pending.delete(agent)) {
        // A follow-up inserted while the failed driver is still running stays
        // queued because that driver exits through its error boundary. Insert
        // it after the idle transition so `followup()` starts a fresh driver.
        followUpFromCompaction(agent)
        return
      }
      counters.delete(agent)
    },
  )

  const listener = async (
    { agent, failure, signal }: RequestErrorPayload,
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> => {
    if (signal.aborted || failure.code !== FIRST_CHUNK_TIMEOUT_CODE) return next()
    const compaction = compactionFor(ctx, agent)
    // Without a compaction engine the plugin keeps its original standalone
    // behavior: delegate the timeout to the normal retry/error chain.
    if (compaction === undefined) return next()

    const count = counters.get(agent) ?? 0
    if (count >= maxRetries) {
      ctx.logger.warn(
        `first-chunk idle timeout persisted after ${maxRetries} compactions; ending the turn`,
      )
      return undefined
    }
    const generation = agent.session.surface.replaceGeneration
    try {
      await compaction.compactIfNeeded(agent, 'context-overflow', signal)
    } catch (recoveryError: unknown) {
      const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
      if (!isAborted(signal) && agent.session.surface.replaceGeneration > generation) {
        ctx.logger.warn(
          `first-chunk compaction failed after durable surface progress: ${message}; `
          + 'continuing in a follow-up turn',
        )
        counters.set(agent, count + 1)
        pending.add(agent)
        return undefined
      }
      if (isAborted(signal)) return undefined
      ctx.logger.warn(`first-chunk compaction failed: ${message}; delegating downstream recovery`)
      return next()
    }
    if (isAborted(signal)) return next()
    if (agent.session.surface.replaceGeneration <= generation) {
      ctx.logger.warn('first-chunk idle timeout: compaction made no durable progress; delegating downstream recovery')
      return next()
    }
    counters.set(agent, count + 1)
    ctx.logger.info('first-chunk idle timeout: compacted context; continuing in a follow-up turn')
    pending.add(agent)
    return undefined
  }

  return {
    listener,
    dispose: () => {
      onIdle()
      counters.clear()
      pending.clear()
    },
  }
}
