/**
 * The external-agent session event vocabulary and its transcript projection.
 *
 * External console agents (Codex, ACP clients) are driven by a host bridge
 * (the `packages/external` family) that writes their activity into the owning
 * session's durable log as standalone log-only `external/*` events. The host
 * stamps the envelope's `ignorable: true`, so a harness build that predates
 * this vocabulary skips them on read instead of refusing the log. Live
 * transcript deltas travel the frame channel and are NEVER logged.
 *
 * The projection unit folds these events into the transcript-shaped
 * `external/transcript` value served through the session-projection seam
 * (registry snapshot, change feed, and persisted cache), reproducing the
 * committed exchange — messages, tool activity, permission asks/decisions,
 * compaction notices, model switches, and stop reasons — so replay and client
 * rendering never re-walk the raw log.
 *
 * @module @deepseek-ai/dsh-session-projection/external-transcript
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  ExternalToolCallId,
  ExternalProviderThreadId,
  parseExternalProviderThreadId,
  type ExternalProviderThreadId as ExternalProviderThreadIdValue,
} from '@deepseek-ai/dsh-external-session'
import type { ExternalToolError, ExternalToolResultData } from '@deepseek-ai/dsh-external-session'
// Type-only import: erased at runtime, so the index → external-transcript value
// edge stays acyclic even though external-transcript names index's type.
import type { ProjectionDefinition } from './index.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A live external agent session opened on `provider` in `cwd`, optionally
     * starting on `model`, with the provider-owned thread identity returned by
     * a successful thread start. Log-only `ignorable: true`; not a
     * `SurfaceEventType`. Standalone: the bridge appends it before any turn.
     */
    'external/session-started': ExternalSessionStartedData
    /**
     * One external turn opened, identified by the provider-issued `turnId`.
     * Log-only `ignorable: true`; not a `SurfaceEventType`.
     */
    'external/turn-started': ExternalTurnStartedData
    /**
     * One committed message in turn `turnId` — committed units only, never a
     * live delta. Log-only `ignorable: true`; not a `SurfaceEventType`.
     */
    'external/message-added': ExternalMessageAddedData
    /**
     * One tool activity (call, update, or result) in turn `turnId`. Log-only
     * `ignorable: true`; not a `SurfaceEventType`.
     */
    'external/tool-activity': ExternalToolActivityData
    /**
     * A permission question posed to the human. `askId` pairs it with the
     * `external/permission-decided` that follows. Log-only `ignorable: true`;
     * not a `SurfaceEventType`.
     */
    'external/permission-asked': ExternalPermissionAskedData
    /**
     * The outcome of a prior `external/permission-asked` with the same
     * `askId`. Log-only `ignorable: true`; not a `SurfaceEventType`.
     */
    'external/permission-decided': ExternalPermissionDecidedData
    /**
     * The external session switched its live model to `model`. Log-only
     * `ignorable: true`; not a `SurfaceEventType`.
     */
    'external/model-switched': ExternalModelSwitchedData
    /**
     * The external agent performed a compaction; `notice` is its human-visible
     * summary text. Log-only `ignorable: true`; not a `SurfaceEventType`.
     */
    'external/compaction-noticed': ExternalCompactionNoticedData
    /**
     * Turn `turnId` ended with a stop reason. Log-only `ignorable: true`; not
     * a `SurfaceEventType`.
     */
    'external/turn-ended': ExternalTurnEndedData
    /**
     * The external session ended with a stop reason. Log-only
     * `ignorable: true`; not a `SurfaceEventType`.
     */
    'external/session-ended': ExternalSessionEndedData
  }
}

/** The external event vocabulary's cross-turn stop reason for {@link ExternalTurnEndedData}. */
export type ExternalTurnStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens'
/** The settled outcome of an {@link ExternalPermissionAskedData}. */
export type ExternalPermissionOutcome = 'allowed' | 'rejected' | 'cancelled'
/** The agent role of a committed {@link ExternalMessageAddedData}. */
export type ExternalMessageRole = 'user' | 'agent'
/** A tool activity's phase in an external turn. */
export type ExternalToolActivityKind = 'call' | 'update' | 'result'

