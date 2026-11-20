/**
 * Cancellable cooldown retries for provider failures left unhandled by other
 * recovery listeners. Provider `always` policies retain their own backoff.
 * Durable retry events expose each scheduled wait to clients.
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

/** Configuration for provider failure cooldown retries. */
export interface Config {
  /** Cooldown before retrying an unhandled provider failure, in ms (default 600000). */
  readonly cooldownMs?: number
  /** Failure codes eligible for cooldown; `*` includes every normalized provider failure. */
  readonly retryableCodes?: string[]
}

/** Default delay before retrying an unhandled provider failure. */
const DEFAULT_COOLDOWN_MS = 600_000

/** Provider failure codes eligible for cooldown when no list is configured. */
const DEFAULT_RETRYABLE_CODES = ['RATE_LIMIT', 'SERVER', 'QUOTA', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR', 'STREAM_CLOSED', 'EMPTY_RESPONSE']

/** Loader schema for {@link Config}. */
export const Config: z<Config> = z.object({
  cooldownMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_COOLDOWN_MS),
  retryableCodes: z.array(z.string().min(1)).default(DEFAULT_RETRYABLE_CODES),
})

/**
 * Install cooldown retries for matching provider failures.
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
