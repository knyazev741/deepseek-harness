/**
 * Wire-safe approval identifiers and outcome vocabulary, free of
 * cordis/service imports so browser type chains (apiproxy api → client) can
 * consume them without loading this package's Context augmentation.
 * @module @deepseek-ai/dsh-user-approval/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session'

/**
 * Pairs one `approval/asked` audit event with its `approval/decided`.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>

/**
 * Brand a string as an {@link ApprovalRequestId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
export function ApprovalRequestId(id: string): ApprovalRequestId {
  return id as ApprovalRequestId
}

/** Opaque id assigned to one external tool call and its durable result. */
export type ExternalToolCallId = Branded<'ExternalToolCallId'>

/** Opaque external execution principal id carried by the audit bracket. */
export type ExternalToolPrincipalId = Branded<'ExternalToolPrincipalId'>

/** Durable external approval question; paired by `id`, principal, session, and call id. */
export interface ExternalApprovalAskedData {
  readonly id: ApprovalRequestId
  readonly principalId: ExternalToolPrincipalId
  readonly sessionId: SessionId
  readonly callId: ExternalToolCallId
  readonly toolName: string
  readonly reason?: string
}

/** Durable external approval outcome; paired with one asked event. */
export interface ExternalApprovalDecidedData {
  readonly id: ApprovalRequestId
  readonly principalId: ExternalToolPrincipalId
  readonly sessionId: SessionId
  readonly callId: ExternalToolCallId
  readonly outcome: ApprovalOutcome
}

/** A bounded JSON value used by external recorder contracts. */
export type ExternalApprovalJson = JsonValue

/**
 * Closed approval outcomes: a one-shot grant, explicit rejection, withdrawn
 * request, or unavailable answerer. Callers fail closed on `unavailable`.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
