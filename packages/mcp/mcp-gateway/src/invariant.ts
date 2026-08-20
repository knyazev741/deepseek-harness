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
  readonly calls: Set<string>
}

interface CallState {
  readonly route: string
  durableResult: boolean
}

/** Check route/call ownership and quiescent teardown from the gateway event stream. */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const leases = new Map<string, LeaseState>()
  const calls = new Map<string, CallState>()
  ctx.on('session/event', (_session, event: SessionEvent) => {
    if (event.type !== 'external/tool-result') return
    const callId = String((event.data as { readonly callId: unknown }).callId)
    const call = calls.get(callId)
    if (call === undefined) return
    if (call.durableResult) fail(`MCP gateway call ${JSON.stringify(callId)} committed more than one durable result`)
    call.durableResult = true
  }, { global: true })
  ctx.on('mcp-gateway/lease-created', ({ route }) => {
    if (leases.has(route)) fail(`MCP gateway lease ${JSON.stringify(route)} was created twice`)
    leases.set(route, { calls: new Set() })
  }, { global: true })
  ctx.on('mcp-gateway/call-started', ({ route, callId }) => {
    const lease = leases.get(route)
    if (lease === undefined) fail(`MCP gateway call ${JSON.stringify(callId)} has no live lease`)
    if (lease.calls.has(callId)) fail(`MCP gateway call ${JSON.stringify(callId)} started twice`)
    lease.calls.add(callId)
    calls.set(callId, { route, durableResult: false })
  }, { global: true })
  ctx.on('mcp-gateway/call-terminal', ({ route, callId }) => {
    const lease = leases.get(route)
    const call = calls.get(callId)
    const ownsCall = call !== undefined && call.route === route && call.durableResult
    if (lease === undefined || !lease.calls.has(callId) || !ownsCall) {
      fail(`MCP gateway call ${JSON.stringify(callId)} has no exactly-once terminal event`)
    }
    lease.calls.delete(callId)
    calls.delete(callId)
  }, { global: true })
  ctx.on('mcp-gateway/lease-disposed', ({ route }) => {
    const lease = leases.get(route)
    if (lease === undefined) fail(`MCP gateway lease ${JSON.stringify(route)} was disposed without creation`)
    for (const callId of lease.calls) {
      const call = calls.get(callId)
      if (call?.durableResult !== true) fail(`MCP gateway lease ${JSON.stringify(route)} disposed with an unpaired call`)
      calls.delete(callId)
    }
    if (lease.calls.size > 0) fail(`MCP gateway lease ${JSON.stringify(route)} disposed with active calls`)
    leases.delete(route)
  }, { global: true })
  ctx.on('mcp-gateway/teardown-complete', () => {
    if (leases.size > 0) fail('MCP gateway teardown completed with live leases')
  }, { global: true })
}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
