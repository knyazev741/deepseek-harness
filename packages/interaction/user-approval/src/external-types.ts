/**
 * Server-side external approval request contracts. These values carry live
 * Cordis context and Session objects and therefore stay outside the wire-safe
 * `@deepseek-ai/dsh-user-approval/types` module consumed by browser API types.
 *
 * @module @deepseek-ai/dsh-user-approval/external-types
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ExternalToolCallId, ExternalToolPrincipalId } from './types.ts'

/** Optional lifecycle signal and recorder capabilities for one external ask. */
export interface ExternalApprovalRecorder {
  /** Optional owner lifecycle signal used to cancel an outstanding ask. */
  readonly signal?: AbortSignal
  /** Optional call commit capability carried by the shared external principal. */
  readonly recordCall?: (call: unknown) => void | Promise<void>
  /** Optional result commit capability carried by the shared external principal. */
  readonly recordResult?: (result: unknown) => void | Promise<void>
}

/**
 * The live external principal consumed by the approval seam. It is structural
 * so the user-approval package does not create a project-reference cycle back
 * through the tools runtime; `@deepseek-ai/dsh-tools` principals satisfy it.
 */
export interface ExternalApprovalPrincipal {
  readonly kind: 'external'
  readonly id: ExternalToolPrincipalId
  readonly session: Session
  readonly ctx: Context
  readonly recorder: ExternalApprovalRecorder
  /** Optional lifecycle signal supplied by the external-session owner. */
  readonly disposal?: AbortSignal
}

/**
 * Static carrier identity for the external approval event family. The runtime
 * receiver is still the ApprovalService; this phantom member keeps the
 * scoped-event generator's external routing key separate from native Agent
 * requests while preserving the service's Cordis filter.
 */
export interface ExternalApprovalEventCarrier {
  readonly __externalApprovalEventCarrier: never
}

/** External approval request routed through the principal's scoped context. */
export interface ExternalApprovalRequest {
  /** External execution identity; no native Agent is created. */
  readonly principal: ExternalApprovalPrincipal
  /** Tool name shown to the answerer and retained in the audit. */
  readonly toolName: string
  /** Exact external tool call being decided. */
  readonly callId: ExternalToolCallId
  /** Human-readable reason supplied by the external gateway. */
  readonly reason?: string
  /** Gateway cancellation signal. */
  readonly signal?: AbortSignal
}
