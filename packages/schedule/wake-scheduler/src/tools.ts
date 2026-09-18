/**
 * Agent-scoped wake-schedule management tools. Each tool acts on the session
 * of the agent scope that owns it, so a call never carries a session id.
 * @module @knyazevai/dsh-wake-scheduler/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@knyazevai/dsh-agent'
import type { ContentBlock } from '@knyazevai/dsh-llm'
import { defineTool } from '@knyazevai/dsh-tools'
import type { GenericCallView } from '@knyazevai/dsh-tools'
import {
  DEFAULT_WAKE_PROMPT,
  MIN_INTERVAL_MINUTES,
  emptyStatusView,
  statusView,
} from './scheduling.ts'
import type { WakeSchedule, WakeStatusView } from './scheduling.ts'
import type { WakeStore } from './runtime.ts'

/** Failure code shape of every wake tool. */
interface WakeToolFailure {
  /** Stable machine code from the closed set below. */
  readonly code: 'invalid_interval' | 'invalid_prompt' | 'persistence_uncertain' | 'internal_error'
  /** Short explanation safe to show the model. */
  readonly message: string
}

/** Every value a wake tool can return. */
type WakeToolValue = WakeStatusView | WakeToolFailure

/** Model-facing text for a nullable string field. */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] } as const
/** Model-facing text for a nullable integer field. */
const NULLABLE_INTEGER = { oneOf: [{ type: 'integer' }, { type: 'null' }] } as const

/** Build one exact two-field error schema while preserving its literal code. */
function basicErrorSchema<const C extends WakeToolFailure['code']>(code: C) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: { type: 'string', required: true, const: code },
      message: { type: 'string', required: true },
    },
  } as const
}

const ERROR_SCHEMAS = [
  basicErrorSchema('invalid_interval'),
  basicErrorSchema('invalid_prompt'),
  basicErrorSchema('persistence_uncertain'),
  basicErrorSchema('internal_error'),
] as const

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scheduled: { type: 'boolean', required: true },
    status: { type: 'string', required: true, enum: ['active', 'cancelled', 'none'] },
    source: { oneOf: [{ type: 'string', enum: ['tool', 'config'] }, { type: 'null' }] },
    prompt: NULLABLE_STRING,
    intervalMinutes: NULLABLE_INTEGER,
    nextRunAt: NULLABLE_STRING,
    lastRunAt: NULLABLE_STRING,
    runs: { type: 'integer', required: true },
    overdue: { type: 'boolean', required: true },
    skippedIntervals: { type: 'integer', required: true },
  },
} as const

const STATUS_OUTPUT_SCHEMA = { oneOf: [STATUS_SCHEMA, ...ERROR_SCHEMAS] } as const

const SET_DESCRIPTION =
  'Set or replace the periodic wake-up schedule for THIS session. The session is taken from the call itself, so '
  + 'never pass a session id. After each interval the harness starts one ordinary turn in this conversation with the '
  + `supplied prompt, even while nobody is writing. interval_minutes is a whole number of minutes >= ${MIN_INTERVAL_MINUTES}. `
  + 'The schedule is durable: it survives a harness restart, and if this session was not open when a wake was due, the '
  + 'next load dispatches exactly one catch-up turn instead of a backlog. Inspect it with wake_schedule_status and stop '
  + 'it with wake_schedule_cancel.'

const STATUS_DESCRIPTION =
  'Report the wake-up schedule for THIS session: whether it is active, its prompt and interval, the next due instant, '
  + 'the last wake instant, how many wakes have fired, and whether one catch-up wake is currently queued because the '
  + 'session was not open when the schedule came due.'

const CANCEL_DESCRIPTION =
  'Stop the wake-up schedule for THIS session. This session stops receiving scheduled turns and no longer inherits any '
  + 'profile-configured fallback schedule; a later wake_schedule_set starts it again.'

/** Deterministic model content for every canonical wake value. */
function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Pure generic pending card. */
function present(title: string, kind: 'read' | 'other'): GenericCallView {
  return { card: 'generic', title, kind }
}

/** Stable failure for a caller that does not own this tool scope. */
function internalError(): WakeToolFailure {
  return { code: 'internal_error', message: 'This wake operation is not available in this session scope.' }
}

/** Stable failure for an unavailable durable medium. */
function persistenceError(): WakeToolFailure {
  return {
    code: 'persistence_uncertain',
    message: 'The wake schedule could not be stored; retry wake_schedule_set or wake_schedule_status.',
  }
}

/** Arguments accepted by `wake_schedule_set`. */
interface SetArguments {
  readonly interval_minutes: number
  readonly prompt?: string
  readonly start_delay_minutes?: number
}

