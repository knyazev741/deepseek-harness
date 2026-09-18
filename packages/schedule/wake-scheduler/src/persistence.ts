/**
 * Durable per-session schedule storage over `ctx.storageDomain`. The domain
 * holds host-side operational state only: no session event type, no
 * model-visible surface of its own.
 * @module @knyazevai/dsh-wake-scheduler/persistence
 */

import { z as zod } from 'zod'
import { defineDomain, domainTable } from '@knyazevai/dsh-storage-domain'

/** Durable shape of one session schedule; rejects a partial or extra-field record at open. */
const scheduleSchema = zod.object({
  /** Active schedules fire; cancelled ones only suppress the profile fallback. */
  status: zod.enum(['active', 'cancelled']),
  /** Whether the agent set this schedule or the profile seeded it. */
  source: zod.enum(['tool', 'config']),
  /** Text of the turn this schedule initiates. */
  prompt: zod.string(),
  /** Whole minutes between wakes. */
  intervalMinutes: zod.number(),
  /** Whole minutes from creation to the first wake. */
  startDelayMinutes: zod.number(),
  /** Epoch milliseconds of the last dispatched wake, or null. */
  lastRunAt: zod.number().nullable(),
  /** Epoch milliseconds at which the next wake is due, or null once cancelled. */
  nextRunAt: zod.number().nullable(),
  /** Wakes dispatched since the schedule was set. */
  runs: zod.number(),
  /** Intervals collapsed by the most recent catch-up decision. */
  skippedIntervals: zod.number(),
  /** Epoch milliseconds of the last durable write. */
  updatedAt: zod.number(),
})

/** The `wake_scheduler` domain: one durable schedule per session id. */
export const wakeDomainSpec = defineDomain({
  name: 'wake_scheduler',
  version: 1,
  tables: { schedules: domainTable(scheduleSchema) },
})
