/**
 * Opt-in wake scheduler. A profile configuration seeds a fallback interval,
 * and the agent itself sets, inspects, or cancels a durable per-session
 * schedule through `wake_schedule_set`, `wake_schedule_status`, and
 * `wake_schedule_cancel`. A due schedule initiates an ordinary turn in that
 * live session, without a user message and without a background job.
 * @module @knyazevai/dsh-wake-scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@knyazevai/dsh-agent'
import { resolveIntervalMs } from './scheduling.ts'
import type { WakeSchedule } from './scheduling.ts'
import { wakeDomainSpec } from './persistence.ts'
import { WakeScheduler } from './runtime.ts'
import { registerWakeTools } from './tools.ts'

/** Cordis function-plugin name used by loader diagnostics. */
export const name = 'wake-scheduler'
/** Agent registry, durable schedule form, and the tool registry the tools register into. */
export const inject = ['agents', 'storageDomain', 'tools']

/** Profile configuration for the wake scheduler. Invalid values fail plugin load. */
export interface Config {
  /** Whether the profile fallback schedule runs. Defaults to false; tool-set schedules work either way. */
  enabled?: boolean
  /** Fallback interval in whole minutes; required when enabled. */
  intervalMinutes?: number
  /** Fallback turn text; required and non-empty when enabled. */
  prompt?: string
  /** Session the fallback applies to. Omit to seed every root session created while the plugin is loaded. */
  sessionId?: string
  /** Fallback whole minutes from load to the first wake. Defaults to `intervalMinutes`. */
  startDelayMinutes?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  intervalMinutes: z.number().step(1).min(1),
  prompt: z.string(),
  sessionId: z.string(),
  startDelayMinutes: z.number().step(1).min(1),
})

/** Resolved profile fallback schedule. */
interface Fallback {
  /** Turn text the fallback presents. */
  readonly prompt: string
  /** Whole minutes between wakes. */
  readonly intervalMinutes: number
  /** Whole minutes from seeding to the first wake. */
  readonly startDelayMinutes: number
}

/**
 * Resolve the profile fallback, failing loud on a configuration it cannot run.
 * Runs before any storage is opened, so a misconfiguration has no side effect.
 * @param config - Validated plugin configuration.
 * @returns the resolved fallback, or undefined when the fallback is disabled.
 */
function resolveFallback(config: Config): Fallback | undefined {
  if (config.enabled !== true) return undefined
  if (config.intervalMinutes === undefined) {
    throw new Error('wake-scheduler: intervalMinutes is required when enabled')
  }
  const intervalMinutes = config.intervalMinutes
  resolveIntervalMs(intervalMinutes)
  const startDelayMinutes = config.startDelayMinutes ?? intervalMinutes
  resolveIntervalMs(startDelayMinutes)
  const prompt = (config.prompt ?? '').trim()
  if (prompt === '') throw new Error('wake-scheduler: prompt must be non-empty when enabled')
  return { prompt, intervalMinutes, startDelayMinutes }
}

/**
 * Install the wake scheduler and its three tools for root agents published
 * after load. The profile fallback seeds a schedule only for a session that
 * has no durable record yet, so a tool-set or cancelled record always wins.
 * @param ctx - Host context carrying the Agent registry, durable storage, and the tool registry.
 * @param config - Validated plugin configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const fallback = resolveFallback(config)
  const domain = await ctx.storageDomain.open(wakeDomainSpec)
  const store = domain.table('schedules')
  const scheduler = new WakeScheduler<Agent>({
    store,
    logger: ctx.logger,
    isLive: target => ctx.agents.get(target.id) === target && ctx.agents.roots().includes(target),
  })

  /** Seed the profile fallback once for a session without a durable record, then arm. */
  const armAgent = async (agent: Agent): Promise<void> => {
    if (store.get(agent.id) !== undefined) {
      scheduler.apply(agent)
      return
    }
    if (fallback === undefined) return
    if (config.sessionId !== undefined && config.sessionId !== agent.id) return
    const now = Date.now()
    const record: WakeSchedule = {
      status: 'active',
      source: 'config',
      prompt: fallback.prompt,
      intervalMinutes: fallback.intervalMinutes,
      startDelayMinutes: fallback.startDelayMinutes,
      lastRunAt: null,
      nextRunAt: now + fallback.startDelayMinutes * 60_000,
      runs: 0,
      skippedIntervals: 0,
      updatedAt: now,
    }
    try {
      await store.put(agent.id, record)
    } catch (error: unknown) {
      ctx.logger.warn(
        `wake-scheduler: fallback schedule write failed for session "${agent.id}": ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    scheduler.apply(agent)
  }

  ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (!ctx.agents.roots().includes(agent)) return
      agent.ctx.effect(() => {
        const disposeTools = registerWakeTools(agent.ctx, agent, {
          store,
          onScheduleChanged: () => { scheduler.apply(agent) },
        })
        void armAgent(agent)
        return () => {
          disposeTools()
          scheduler.disarm(agent.id)
        }
      }, 'wake-scheduler.agent()')
    })
    return () => {
      stopCreated()
      scheduler.dispose()
      void domain.close()
    }
  }, 'wake-scheduler.lifecycle()')
}