/** Validate the units the open parameter root cannot express. */
function validateSetArguments(args: SetArguments): WakeToolFailure | undefined {
  if (!Number.isInteger(args.interval_minutes) || args.interval_minutes < MIN_INTERVAL_MINUTES) {
    return {
      code: 'invalid_interval',
      message: `interval_minutes must be a whole number of minutes >= ${MIN_INTERVAL_MINUTES}.`,
    }
  }
  if (args.start_delay_minutes !== undefined
    && (!Number.isInteger(args.start_delay_minutes) || args.start_delay_minutes < 0)) {
    return {
      code: 'invalid_interval',
      message: 'start_delay_minutes must be a whole number of minutes >= 0.',
    }
  }
  if (args.prompt !== undefined && args.prompt.trim().length === 0) {
    return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming when supplied.' }
  }
  return undefined
}

/** Options for {@link registerWakeTools}. */
export interface WakeToolOptions {
  /** Durable schedule storage shared with the live owner. */
  readonly store: WakeStore
  /** Called after every durable mutation so the live owner re-arms immediately. */
  readonly onScheduleChanged: () => void
}

/**
 * Register the three wake-schedule tools in one exact agent scope.
 * @param toolCtx - Exclusive agent-scoped context receiving the definitions.
 * @param agent - Exact live root agent whose session the tools mutate.
 * @param options - Durable store and the re-arm observer.
 * @returns Idempotent aggregate disposer for the three registrations.
 */
export function registerWakeTools(toolCtx: Context, agent: Agent, options: WakeToolOptions): () => void {
  const disposers: Array<() => void> = []
  try {
    disposers.push(toolCtx.tools.register(defineTool({
      name: 'wake_schedule_set',
      description: SET_DESCRIPTION,
      parameters: {
        interval_minutes: {
          type: 'number',
          required: true,
          description: `Whole minutes between wakes, at least ${MIN_INTERVAL_MINUTES}.`,
        },
        prompt: {
          type: 'string',
          description: 'Turn text presented at each wake; defaults to a generic check-in when omitted.',
        },
        start_delay_minutes: {
          type: 'number',
          description: 'Whole minutes from now to the first wake; defaults to interval_minutes. 0 fires the first wake immediately.',
        },
      },
      output: { schema: STATUS_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec): Promise<WakeToolValue> {
        if (exec.agent !== agent) return internalError()
        const invalid = validateSetArguments(args)
        if (invalid !== undefined) return invalid
        const startDelayMinutes = args.start_delay_minutes ?? args.interval_minutes
        const now = Date.now()
        const record: WakeSchedule = {
          status: 'active',
          source: 'tool',
          prompt: (args.prompt ?? DEFAULT_WAKE_PROMPT).trim(),
          intervalMinutes: args.interval_minutes,
          startDelayMinutes: startDelayMinutes,
          lastRunAt: null,
          nextRunAt: now + startDelayMinutes * 60_000,
          runs: 0,
          skippedIntervals: 0,
          updatedAt: now,
        }
        try {
          await options.store.put(agent.id, record)
        } catch {
          return persistenceError()
        }
        options.onScheduleChanged()
        return statusView(record, Date.now())
      },
      presentCall: () => present('Set wake schedule', 'other'),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'wake_schedule_status',
      description: STATUS_DESCRIPTION,
      parameters: {},
      output: { schema: STATUS_OUTPUT_SCHEMA, render: renderValue },
      execute(_args, exec): Promise<WakeToolValue> {
        if (exec.agent !== agent) return Promise.resolve(internalError())
        const record = options.store.get(agent.id)
        return Promise.resolve(record === undefined ? emptyStatusView() : statusView(record, Date.now()))
      },
      presentCall: () => present('Wake schedule status', 'read'),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'wake_schedule_cancel',
      description: CANCEL_DESCRIPTION,
      parameters: {},
      output: { schema: STATUS_OUTPUT_SCHEMA, render: renderValue },
      async execute(_args, exec): Promise<WakeToolValue> {
        if (exec.agent !== agent) return internalError()
        const previous = options.store.get(agent.id)
        const now = Date.now()
        const record: WakeSchedule = {
          status: 'cancelled',
          source: 'tool',
          prompt: previous?.prompt ?? '',
          intervalMinutes: previous?.intervalMinutes ?? 0,
          startDelayMinutes: previous?.startDelayMinutes ?? 0,
          lastRunAt: previous?.lastRunAt ?? null,
          nextRunAt: null,
          runs: previous?.runs ?? 0,
          skippedIntervals: previous?.skippedIntervals ?? 0,
          updatedAt: now,
        }
        try {
          await options.store.put(agent.id, record)
        } catch {
          return persistenceError()
        }
        options.onScheduleChanged()
        return statusView(record, now)
      },
      presentCall: () => present('Cancel wake schedule', 'other'),
    })))
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  let active = true
  return () => {
    if (!active) return
    active = false
    for (const dispose of disposers.reverse()) dispose()
  }
}
