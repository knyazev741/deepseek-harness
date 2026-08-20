/** Package-owned invariant companion for `@deepseek-ai/dsh-mcp-gateway`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-gateway'

/** Cordis companion plugin name. */
export const name = 'mcp-gateway-invariant'
/** The invariant registry is required before package ownership is reserved. */
export const inject = ['invariants']

interface LeaseState {
  readonly sessionId: string
  readonly calls: Set<string>
}

interface DurableCallState {
  readonly sessionId: string
  resultCommitted: boolean
}

interface CallState {
  readonly route: string
  readonly sessionId: string
  durableCall: boolean
  durableResult: boolean
}

/** Find a live gateway lease belonging to one session. */
function leaseForSession(leases: ReadonlyMap<string, LeaseState>, sessionId: string): LeaseState | undefined {
  for (const lease of leases.values()) {
    if (lease.sessionId === sessionId) return lease
  }
  return undefined
}

/** Read an external recorder call id without trusting the event's static type. */
function eventCallId(event: SessionEvent): string {
  return String((event.data as { readonly callId: unknown }).callId)
}

/** Check route/call ownership and quiescent teardown from authoritative durable events. */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const leases = new Map<string, LeaseState>()
  const calls = new Map<string, CallState>()
  const durableCalls = new Map<string, DurableCallState>()

  ctx.on('session/event', (session, event: SessionEvent) => {
    if (event.type !== 'external/tool-call' && event.type !== 'external/tool-result') return
    const sessionId = String(session.id)
    if (leaseForSession(leases, sessionId) === undefined) return
    const callId = eventCallId(event)
    const call = calls.get(callId)
    const durable = durableCalls.get(callId)
    if (event.type === 'external/tool-call') {
      if (durable !== undefined) fail(`MCP gateway call ${JSON.stringify(callId)} committed more than one durable call`)
      durableCalls.set(callId, { sessionId, resultCommitted: false })
      if (call !== undefined) {
        if (call.sessionId !== sessionId) fail(`MCP gateway call ${JSON.stringify(callId)} changed session ownership`)
        call.durableCall = true
      }
      return
    }
    if (durable === undefined) {
      if (call !== undefined) fail(`MCP gateway call ${JSON.stringify(callId)} has no durable call before its result`)
      return
    }
    if (durable.sessionId !== sessionId) fail(`MCP gateway call ${JSON.stringify(callId)} changed session ownership`)
    if (durable.resultCommitted) fail(`MCP gateway call ${JSON.stringify(callId)} committed more than one durable result`)
    durable.resultCommitted = true
    if (call !== undefined) {
      if (call.sessionId !== sessionId) fail(`MCP gateway call ${JSON.stringify(callId)} changed session ownership`)
      call.durableResult = true
    }
  }, { global: true })

  ctx.on('mcp-gateway/lease-created', ({ route, sessionId }) => {
    if (leases.has(route)) fail(`MCP gateway lease ${JSON.stringify(route)} was created twice`)
    leases.set(route, { sessionId, calls: new Set() })
  }, { global: true })

  ctx.on('mcp-gateway/call-started', ({ route, callId, sessionId }) => {
    const lease = leases.get(route)
    if (lease === undefined) fail(`MCP gateway call ${JSON.stringify(callId)} has no live lease`)
    if (lease.sessionId !== sessionId) fail(`MCP gateway call ${JSON.stringify(callId)} belongs to another session`)
    if (lease.calls.has(callId) || calls.has(callId)) fail(`MCP gateway call ${JSON.stringify(callId)} started twice`)
    const durable = durableCalls.get(callId)
    if (durable !== undefined && durable.sessionId !== sessionId) {
      fail(`MCP gateway call ${JSON.stringify(callId)} changed session ownership`)
    }
    lease.calls.add(callId)
    calls.set(callId, {
      route,
      sessionId,
      durableCall: durable !== undefined,
      durableResult: durable?.resultCommitted === true,
    })
  }, { global: true })

  ctx.on('mcp-gateway/call-terminal', ({ route, callId, sessionId }) => {
    const lease = leases.get(route)
    const call = calls.get(callId)
    const durable = durableCalls.get(callId)
    const ownsCall = call !== undefined
      && call.route === route
      && call.sessionId === sessionId
      && call.durableCall
      && call.durableResult
      && durable?.sessionId === sessionId
      && durable.resultCommitted
    if (lease === undefined || lease.sessionId !== sessionId || !lease.calls.has(callId) || !ownsCall) {
      fail(`MCP gateway call ${JSON.stringify(callId)} has no exactly-once durable terminal event`)
    }
    lease.calls.delete(callId)
    calls.delete(callId)
    durableCalls.delete(callId)
  }, { global: true })

  ctx.on('mcp-gateway/lease-disposed', ({ route, sessionId }) => {
    const lease = leases.get(route)
    if (lease === undefined) fail(`MCP gateway lease ${JSON.stringify(route)} was disposed without creation`)
    if (lease.sessionId !== sessionId) fail(`MCP gateway lease ${JSON.stringify(route)} changed session ownership`)
    for (const callId of lease.calls) {
      const call = calls.get(callId)
      if (call?.durableCall !== true || !call.durableResult) {
        fail(`MCP gateway lease ${JSON.stringify(route)} disposed with an unpaired call`)
      }
      calls.delete(callId)
      durableCalls.delete(callId)
    }
    if (lease.calls.size > 0) fail(`MCP gateway lease ${JSON.stringify(route)} disposed with active calls`)
    for (const [callId, durable] of durableCalls) {
      if (durable.sessionId === sessionId && calls.get(callId) === undefined) {
        fail(`MCP gateway lease ${JSON.stringify(route)} disposed with an unannounced durable call`)
      }
    }
    leases.delete(route)
  }, { global: true })

  ctx.on('mcp-gateway/teardown-complete', () => {
    if (leases.size > 0 || calls.size > 0) fail('MCP gateway teardown completed with live leases or calls')
  }, { global: true })
}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
