/** Settings-backed global pin list for workspace sessions.
 * @module @knyazevai/dsh-fork-workspace-session-state
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionId } from '@knyazevai/dsh-session'
import type { SessionId as SessionIdType } from '@knyazevai/dsh-session/types'
import {
  SettingsConflictError,
  type SettingsNamespace,
} from '@knyazevai/dsh-settings'
import type {} from '@knyazevai/dsh-workspace'
import { Remote, TypertRemoteService } from '@knyazevai/dsh-typert-protocol'
import type {
  ForkWorkspaceSessionStateConflict,
  ForkWorkspaceSessionStateSetPinnedInput,
  ForkWorkspaceSessionStateSetResult,
  ForkWorkspaceSessionStateUnknownSession,
  ForkWorkspaceSessionStateView,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Settings-backed global pin-list service. */
    forkWorkspaceSessionState: ForkWorkspaceSessionState
  }
}

/** Exact lowercase-kebab Settings namespace owned by this package. */
const SETTINGS_NAMESPACE = 'fork-workspace-session-state'

interface SettingsDescriptorView {
  readonly ns: SettingsNamespace
  readonly value: unknown
  readonly revision: number
}

interface StoredState {
  pins: {
    sessionIds: string[]
  }
}

const EMPTY_STORED_STATE: StoredState = { pins: { sessionIds: [] } }

/** Settings schema for the persisted pin list; revision remains provider-owned. */
const StoredStateSchema: z<StoredState> = z.object({
  pins: z.object({
    sessionIds: z.array(z.string()).default([]),
  }).default(EMPTY_STORED_STATE.pins),
})

/** Reject duplicate stored ids before a malformed relation reaches the service. */
function validateStoredState(value: StoredState): void {
  if (new Set(value.pins.sessionIds).size !== value.pins.sessionIds.length) {
    throw new TypeError('fork-workspace-session-state: pins.sessionIds must not contain duplicates')
  }
}

/** Copy the current descriptor into the public client-safe view. */
function viewFromDescriptor(descriptor: SettingsDescriptorView): ForkWorkspaceSessionStateView {
  const value = descriptor.value as StoredState
  return Object.freeze({
    revision: descriptor.revision,
    pinnedSessionIds: Object.freeze(value.pins.sessionIds.map(SessionId)),
  })
}

/** Build the typed stale-revision result. */
function conflict(current: ForkWorkspaceSessionStateView): {
  readonly ok: false
  readonly error: ForkWorkspaceSessionStateConflict
} {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code: 'revision-conflict' as const, current }),
  })
}

/** Build the typed new-pin admission result. */
function unknownSession(sessionId: SessionIdType): {
  readonly ok: false
  readonly error: ForkWorkspaceSessionStateUnknownSession
} {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code: 'session-not-in-workspace' as const, sessionId }),
  })
}

/** Build the successful mutation result. */
function success(value: ForkWorkspaceSessionStateView): {
  readonly ok: true
  readonly value: ForkWorkspaceSessionStateView
} {
  return Object.freeze({ ok: true as const, value })
}

/** Persisted global pin list with serialized mutations and a generated Remote face. */
export class ForkWorkspaceSessionState extends TypertRemoteService {
  static inject = ['settings', 'workspaceRegistry']

  private operationTail: Promise<void> = Promise.resolve()
  private stopped = false

  /**
   * Register the Settings namespace and an operation-drain disposer.
   * @param ctx - context carrying Settings and the authoritative workspace registry.
   */
  constructor(ctx: Context) {
    super(ctx, 'forkWorkspaceSessionState')
    const drain = async () => {
      this.stopped = true
      await this.operationTail
    }
    ctx.effect(function* () {
      const settingsScope = ctx.settings.register(SETTINGS_NAMESPACE, StoredStateSchema, { validate: validateStoredState })
      yield settingsScope.rawDispose
      yield drain
    }, 'fork-workspace-session-state.operations')
  }

  /**
   * Read the ordered pin list and the Settings descriptor revision.
   * @returns a detached view of the persisted pin list.
   */
  @Remote('list')
  list(): Promise<ForkWorkspaceSessionStateView> {
    return this.enqueue(() => this.readView())
  }

  /**
   * Set one session's global pin state with an optimistic Settings revision.
   * New pins for unknown sessions and revision races are returned as typed results because
   * thrown method errors become generic Remote `internal` failures.
   * @param input - session id, desired pin state, and observed Settings revision.
   * @returns the committed view or one expected business rejection.
   */
  @Remote('setPinned')
  setPinned(input: ForkWorkspaceSessionStateSetPinnedInput): Promise<ForkWorkspaceSessionStateSetResult> {
    return this.enqueue(async () => {
      const current = this.readView()
      if (input.expectedRevision !== current.revision) return conflict(current)
      const currentIds = [...current.pinnedSessionIds]
      const present = currentIds.includes(input.sessionId)
      if (present === input.pinned) return success(current)
      if (input.pinned && !this.isInWorkspace(input.sessionId)) return unknownSession(input.sessionId)

      const next = input.pinned
        ? [...currentIds, input.sessionId]
        : currentIds.filter(sessionId => sessionId !== input.sessionId)
      try {
        await this.ctx.settings.update(
          SETTINGS_NAMESPACE,
          { pins: { sessionIds: next.map(String) } },
          current.revision,
        )
      } catch (error: unknown) {
        if (!(error instanceof SettingsConflictError)) throw error
        return conflict(this.readView())
      }
      return success(this.readView())
    })
  }

  /** Read the registered namespace's current descriptor. */
  private readDescriptor(): SettingsDescriptorView {
    const descriptor = this.ctx.settings.describe().find(entry => entry.ns === SETTINGS_NAMESPACE)
    if (descriptor === undefined) {
      throw new Error(`settings namespace "${SETTINGS_NAMESPACE}" is not registered`)
    }
    return descriptor
  }

  /** Build a fresh view from the authoritative Settings descriptor. */
  private readView(): ForkWorkspaceSessionStateView {
    return viewFromDescriptor(this.readDescriptor())
  }

  /** Check current workspace membership when admitting a new pin. */
  private isInWorkspace(sessionId: SessionIdType): boolean {
    return this.ctx.workspaceRegistry.list().some(workspace => workspace.sessionIds.includes(sessionId))
  }

  /** Serialize list and mutation operations while settling each queue tail. */
  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('fork-workspace-session-state service is disposed'))
    const previous = this.operationTail
    const run = previous.then(operation)
    this.operationTail = run.then(() => undefined, () => undefined)
    return run
  }
}

export default ForkWorkspaceSessionState