/** Opens one external session on a provider. */
export interface ExternalSessionStartedData {
  readonly provider: string
  readonly cwd: string
  readonly model?: string
  /** Opaque provider-owned thread identity used for an explicit cold resume. */
  readonly providerThreadId: ExternalProviderThreadIdValue
}
/** Opens one external turn, identified by the provider-issued id. */
export interface ExternalTurnStartedData {
  readonly turnId: string
}
/** One committed message in a turn — never a live delta. */
export interface ExternalMessageAddedData {
  readonly turnId: string
  readonly role: ExternalMessageRole
  readonly text: string
}
/** One tool activity in a turn. */
export interface ExternalToolActivityData {
  readonly turnId: string
  readonly kind: ExternalToolActivityKind
  readonly title: string
  readonly detail?: string
}
/** A permission question posed to the human. */
export interface ExternalPermissionAskedData {
  readonly askId: string
  readonly title: string
  readonly options: readonly string[]
}
/** The outcome of one prior permission ask. */
export interface ExternalPermissionDecidedData {
  readonly askId: string
  readonly outcome: ExternalPermissionOutcome
}
/** The external session switched models. */
export interface ExternalModelSwitchedData {
  readonly model: string
}
/** The external agent performed a compaction. */
export interface ExternalCompactionNoticedData {
  readonly notice: string
}
/** One external turn ended with a stop reason. */
export interface ExternalTurnEndedData {
  readonly turnId: string
  readonly stopReason: ExternalTurnStopReason
}
/** The external session ended. */
export interface ExternalSessionEndedData {
  readonly stopReason: string
}

/** One committed message in a transcript turn. */
export interface ExternalTranscriptMessage {
  readonly role: ExternalMessageRole
  readonly text: string
}
/** One tool activity in a transcript turn. */
export interface ExternalTranscriptToolActivity {
  readonly kind: ExternalToolActivityKind
  readonly title: string
  readonly detail?: string
}
/** One paired external tool call and committed result in a transcript turn. */
export interface ExternalTranscriptToolCall {
  /** Opaque call/result pairing identity. */
  readonly callId: ExternalToolCallId
  /** Registered Harness tool name. */
  readonly name: string
  /** Detached JSON arguments presented to the tool. */
  readonly arguments: import('@deepseek-ai/dsh-session').JsonValue
  /** Detached JSON result for a successful call. */
  readonly result?: import('@deepseek-ai/dsh-session').JsonValue
  /** Explicit failure facts for a failed call. */
  readonly error?: ExternalToolError
}
/** One permission ask in a transcript turn; `outcome` fills when decided. */
export interface ExternalTranscriptPermission {
  readonly askId: string
  readonly title: string
  readonly options: readonly string[]
  readonly outcome?: ExternalPermissionOutcome
}
/** One completed external turn in transcript order. */
export interface ExternalTranscriptTurn {
  readonly turnId: string
  readonly messages: readonly ExternalTranscriptMessage[]
  readonly toolActivities: readonly ExternalTranscriptToolActivity[]
  readonly toolCalls: readonly ExternalTranscriptToolCall[]
  readonly permissions: readonly ExternalTranscriptPermission[]
  readonly compactionNotices: readonly string[]
  readonly modelSwitches: readonly string[]
  readonly stopReason?: ExternalTurnStopReason
}
/** The whole external-session transcript projection. */
export interface ExternalTranscriptProjection {
  readonly provider: string
  readonly cwd: string
  /** Opaque provider identity retained for host attachment; transcript renderers ignore it. */
  readonly providerThreadId?: ExternalProviderThreadIdValue
  /** The current model, once started on or switched to one. */
  readonly sessionModel?: string
  readonly turns: readonly ExternalTranscriptTurn[]
  /** The session's end stop reason, once ended. */
  readonly stopReason?: string
}

/**
 * Fold state: the session facts plus closed turns in order and the in-progress
 * turn (emptied once ended). Plain JSON per the unit contract
 * (persisted-cache precondition).
 */
interface ExternalTranscriptState {
  provider: string | null
  cwd: string | null
  providerThreadId: ExternalProviderThreadIdValue | null
  sessionModel: string | null
  turns: ExternalTranscriptTurn[]
  open: ExternalTranscriptTurn | null
  stopReason: string | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** The transcript-shaped fold of a session's `external/*` events; see {@link ExternalTranscriptProjection}. */
    'external/transcript': ExternalTranscriptProjection
  }
}

const externalStopReasonSchema = z.enum(['completed', 'aborted', 'error', 'max-tokens'])
const permissionOutcomeSchema = z.enum(['allowed', 'rejected', 'cancelled'])
const messageSchema = z.object({
  role: z.enum(['user', 'agent']),
  text: z.string(),
}).strict()
const toolActivitySchema = z.object({
  kind: z.enum(['call', 'update', 'result']),
  title: z.string(),
  detail: z.string().optional(),
}).strict()
const toolErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
}).strict()
const toolCallSchema = z.object({
  callId: z.string().min(1).transform(ExternalToolCallId),
  name: z.string().min(1),
  arguments: z.json(),
  result: z.json().optional(),
  error: toolErrorSchema.optional(),
}).strict()
const permissionSchema = z.object({
  askId: z.string(),
  title: z.string(),
  options: z.array(z.string()),
  outcome: permissionOutcomeSchema.optional(),
}).strict()
const turnSchema = z.object({
  turnId: z.string(),
  messages: z.array(messageSchema),
  toolActivities: z.array(toolActivitySchema),
  toolCalls: z.array(toolCallSchema),
  permissions: z.array(permissionSchema),
  compactionNotices: z.array(z.string()),
  modelSwitches: z.array(z.string()),
  stopReason: externalStopReasonSchema.optional(),
}).strict()
const externalTranscriptSchema = z.object({
  provider: z.string(),
  cwd: z.string(),
  providerThreadId: z.string().min(1).transform(ExternalProviderThreadId).optional(),
  sessionModel: z.string().optional(),
  turns: z.array(turnSchema),
  stopReason: z.string().optional(),
}).strict()

