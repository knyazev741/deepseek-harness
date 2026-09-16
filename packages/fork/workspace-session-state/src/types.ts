/** Client-safe request and result vocabulary for workspace session pins.
 * @module @knyazevai/dsh-fork-workspace-session-state/types
 */

import type { SessionId } from '@knyazevai/dsh-session/types'

/** Ordered global pin list and its Settings descriptor revision. */
export interface ForkWorkspaceSessionStateView {
  /** Monotonic revision of the raw Settings section used for this view. */
  readonly revision: number
  /** Session ids pinned in insertion order. */
  readonly pinnedSessionIds: readonly SessionId[]
}

/** Typed rejection returned when a mutation used an obsolete revision. */
export interface ForkWorkspaceSessionStateConflict {
  /** Stable business result code. */
  readonly code: 'revision-conflict'
  /** Current state that superseded the request's revision. */
  readonly current: ForkWorkspaceSessionStateView
}

/** Typed rejection returned when a session is absent from every workspace. */
export interface ForkWorkspaceSessionStateUnknownSession {
  /** Stable business result code. */
  readonly code: 'session-not-in-workspace'
  /** Session id that failed the workspace-membership admission check. */
  readonly sessionId: SessionId
}

/** Client request for one global pin-list mutation. */
export interface ForkWorkspaceSessionStateSetPinnedInput {
  /** Session id whose pin state is being changed. */
  readonly sessionId: SessionId
  /** Whether the session should be present in the pin list. */
  readonly pinned: boolean
  /** Settings descriptor revision observed by the caller. */
  readonly expectedRevision: number
}

/** Result of a pin-list mutation, with expected outcomes kept on the wire. */
export type ForkWorkspaceSessionStateSetResult =
  | { readonly ok: true; readonly value: ForkWorkspaceSessionStateView }
  | {
    readonly ok: false
    readonly error: ForkWorkspaceSessionStateConflict | ForkWorkspaceSessionStateUnknownSession
  }
