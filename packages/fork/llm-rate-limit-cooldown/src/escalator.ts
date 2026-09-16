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
  if (!retryableCodes.includes(failure.code)) return next()
  // An unbounded or absent policy never exposes an exhausted budget to this
  // plugin: `always` is owned by dsh-llm-retry, and an unprepared route has
  // no bounded chain to escalate past.
  if (retryPolicy === undefined || retryPolicy.mode !== 'normal') return next()
  // oxlint-disable-next-line typescript/no-deprecated -- Existing fork history read retained during upstream migration.
  if (priorRetries(agent.session.snapshotEvents(), turn, step, provider) < retryPolicy.maxRetries) return next()

  const fusedSignal = AbortSignal.any([signal, lifetimeSignal])
  if (fusedSignal.aborted) return
  ctx.logger.info(
    `fork-llm-rate-limit-cooldown: provider "${provider}" still rate-limited after ${retryPolicy.maxRetries} retries; waiting ${cooldownMs}ms and retrying`,
  )
  if (!await cancellableDelay(cooldownMs, fusedSignal)) return
  ctx.logger.info(`fork-llm-rate-limit-cooldown: provider "${provider}" cooldown elapsed; retrying request`)
  return { kind: 'retry' }
}
