/**
 * Package-owned external-session registry and durable tool-pair invariants.
 * @module @deepseek-ai/dsh-external-session/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ExternalAgentDescriptor, ExternalModelDirectory } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-external-session'

/** Cordis companion plugin name. */
export const name = 'external-session-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** The closed set of {@link ExternalModelDirectory} values a descriptor may carry. */
const VALID_MODEL_DIRECTORIES: readonly ExternalModelDirectory[] = ['provider', 'config']

interface ExternalToolCallState {
  readonly name: string
  readonly turnId?: string
  settled: boolean
}

interface ExternalToolTrace {
  readonly calls: Map<string, ExternalToolCallState>
  ended: boolean
}

type ExternalToolTransition =
  | { readonly kind: 'call'; readonly callId: string; readonly call: ExternalToolCallState }
  | { readonly kind: 'result'; readonly callId: string }
  | { readonly kind: 'ended' }

/** Require the plain object used by a durable external tool record. */
function toolRecord(value: unknown, label: string, fail: InvariantFailure): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`external/${label} data must be a plain object`)
  }
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`external/${label} data must be a plain object`)
  }
  return value as Record<string, unknown>
}

/** Require a non-empty durable string field. */
function toolString(record: Record<string, unknown>, key: string, label: string, fail: InvariantFailure): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    fail(`external/${label} ${key} must be non-empty`)
  }
  return value
}

/** Validate an optional durable id field. */
function optionalToolString(record: Record<string, unknown>, key: string, label: string, fail: InvariantFailure): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    fail(`external/${label} ${key} must be non-empty when provided`)
  }
  return value
}

/** Require one detached JSON value in a durable record. */
function toolJson(value: unknown, label: string, fail: InvariantFailure): void {
  if (snapshotJsonValue(value) === undefined) fail(`external/${label} must be JSON-serializable`)
}

/** Validate explicit durable error facts. */
function toolError(value: unknown, fail: InvariantFailure): void {
  const error = toolRecord(value, 'tool-result error', fail)
  if (typeof error.message !== 'string' || error.message.length === 0) {
    fail('external/tool-result error message must be non-empty')
  }
  if (error.code !== undefined && (typeof error.code !== 'string' || error.code.length === 0)) {
    fail('external/tool-result error code must be non-empty when provided')
  }
}

/** Validate one durable external tool event against its session-owned pair index. */
function validateExternalToolEvent(
  trace: ExternalToolTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): ExternalToolTransition | undefined {
  const type = event.type as string
  if (type === 'external/session-ended') {
    if ([...trace.calls.values()].some(call => !call.settled)) {
      fail('external/session-ended has an external/tool-call without a matching result')
    }
    return { kind: 'ended' }
  }
  if (type !== 'external/tool-call' && type !== 'external/tool-result') return undefined
  if (trace.ended) fail(`external/${type.slice('external/'.length)} follows external/session-ended`)
  const label = type === 'external/tool-call' ? 'tool-call' : 'tool-result'
  const record = toolRecord(event.data, label, fail)
  const callId = toolString(record, 'callId', label, fail)
  const name = toolString(record, 'name', label, fail)
  const turnId = optionalToolString(record, 'turnId', label, fail)
  if (type === 'external/tool-call') {
    toolJson(record.arguments, 'tool-call arguments', fail)
    if (trace.calls.has(callId)) fail(`external/tool-call repeated callId ${JSON.stringify(callId)}`)
    return { kind: 'call', callId, call: { name, ...turnId === undefined ? {} : { turnId }, settled: false } }
  }
  const isError = record.isError
  if (typeof isError !== 'boolean') fail('external/tool-result isError must be boolean')
  const hasResult = Object.hasOwn(record, 'result')
  const hasError = Object.hasOwn(record, 'error')
  if (isError && (!hasError || hasResult)) fail('external/tool-result must carry exactly one result form')
  if (!isError && (!hasResult || hasError)) fail('external/tool-result must carry exactly one result form')
  if (isError) toolError(record.error, fail)
  else toolJson(record.result, 'tool-result result', fail)
  const call = trace.calls.get(callId)
  if (call === undefined) {
    return fail(`external/tool-result has no matching external/tool-call for ${JSON.stringify(callId)}`)
  }
  if (call.settled) fail(`external/tool-result repeated callId ${JSON.stringify(callId)}`)
  if (call.name !== name) fail('external/tool-result name does not match external/tool-call')
  if (turnId !== undefined && call.turnId !== undefined && turnId !== call.turnId) {
    fail('external/tool-result turnId does not match external/tool-call')
  }
  return { kind: 'result', callId }
}

