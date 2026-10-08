import { randomUUID } from 'node:crypto'
import { RetryId } from '@knyazevai/dsh-llm-retry'
import { MAX_TIMER_DELAY_MS } from '@knyazevai/dsh-timeout'
import type { Context, Events } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@knyazevai/dsh-session'
import type { RequestErrorAction } from '@knyazevai/dsh-agent'
import type {} from '@knyazevai/dsh-llm-retry/types'

/**
 * Wait a cancellable delay.
 * @param delayMs - wait length in milliseconds.
 * @param signal - abort input that short-circuits the wait.
 * @returns `true` when the delay elapsed first, `false` when the signal aborted.
 */
export function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
      clearTimeout(timer)
    }
    function onAbort(): void {
      cleanup()
      resolve(false)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve(true)
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Count the bounded retries already recorded for one open request step.
 * @param events - the session event log.
 * @param turn - the failing request's turn.
 * @param step - the failing request's step.
 * @param provider - the failing request's provider route.
 * @returns the number of `llm/retry` records scoped to this request.
 */
export function priorRetries(events: readonly SessionEvent[], turn: number, step: number, provider: string): number {
  return events.reduce((count, event) => count + (
    event.type === 'llm/retry' && event.data.turn === turn && event.data.step === step && event.data.provider === provider
      ? 1
      : 0
  ), 0)
}

/** The `agent/request-error` waterfall listener plus the state it owns. */
export interface EscalatorHandle {
  /** Abort controller that terminates this instance's listener and waits. */
  readonly lifetime: AbortController
  /** In-flight recovery operations awaiting their cooldown. */
  readonly active: Set<Promise<RequestErrorAction>>
  /** The registered `agent/request-error` waterfall listener. */
  readonly listener: (
    payload: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ) => Promise<RequestErrorAction>
}

/**
 * Build a rate-limit cooldown escalator for one installed plugin instance.
 * @param ctx - context whose logger reports the escalation steps.
 * @param cooldownMs - delay before one post-budget retry.
 * @param retryableCodes - normalized failure codes that trigger escalation.
 * @returns the listener and the per-instance state it owns.
 */
export function createEscalator(
  ctx: Context,
  cooldownMs: number,
  retryableCodes: readonly string[],
): EscalatorHandle {
  const lifetime = new AbortController()
  const active = new Set<Promise<RequestErrorAction>>()

  const listener: EscalatorHandle['listener'] = (
    payload,
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> => {
    // A stale waterfall callback captured before disposal must not enter
    // downstream recovery after the plugin is gone.
    if (lifetime.signal.aborted) return Promise.resolve<RequestErrorAction>(undefined)
    const operation = recover(ctx, lifetime.signal, cooldownMs, retryableCodes, payload, next)
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  return { lifetime, active, listener }
}

async function recover(
  ctx: Context,
  lifetimeSignal: AbortSignal,
  cooldownMs: number,
  retryableCodes: readonly string[],
  { agent, turn, step, provider, failure, retryPolicy, signal }: Parameters<Events['agent/request-error']>[0],
  next: () => Promise<RequestErrorAction>,
): Promise<RequestErrorAction> {
  if (!retryableCodes.includes('*') && !retryableCodes.includes(failure.code)) return next()
  if (retryPolicy === undefined || retryPolicy.mode !== 'normal') return next()
  const fusedSignal = AbortSignal.any([signal, lifetimeSignal])
  const aborted = (): boolean => fusedSignal.aborted
  if (aborted()) return
  // oxlint-disable-next-line typescript/no-deprecated -- Retry history is durable across cooldown attempts.
  const count = priorRetries(agent.session.snapshotEvents(), turn, step, provider)
  const retryAfter = failure.providerRetryAfterMs
  const providerDelay = retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0
  if (count < retryPolicy.maxRetries && retryPolicy.retryableCodes.includes(failure.code)
    && providerDelay <= retryPolicy.maxDelayMs) return next()

  // Compaction and other recovery owners get the first chance to repair the request.
  try {
    const action = await next()
    if (action?.kind === 'retry') return aborted() ? undefined : action
  } catch (error: unknown) {
    ctx.logger.warn('fork cooldown: downstream recovery failed; retaining the request: %o', error)
  }
  if (aborted()) return
  const delayMs = Math.max(cooldownMs, providerDelay)
  const policyKey = JSON.stringify(['fork-cooldown', cooldownMs, retryableCodes])
  // oxlint-disable-next-line typescript/no-deprecated -- Reuse the persisted identity of this policy chain.
  const previous = agent.session.snapshotEvents().findLast(event => event.type === 'llm/retry'
    && event.data.turn === turn && event.data.step === step
    && event.data.provider === provider && event.data.policyKey === policyKey)
  const prior = previous?.type === 'llm/retry' ? previous.data : undefined
  const retry = (prior?.retry ?? 0) + 1
  const retryId = prior?.retryId ?? RetryId(randomUUID())
  agent.session.append('llm/retry', {
    retryId, turn, step, provider, mode: 'always',
    policyKey, retry, delayMs, failure,
  })
  ctx.logger.info(`fork cooldown: provider "${provider}" failed with ${failure.code}; waiting ${delayMs}ms before retry ${retry}`)
  // Node clamps oversized timers to 1ms; split long provider waits without truncating them.
  let remaining = delayMs
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_TIMER_DELAY_MS)
    if (!await cancellableDelay(chunk, fusedSignal)) return
    remaining -= chunk
  }
  if (aborted()) return
  agent.session.append('llm/retry-started', { retryId, turn, step, retry })
  return { kind: 'retry' }
}
