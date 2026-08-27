/**
 * Fork-owned recovery for a first-chunk idle timeout: force one context
 * compaction, then return a retry so the agent loop re-attempts the same
 * request from the replacement surface. Register the listener with `prepend`
 * so it claims the `agent/request-error` waterfall before `dsh-llm-retry`'s
 * fast backoff, which cannot fix a stalled first chunk. When compaction
 * cannot produce durable progress (no compactable range, or the same request
 * keeps timing out across the ceiling), the listener vetoes the chain so the
 * original `FIRST_CHUNK_TIMEOUT` error ends the turn instead of spinning on
 * retries that will not help.
 *
 * @module @deepseek-ai/dsh-fork-llm-first-chunk-timeout
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'

/** Provider-neutral code emitted when this plugin's first-read timer wins. */
export const FIRST_CHUNK_TIMEOUT_CODE = 'FIRST_CHUNK_TIMEOUT'

type RequestErrorPayload = Parameters<Events['agent/request-error']>[0]
type Agent = RequestErrorPayload['agent']

interface StepKey {
  readonly turn: number
  readonly step: number
  readonly provider: string
}

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

function sameStep(a: StepKey, b: StepKey): boolean {
  return a.turn === b.turn && a.step === b.step && a.provider === b.provider
}

/**
 * Build the recovery handle for one plugin instance.
 * @param ctx - plugin context exposing the optional compaction service.
 * @param maxRetries - maximum first-chunk compactions per failing request step.
 * @returns the request-error listener and its disposer.
 */
export function createRecovery(ctx: Context, maxRetries: number): RecoveryHandle {
  const counters = new Map<Agent, { readonly key: StepKey; count: number }>()
  const onIdle = ctx.on(
    'agent/status',
    ({ agent, status }: Parameters<Events['agent/status']>[0]) => {
      if (status === 'idle') counters.delete(agent)
    },
  )

  const listener = async (
    { agent, turn, step, provider, failure, signal }: RequestErrorPayload,
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> => {
    if (signal.aborted || failure.code !== FIRST_CHUNK_TIMEOUT_CODE) return next()
    const compaction = ctx.get('compaction')
    // Without a compaction engine the plugin keeps its original standalone
    // behavior: delegate the timeout to the normal retry/error chain.
    if (compaction === undefined) return next()

    const key: StepKey = { turn, step, provider }
    const prior = counters.get(agent)
    const state = prior !== undefined && sameStep(prior.key, key) ? prior : { key, count: 0 }
    if (state.count >= maxRetries) {
      ctx.logger.warn(
        `first-chunk idle timeout persisted after ${maxRetries} compactions; ending the turn`,
      )
      return undefined
    }
    counters.set(agent, state)

    const generation = agent.session.surface.replaceGeneration
    try {
      await compaction.compactIfNeeded(agent, 'context-overflow', signal)
    } catch (recoveryError: unknown) {
      const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
      if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
        ctx.logger.warn(
          `first-chunk compaction failed after durable surface progress: ${message}; `
          + 'retrying from the replacement surface',
        )
        state.count += 1
        return { kind: 'retry' }
      }
      ctx.logger.warn(`first-chunk compaction failed: ${message}; ending the turn`)
      return undefined
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
    if (signal.aborted) return next()
    if (agent.session.surface.replaceGeneration <= generation) {
      ctx.logger.warn('first-chunk idle timeout: compaction made no durable progress; ending the turn')
      return undefined
    }
    state.count += 1
    ctx.logger.info('first-chunk idle timeout: compacted context; retrying the request')
    return { kind: 'retry' }
  }

  return {
    listener,
    dispose: () => {
      onIdle()
      counters.clear()
    },
  }
}
