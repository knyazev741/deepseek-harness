import type { HostObservable } from '@knyazevai/dsh-client-ui-slots'
import type { SessionId } from '@knyazevai/dsh-session/types'
import type { SessionSummary } from '@knyazevai/dsh-api-session-controller/client'
import type { ForkWorkspaceSessionStateView } from '@knyazevai/dsh-fork-workspace-session-state/types'

/** Versioned browser key for read watermarks. Server pin state never uses this key. */
export const READ_WATERMARKS_STORAGE_KEY = 'dsh.fork.workspaceReadWatermarks.v1'

/** Immutable state published to the row actions and ordering policy. */
export interface WorkspaceOverlaySnapshot {
  /** Browser-local last-read sequence per session id. */
  readonly readWatermarks: Readonly<Record<string, number>>
  /** Explicit Mark unread actions, including rows that are currently selected or running. */
  readonly manualUnread: Readonly<Record<string, true>>
  /** Last Host-accepted pin view, or undefined before the first remote read. */
  readonly pins: ForkWorkspaceSessionStateView | undefined
}

/** Store face used by the plugin and by the renderer's injected hooks. */
export interface WorkspaceOverlayStore extends HostObservable<WorkspaceOverlaySnapshot> {
  /** Mark a session unread immediately before its current last sequence. */
  markUnread(session: SessionSummary): void
  /** Mark a session read through its current last sequence. */
  markRead(session: SessionSummary): void
  /** Advance an already-open session through its visible sequence without clearing an explicit unread mark. */
  observeRead(session: SessionSummary): void
  /** Read the browser-local watermark for one session. */
  readWatermark(sessionId: SessionId): number | undefined
  /** Install a Host-accepted pin snapshot. */
  installPins(view: ForkWorkspaceSessionStateView): void
  /** Replace pin state from an authoritative Host refresh, including a post-restart revision reset. */
  replacePins(view: ForkWorkspaceSessionStateView): void
  /** Return whether the current Host-accepted snapshot contains the id. */
  isPinned(sessionId: SessionId): boolean
  /** Return the observed revision used by the next mutation. */
  observedPinRevision(): number
  /** Stop notifications and persistence writes after plugin disposal. */
  dispose(): void
}

/**
 * Read the host projection cut carried by a public session summary.
 *
 * This is a durable event sequence supplied by the generic projection seam;
 * it is intentionally distinct from the wall-clock `updatedAt` field and is
 * absent when the host has not supplied a projection cut.
 * @param session - public session summary.
 * @returns a finite non-negative projection sequence, or undefined.
 */
export function lastSequenceOf(session: SessionSummary): number | undefined {
  const sequence = session.projectionAsOfSeq
  return sequence !== undefined && Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : undefined
}

/**
 * Strictly parse the v1 local map. Any malformed entry invalidates the whole
 * browser-local payload so a partial or hostile value cannot influence read
 * state.
 * @param raw - localStorage value.
 * @returns a validated watermark map, or an empty map.
 */
export function parseReadWatermarks(raw: string | null): Readonly<Record<string, number>> {
  if (raw === null) return Object.freeze({})
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({})
    const entries = Object.entries(value as Record<string, unknown>)
    const result = Object.create(null) as Record<string, number>
    for (const [sessionId, watermark] of entries) {
      if (sessionId.length === 0 || typeof watermark !== 'number' || !Number.isSafeInteger(watermark) || watermark < 0) return Object.freeze({})
      result[sessionId] = watermark
    }
    return Object.freeze(result)
  } catch {
    return Object.freeze({})
  }
}

function readInitialWatermarks(): Readonly<Record<string, number>> {
  if (typeof localStorage === 'undefined') return Object.freeze({})
  try {
    return parseReadWatermarks(localStorage.getItem(READ_WATERMARKS_STORAGE_KEY))
  } catch {
    return Object.freeze({})
  }
}

function persistWatermarks(watermarks: Readonly<Record<string, number>>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(READ_WATERMARKS_STORAGE_KEY, JSON.stringify(watermarks))
  } catch {
    // Private browsing and quota failures leave the in-memory watermark valid.
  }
}

function immutableSnapshot(
  readWatermarks: Readonly<Record<string, number>>,
  manualUnread: Readonly<Record<string, true>>,
  pins: ForkWorkspaceSessionStateView | undefined,
): WorkspaceOverlaySnapshot {
  return Object.freeze({ readWatermarks, manualUnread, pins })
}

/**
 * Create the plugin-owned browser state store.
 * @returns an isolated store whose subscriptions and writes stop after dispose.
 */
export function createWorkspaceOverlayStore(): WorkspaceOverlayStore {
  let readWatermarks = readInitialWatermarks()
  let manualUnread: Readonly<Record<string, true>> = Object.freeze({})
  let pins: ForkWorkspaceSessionStateView | undefined
  let snapshot = immutableSnapshot(readWatermarks, manualUnread, pins)
  const listeners = new Set<() => void>()
  let disposed = false

  const publish = (): void => {
    snapshot = immutableSnapshot(readWatermarks, manualUnread, pins)
    for (const listener of [...listeners]) listener()
  }
  const writePins = (view: ForkWorkspaceSessionStateView): void => {
    pins = Object.freeze({
      revision: view.revision,
      pinnedSessionIds: Object.freeze([...view.pinnedSessionIds]),
    })
    publish()
  }
  const writeWatermark = (session: SessionSummary, watermark: number, monotonic: boolean): boolean => {
    if (disposed) return false
    const id = String(session.id)
    const current = readWatermarks[id]
    if (monotonic && current !== undefined && watermark < current) return false
    if (readWatermarks[id] === watermark) return false
    readWatermarks = Object.freeze({ ...readWatermarks, [id]: watermark })
    persistWatermarks(readWatermarks)
    return true
  }
  const writeManualUnread = (session: SessionSummary, unread: boolean): boolean => {
    if (disposed) return false
    const id = String(session.id)
    if (unread) {
      if (manualUnread[id] === true) return false
      manualUnread = Object.freeze({ ...manualUnread, [id]: true })
      return true
    }
    if (manualUnread[id] !== true) return false
    manualUnread = Object.freeze(Object.fromEntries(
      Object.entries(manualUnread).filter(([candidate]) => candidate !== id),
    ))
    return true
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    markUnread: (session) => {
      const sequence = lastSequenceOf(session)
      if (sequence === undefined) return
      const changedWatermark = writeWatermark(session, Math.max(0, sequence - 1), false)
      const changedManualUnread = writeManualUnread(session, true)
      if (changedWatermark || changedManualUnread) publish()
    },
    markRead: (session) => {
      const sequence = lastSequenceOf(session)
      if (sequence === undefined) return
      const changedWatermark = writeWatermark(session, sequence, true)
      const changedManualUnread = writeManualUnread(session, false)
      if (changedWatermark || changedManualUnread) publish()
    },
    observeRead: (session) => {
      const sequence = lastSequenceOf(session)
      if (sequence === undefined) return
      if (writeWatermark(session, sequence, true)) publish()
    },
    readWatermark: sessionId => readWatermarks[String(sessionId)],
    installPins: (view) => {
      if (disposed) return
      const current = pins
      if (current !== undefined) {
        if (view.revision < current.revision) return
        if (view.revision === current.revision) return
      }
      writePins(view)
    },
    replacePins: (view) => {
      if (disposed) return
      writePins(view)
    },
    isPinned: sessionId => pins?.pinnedSessionIds.includes(sessionId) ?? false,
    observedPinRevision: () => pins?.revision ?? 0,
    dispose: () => {
      disposed = true
      listeners.clear()
    },
  }
}
