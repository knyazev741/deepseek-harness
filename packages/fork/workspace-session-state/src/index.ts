/** Native Workspace pin adapter and legacy settings importer for workspace sessions.
 * @module @knyazevai/dsh-fork-workspace-session-state
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionId } from '@knyazevai/dsh-session'
import type { SessionId as SessionIdType } from '@knyazevai/dsh-session/types'
import {
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
    /** Native Workspace pin adapter. */
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
  /** Former settings-owned pin list. */
  pins: {
    /** Session identifiers in saved pin order. */
    sessionIds: string[]
  }
}

/** Live legacy pin settings imported into native Workspace persistence. */
interface LiveConfig {
  /** Legacy pin list; cleared after successful import. */
  pins: Volatile<StoredState['pins']>
}

const EMPTY_STORED_STATE: StoredState = { pins: { sessionIds: [] } }

/** Settings schema for the persisted pin list; revision remains provider-owned. */
const StoredStateSchema = z.object({
  pins: z.object({
    sessionIds: z.transform(z.array(z.string()), (ids) => {
      validateStoredState({ pins: { sessionIds: ids } })
      return ids
    }).default([]),
  }).default(EMPTY_STORED_STATE.pins).volatile(),
})

/** Reject duplicate stored ids before a malformed relation reaches the service. */
function validateStoredState(value: { pins: { readonly sessionIds: readonly string[] } }): void {
  if (new Set(value.pins.sessionIds).size !== value.pins.sessionIds.length) {
    throw new TypeError('fork-workspace-session-state: pins.sessionIds must not contain duplicates')
  }
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
  static Config = StoredStateSchema

  private operationTail: Promise<void> = Promise.resolve()
  private stopped = false
  private revision = 0
  private observedPins: readonly SessionIdType[] = []

  /**
   * Mount profile-backed pin state and drain mutations before disposal.
   * @param ctx - context carrying Settings and the authoritative workspace registry.
   * @param config - live profile configuration containing the persisted pin list.
   */
  constructor(ctx: Context, private readonly config: LiveConfig) {
    super(ctx, 'forkWorkspaceSessionState')
    validateStoredState({ pins: config.pins.get() })
    ctx.on('settings/document-updated', (ns) => {
      if (ns === SETTINGS_NAMESPACE) void this.enqueue(() => this.importPins()).catch(error => ctx.logger.warn(error))
    })
    const drain = async () => {
      this.stopped = true
      await this.operationTail
    }
    ctx.effect(() => drain, 'fork-workspace-session-state.operations')
  }

  /**
   * Read the ordered pin list and the process-local observed revision.
   * @returns a detached view of the persisted pin list.
   */
  @Remote('list')
  list(): Promise<ForkWorkspaceSessionStateView> {
    return this.enqueue(async () => { await this.importPins(); return this.readView() })
  }

  /**
   * Set one session's global pin state with an optimistic observed revision.
   * New pins for unknown sessions and revision races are returned as typed results because
   * thrown method errors become generic Remote `internal` failures.
   * @param input - session id, desired pin state, and observed revision.
   * @returns the committed view or one expected business rejection.
   */
  @Remote('setPinned')
  setPinned(input: ForkWorkspaceSessionStateSetPinnedInput): Promise<ForkWorkspaceSessionStateSetResult> {
    return this.enqueue(async () => {
      await this.importPins()
      const current = this.readView()
      if (input.expectedRevision !== current.revision) return conflict(current)
      const currentIds = [...current.pinnedSessionIds]
      const present = currentIds.includes(input.sessionId)
      if (present === input.pinned) return success(current)
      if (input.pinned && !this.isInWorkspace(input.sessionId)) return unknownSession(input.sessionId)

      if (input.pinned) await this.ctx.workspaceRegistry.pinSession(input.sessionId)
      else await this.ctx.workspaceRegistry.unpinSession(input.sessionId)
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

  /** Import the former fork pin list once; native Workspace persistence owns subsequent edits. */
  private async importPins(): Promise<void> {
    const ids = this.config.pins.get().sessionIds
    if (ids.length === 0) return
    const descriptor = this.readDescriptor()
    for (const id of [...ids].reverse().map(SessionId)) {
      if (this.isInWorkspace(id) && !this.ctx.workspaceRegistry.archivedSessionIds.includes(id)) {
        await this.ctx.workspaceRegistry.pinSession(id)
      }
    }
    await this.ctx.settings.update(SETTINGS_NAMESPACE, { pins: { sessionIds: [] } }, descriptor.revision)
  }

  /** Read the same pin set used by native Workspace actions. */
  private readView(): ForkWorkspaceSessionStateView {
    const pins = this.ctx.workspaceRegistry.pinnedSessionIds
    if (pins.length !== this.observedPins.length || pins.some((id, index) => id !== this.observedPins[index])) {
      this.observedPins = [...pins]
      this.revision++
    }
    return Object.freeze({ revision: this.revision, pinnedSessionIds: Object.freeze([...pins]) })
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
