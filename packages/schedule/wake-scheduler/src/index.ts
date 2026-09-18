/**
 * Opt-in wake scheduler: a profile-configured interval and prompt that
 * initiate a turn in matching live root sessions on their own, without a
 * user message and without a background job. Disabled unless the profile
 * enables it, and mounted through an ordinary patch overlay.
 * @module @knyazevai/dsh-wake-scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@knyazevai/dsh-agent'
import { defineDomain, domainTable } from '@knyazevai/dsh-storage-domain'
import { MIN_INTERVAL_MINUTES, resolveIntervalMs } from './scheduling.ts'
import { WakeScheduler } from './runtime.ts'

/** Cordis function-plugin name used by loader diagnostics. */
export const name = 'wake-scheduler'
/** The agent registry and the durable cursor form must exist before a wake can be armed. */
export const inject = ['agents', 'storageDomain']

/** Profile configuration for the wake scheduler. Invalid values fail plugin load. */
export interface Config {
  /** Whether the scheduler runs at all. Defaults to false; every other field is ignored while disabled. */
  enabled?: boolean
  /** Whole minutes between wakes; required when enabled. */
  intervalMinutes?: number
  /** Text of the turn this scheduler initiates; required and non-empty when enabled. */
  prompt?: string
  /** Session to schedule. Omit to schedule every root agent created while the scheduler is loaded. */
  sessionId?: string
  /** Whole minutes from load to the first wake when no cursor is stored. Defaults to `intervalMinutes`. */
  startDelayMinutes?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  intervalMinutes: z.number().step(1).min(MIN_INTERVAL_MINUTES),
  prompt: z.string(),
  sessionId: z.string(),
  startDelayMinutes: z.number().step(1).min(MIN_INTERVAL_MINUTES),
})

const cursorSchema = zod.object({
  /** Epoch milliseconds of the last dispatched wake. */
  lastRunAt: zod.number(),
  /** Epoch milliseconds at which the next wake is due. */
  nextRunAt: zod.number(),
  /** Wakes dispatched since the cursor was created. */
  runs: zod.number(),
})

/** Durable per-session cursor. The scheduler's only restart state. */
const wakeDomainSpec = defineDomain({
  name: 'wake_scheduler',
  version: 1,
  tables: { cursors: domainTable(cursorSchema) },
})

/**
 * Resolve the configured cadence, failing loud on a configuration the
 * scheduler cannot run. Only called when the scheduler is enabled.
 * @param config - Validated plugin configuration.
 * @returns the resolved interval and first-wake offset.
 */
function resolveCadence(config: Config): { intervalMs: number; startDelayMs: number } {
  if (config.intervalMinutes === undefined) {
    throw new Error('wake-scheduler: intervalMinutes is required when enabled')
  }
  const intervalMs = resolveIntervalMs(config.intervalMinutes)
  const startDelayMs = config.startDelayMinutes === undefined
    ? intervalMs
    : resolveIntervalMs(config.startDelayMinutes)
  return { intervalMs, startDelayMs }
}

/**
 * Install the wake scheduler for matching root agents published after load.
 * A disabled configuration is a no-op and opens no storage.
 * @param ctx - Host context carrying the Agent registry and durable storage.
 * @param config - Validated plugin configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.enabled !== true) return
  const cadence = resolveCadence(config)
  const prompt = (config.prompt ?? '').trim()
  if (prompt === '') throw new Error('wake-scheduler: prompt must be non-empty when enabled')

  const domain = await ctx.storageDomain.open(wakeDomainSpec)
  const scheduler = new WakeScheduler<Agent>({
    cadence,
    prompt,
    table: domain.table('cursors'),
    logger: ctx.logger,
    isLive: target => ctx.agents.get(target.id) === target && ctx.agents.roots().includes(target),
  })

  ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (config.sessionId !== undefined && agent.id !== config.sessionId) return
      if (!ctx.agents.roots().includes(agent)) return
      agent.ctx.effect(() => {
        scheduler.arm(agent)
        return () => { scheduler.disarm(agent.id) }
      }, 'wake-scheduler.agent()')
    })
    return () => {
      stopCreated()
      scheduler.dispose()
      void domain.close()
    }
  }, 'wake-scheduler.lifecycle()')
}