/** Apply a validated external tool transition to its session-owned index. */
function applyExternalToolTransition(trace: ExternalToolTrace, transition: ExternalToolTransition): void {
  if (transition.kind === 'call') trace.calls.set(transition.callId, transition.call)
  else if (transition.kind === 'result') {
    const call = trace.calls.get(transition.callId)
    if (call !== undefined) call.settled = true
  } else trace.ended = true
}

/**
 * Install provider-registry and session-owned durable tool-pair checks. The
 * registry-to-descriptor relation (the source of every start's provider) is
 * asserted from the `external/provider-added` / `external/provider-removed`
 * pair: an added descriptor is well-formed and uniquely registered, and a
 * removal names a listed provider, while each session-owned
 * `external/tool-call` receives exactly one matching result before
 * `external/session-ended`. Session start enforcement (a started session's
 * provider is always a listed descriptor) lives at the
 * {@link ExternalSessions.start} admission boundary, which fails loud for an
 * unlisted provider before any bridge is handed.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const providers = new Set(ctx.externalSessions.list())
  const stagedAdds = new Map<string, ExternalAgentDescriptor>()
  const stagedRemovals = new Set<string>()
  const traces = new WeakMap<Session, ExternalToolTrace>()
  const stagedTools = new WeakMap<SessionEvent, { session: Session; transition: ExternalToolTransition }>()
  const seed = (session: Session): ExternalToolTrace => {
    const trace: ExternalToolTrace = { calls: new Map(), ended: false }
    traces.set(session, trace)
    for (const event of session.events) {
      const transition = validateExternalToolEvent(trace, event, fail)
      if (transition !== undefined) applyExternalToolTransition(trace, transition)
    }
    return trace
  }
  const traceFor = (session: Session): ExternalToolTrace => traces.get(session) ?? seed(session)

  for (const session of ctx.get('sessions')?.list() ?? []) seed(session)

  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName === 'external/provider-added') {
      const descriptor = args[0] as ExternalAgentDescriptor
      if (descriptor.provider.length === 0 || descriptor.label.length === 0) {
        fail('external provider names and labels must be non-empty')
      }
      if (!VALID_MODEL_DIRECTORIES.includes(descriptor.modelDirectory)) {
        fail(`external provider "${descriptor.provider}" has unknown modelDirectory ${JSON.stringify(descriptor.modelDirectory)}`)
      }
      if (providers.has(descriptor.provider)) {
        fail(`external/provider-added repeated ${JSON.stringify(descriptor.provider)}`)
      }
      stagedAdds.set(descriptor.provider, descriptor)
      return
    }
    if (eventName === 'external/provider-removed') {
      const provider = args[0] as string
      if (!providers.has(provider)) {
        fail(`external/provider-removed names unknown provider ${JSON.stringify(provider)}`)
      }
      stagedRemovals.add(provider)
      return
    }
    if (eventName === 'session/event') {
      const [session, event] = args as [Session, SessionEvent]
      const transition = validateExternalToolEvent(traceFor(session), event, fail)
      if (transition !== undefined) stagedTools.set(event, { session, transition })
    }
  }, { global: true })

  ctx.on('session/event', (session, event) => {
    const candidate = stagedTools.get(event)
    /* v8 ignore next -- internal/dispatch stages every package-owned tool event */
    if (candidate === undefined || candidate.session !== session) return
    stagedTools.delete(event)
    applyExternalToolTransition(traceFor(session), candidate.transition)
  }, { global: true })

  ctx.on('external/provider-added', (descriptor) => {
    /* v8 ignore next -- internal/dispatch stages the same descriptor object */
    if (!stagedAdds.delete(descriptor.provider)) return
    providers.add(descriptor.provider)
  }, { global: true })
  ctx.on('external/provider-removed', (provider) => {
    /* v8 ignore next -- internal/dispatch stages the same provider name */
    if (!stagedRemovals.delete(provider)) return
    providers.delete(provider)
  }, { global: true })
}, { inject: ['externalSessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