/** The index of the LAST permission in `permissions` matching `askId`, or -1. */
function lastPermissionIndex(
  permissions: readonly ExternalTranscriptPermission[],
  askId: string,
): number {
  for (let index = permissions.length - 1; index >= 0; index -= 1) {
    const permission = permissions[index]
    if (permission !== undefined && permission.askId === askId) return index
  }
  return -1
}

/** Fill the outcome of a permission ask wherever it sits, open turn first, then closed turns newest-first. */
function decidePermission(
  state: ExternalTranscriptState,
  askId: string,
  outcome: ExternalPermissionOutcome,
): ExternalTranscriptState {
  const open = state.open
  if (open !== null) {
    const index = lastPermissionIndex(open.permissions, askId)
    const existing = index === -1 ? undefined : open.permissions[index]
    if (existing !== undefined) {
      const permissions = [...open.permissions]
      permissions[index] = { ...existing, outcome }
      return { ...state, open: { ...open, permissions } }
    }
  }
  for (let turnIndex = state.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = state.turns[turnIndex]
    if (turn === undefined) continue
    const index = lastPermissionIndex(turn.permissions, askId)
    const existing = index === -1 ? undefined : turn.permissions[index]
    if (existing !== undefined) {
      const turns = [...state.turns]
      const permissions = [...turn.permissions]
      permissions[index] = { ...existing, outcome }
      turns[turnIndex] = { ...turn, permissions }
      return { ...state, turns }
    }
  }
  return state
}

/** Find the newest tool call with one call id, optionally constrained to a turn. */
function findToolCall(
  state: ExternalTranscriptState,
  callId: ExternalToolCallId,
  turnId: string | undefined,
): { readonly location: 'open' | 'closed'; readonly turnIndex?: number; readonly callIndex: number } | undefined {
  if (state.open !== null && (turnId === undefined || state.open.turnId === turnId)) {
    for (let index = state.open.toolCalls.length - 1; index >= 0; index -= 1) {
      if (state.open.toolCalls[index]?.callId === callId) return { location: 'open', callIndex: index }
    }
  }
  for (let turnIndex = state.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = state.turns[turnIndex]
    if (turn === undefined || turnId !== undefined && turn.turnId !== turnId) continue
    for (let callIndex = turn.toolCalls.length - 1; callIndex >= 0; callIndex -= 1) {
      if (turn.toolCalls[callIndex]?.callId === callId) return { location: 'closed', turnIndex, callIndex }
    }
  }
  return undefined
}

/** Attach one committed result to its exact call node, preserving late results after turn close. */
function applyToolResult(state: ExternalTranscriptState, data: ExternalToolResultData): ExternalTranscriptState {
  const found = findToolCall(state, data.callId, data.turnId)
  if (found === undefined) return state
  if (found.location === 'open') {
    const open = state.open
    if (open === null) return state
    const toolCalls = [...open.toolCalls]
    const existing = toolCalls[found.callIndex]
    if (existing === undefined) return state
    if (data.isError) {
      toolCalls[found.callIndex] = { ...existing, error: data.error }
    } else {
      toolCalls[found.callIndex] = { ...existing, result: data.result }
    }
    return { ...state, open: { ...open, toolCalls } }
  }
  const turnIndex = found.turnIndex
  if (turnIndex === undefined) return state
  const turn = state.turns[turnIndex]
  if (turn === undefined) return state
  const turns = [...state.turns]
  const toolCalls = [...turn.toolCalls]
  const existing = toolCalls[found.callIndex]
  if (existing === undefined) return state
  if (data.isError) {
    toolCalls[found.callIndex] = { ...existing, error: data.error }
  } else {
    toolCalls[found.callIndex] = { ...existing, result: data.result }
  }
  turns[turnIndex] = { ...turn, toolCalls }
  return { ...state, turns }
}

