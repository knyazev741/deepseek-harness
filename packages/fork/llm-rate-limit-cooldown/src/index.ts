/**
 * Fork-owned escalation for a provider that stays rate-limited after its
 * bounded `dsh-llm-retry` budget is exhausted: wait a long cooldown, then
 * return one retry action so the agent loop re-attempts the same request.
 *
 * The escalation is order-independent on the `agent/request-error` waterfall:
 * it claims only a normalized failure whose code matches and whose bounded
 * retry chain (`llm/retry` records) has already reached the provider's
 * `maxRetries`. Everything else delegates through `next()`, leaving fast
 * backoff and unbounded `always` policy ownership to `dsh-llm-retry`.
 *
 * @module @knyazevai/dsh-fork-llm-rate-limit-cooldown
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@knyazevai/dsh-timeout'
import { createEscalator } from './escalator.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fork-llm-rate-limit-cooldown'

/** The agent service whose `agent/request-error` waterfall this plugin extends. */
export const inject = ['agents']

/** Configuration for the long rate-limit cooldown escalation. */
export interface Config {
  /** Cooldown before one retry of an exhausted rate-limited request, in ms (default 600000). */
  readonly cooldownMs?: number
  /** Normalized failure codes that trigger escalation (default rate limit, 5xx, quota, timeout, transport, pi-ai catch-all). */
  readonly retryableCodes?: string[]
}

/** Default long cooldown before one post-budget retry. */
const DEFAULT_COOLDOWN_MS = 600_000

/**
 * Trigger codes observed on live sessions as transient provider/upstream falls:
 * `RATE_LIMIT` (HTTP 429), `SERVER` (upstream 5xx such as 502/503), `QUOTA`,
 * `TIMEOUT`, `TRANSPORT` (stream/connection truncation), and `PI_AI_ERROR` (the
 * pi-ai provider catch-all). `PI_AI_ERROR` is opt-in by default even though it
 * can also carry a non-transient `Cannot find module` environment error, per
 * deployment preference for aggressive provider-outage coverage.
 */
const DEFAULT_RETRYABLE_CODES = ['RATE_LIMIT', 'SERVER', 'QUOTA', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR']

/** Loader schema for {@link Config}. */
export const Config: z<Config> = z.object({
  cooldownMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_COOLDOWN_MS),
  retryableCodes: z.array(z.string().min(1)).default(DEFAULT_RETRYABLE_CODES),
})

/**
 * Install long-cooldown retry escalation after a provider's bounded retry budget.
 * @param ctx - plugin context that owns the listener and active waits.
 * @param config - cooldown configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const { lifetime, active, listener } = createEscalator(
    ctx,
    config.cooldownMs ?? DEFAULT_COOLDOWN_MS,
    config.retryableCodes ?? DEFAULT_RETRYABLE_CODES,
  )
  const disposeListener = ctx.on('agent/request-error', listener)
  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('fork-llm-rate-limit-cooldown plugin disposed'))
    await Promise.allSettled([...active])
  }, 'fork-llm-rate-limit-cooldown: abort and drain active cooldowns')
}
