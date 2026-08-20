/**
 * Execution identities shared by native agent calls and external tool calls.
 *
 * @module @deepseek-ai/dsh-tools/execution-subject
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { Session } from '@deepseek-ai/dsh-session'

/** Opaque identity assigned to one external tool caller. */
export type ExternalToolPrincipalId = Branded<'ExternalToolPrincipalId'>

/**
 * Brand one external caller id at the trusted composition boundary.
 * @param id - the caller-supplied opaque id.
 * @returns the same string carrying the external-principal brand.
 */
export function ExternalToolPrincipalId(id: string): ExternalToolPrincipalId {
  return id as ExternalToolPrincipalId
}

/**
 * Durable external tool-call recorder owned by the external-session consumer.
 * The tools runtime carries this capability through the execution identity but
 * does not call it; the external approval/recording layer owns its commit order.
 */
export interface ToolExecutionRecorder {
  /** Record one external call at its owning pipeline commit point. */
  readonly recordCall?: (call: unknown) => void | Promise<void>
  /** Record one external result at its owning pipeline commit point. */
  readonly recordResult?: (result: unknown) => void | Promise<void>
}

/** An external caller that has no native Agent lifecycle or native turn. */
export interface ExternalToolPrincipal {
  readonly kind: 'external'
  readonly id: ExternalToolPrincipalId
  readonly session: Session
  readonly ctx: Context
  readonly recorder: ToolExecutionRecorder
}

/** One identity that can own a tool execution. */
export type ToolExecutionSubject = Agent | ExternalToolPrincipal

/**
 * Input identity fields accepted by the tools runtime. The first branch keeps
 * existing agent-less diagnostic calls source-compatible; a supplied identity
 * is either a native Agent or an external principal, never both.
 */
export type ToolExecutionIdentity =
  | { readonly agent?: Agent; readonly principal?: never }
  | { readonly agent?: never; readonly principal: ExternalToolPrincipal }

/** The structural identity fields used by subject helpers. */
export interface ToolExecutionIdentityFields {
  readonly agent?: Agent
  readonly principal?: ExternalToolPrincipal
}

/**
 * Resolve the caller identity without creating or registering an Agent.
 * @param execution - the execution identity fields.
 * @returns the native Agent, external principal, or undefined for an agent-less call.
 */
export function executionSubject(execution: ToolExecutionIdentityFields): ToolExecutionSubject | undefined {
  if (execution.agent !== undefined && execution.principal !== undefined) {
    throw new TypeError('tool execution must provide exactly one of agent or principal')
  }
  return execution.principal ?? execution.agent
}

/**
 * Resolve the scope key used by scoped tool lookup and scoped waterfalls.
 * @param execution - the execution identity fields.
 * @returns the caller's scope key, or undefined for an agent-less call.
 */
export function executionScope(execution: ToolExecutionIdentityFields): ScopeKey | undefined {
  return executionSubject(execution)
}

/**
 * Resolve the durable session associated with a tool call.
 * @param execution - the execution identity fields.
 * @returns the native or external session, or undefined for an agent-less call.
 */
export function executionSession(execution: ToolExecutionIdentityFields): Session | undefined {
  return executionSubject(execution)?.session
}

/**
 * Resolve the context owned by the caller's execution identity.
 * @param execution - the execution identity fields.
 * @returns the native agent context or external principal context.
 */
export function executionContext(execution: ToolExecutionIdentityFields): Context | undefined {
  return executionSubject(execution)?.ctx
}

/**
 * Resolve the native Agent only when one was explicitly supplied.
 * @param execution - the execution identity fields.
 * @returns the native Agent, or undefined for external and agent-less calls.
 */
export function executionAgent(execution: ToolExecutionIdentityFields): Agent | undefined {
  return execution.agent
}