/** Pure fold: `state` + one committed event → next state; unrelated events return the same reference (the Object.is gate). */
function apply(state: ExternalTranscriptState, event: SessionEvent): ExternalTranscriptState {
  switch (event.type) {
    case 'external/session-started':
      return {
        ...state,
        provider: event.data.provider,
        cwd: event.data.cwd,
        providerThreadId: parseExternalProviderThreadId(event.data.providerThreadId) ?? null,
        sessionModel: event.data.model ?? state.sessionModel,
      }
    case 'external/turn-started':
      return {
        ...state,
        open: {
          turnId: event.data.turnId,
          messages: [],
          toolActivities: [],
          toolCalls: [],
          permissions: [],
          compactionNotices: [],
          modelSwitches: [],
        },
      }
    case 'external/message-added': {
      const open = state.open
      if (open === null || open.turnId !== event.data.turnId) return state
      return {
        ...state,
        open: { ...open, messages: [...open.messages, { role: event.data.role, text: event.data.text }] },
      }
    }
    case 'external/tool-activity': {
      const open = state.open
      if (open === null || open.turnId !== event.data.turnId) return state
      return {
        ...state,
        open: {
          ...open,
          toolActivities: [
            ...open.toolActivities,
            {
              kind: event.data.kind,
              title: event.data.title,
              ...(event.data.detail === undefined ? {} : { detail: event.data.detail }),
            },
          ],
        },
      }
    }
    case 'external/tool-call': {
      const open = state.open
      if (open === null || event.data.turnId !== undefined && open.turnId !== event.data.turnId) return state
      return {
        ...state,
        open: {
          ...open,
          toolCalls: [
            ...open.toolCalls,
            {
              callId: event.data.callId,
              name: event.data.name,
              arguments: event.data.arguments,
            },
          ],
        },
      }
    }
    case 'external/tool-result':
      return applyToolResult(state, event.data)
    case 'external/permission-asked': {
      const open = state.open
      if (open === null) return state
      return {
        ...state,
        open: {
          ...open,
          permissions: [
            ...open.permissions,
            { askId: event.data.askId, title: event.data.title, options: [...event.data.options] },
          ],
        },
      }
    }
    case 'external/permission-decided':
      return decidePermission(state, event.data.askId, event.data.outcome)
    case 'external/model-switched':
      return {
        ...state,
        sessionModel: event.data.model,
        open: state.open === null
          ? state.open
          : { ...state.open, modelSwitches: [...state.open.modelSwitches, event.data.model] },
      }
    case 'external/compaction-noticed': {
      const open = state.open
      if (open === null) return state
      return { ...state, open: { ...open, compactionNotices: [...open.compactionNotices, event.data.notice] } }
    }
    case 'external/turn-ended': {
      const open = state.open
      if (open === null || open.turnId !== event.data.turnId) return state
      return {
        ...state,
        turns: [...state.turns, { ...open, stopReason: event.data.stopReason }],
        open: null,
      }
    }
    case 'external/session-ended':
      return { ...state, stopReason: event.data.stopReason }
    default:
      return state
  }
}

/** State → wire projection (the read-side value for the `external/transcript` key). */
function view(state: ExternalTranscriptState): ExternalTranscriptProjection {
  const turns: ExternalTranscriptTurn[] = state.open === null ? state.turns : [...state.turns, state.open]
  return {
    provider: state.provider === null ? '' : state.provider,
    cwd: state.cwd === null ? '' : state.cwd,
    turns,
    ...(state.providerThreadId === null ? {} : { providerThreadId: state.providerThreadId }),
    ...(state.sessionModel === null ? {} : { sessionModel: state.sessionModel }),
    ...(state.stopReason === null ? {} : { stopReason: state.stopReason }),
  }
}

/**
 * The transcript-shaped recount of a session's `external/*` events, registered
 * on `ctx.sessionProjections` by a host plugin. Guards every boundary on the
 * untyped pointer keys it can be hostile to (prototype names): the fold reads
 * only its own declared events, so an unrelated or unknown event returns the
 * same state reference (zero downstream work), and the served value passes
 * {@link externalTranscriptSchema} before it leaves the registry.
 */
export const externalTranscriptProjectionDefinition:
ProjectionDefinition<'external/transcript', ExternalTranscriptState> = {
  key: 'external/transcript',
  // zod `.optional()` types the key `string | undefined` while the domain
  // says `sessionModel?/stopReason?/outcome?/…`; on the JSON wire the two
  // serialize identically (absent), so the cast records that
  // exactOptionalPropertyTypes widening (the permission-presets precedent).
  schema: externalTranscriptSchema as unknown as z.ZodType<ExternalTranscriptProjection>,
  init: () => ({
    provider: null,
    cwd: null,
    providerThreadId: null,
    sessionModel: null,
    turns: [],
    open: null,
    stopReason: null,
  }),
  apply,
  view,
  stateVersion: 3,
}
