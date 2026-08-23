import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { ForkWorkspaceSessionStateView } from '@deepseek-ai/dsh-fork-workspace-session-state/types'

/** Versioned browser key for read watermarks. Server pin state never uses this key. */
export const READ_WATERMARKS_STORAGE_KEY = 'dsh.fork.workspaceReadWatermarks.v1'

/** Immutable state published to the row actions and ordering policy. */
export interface WorkspaceOverlaySnapshot {
  /** Browser-local last-read sequence per session id. */
  readonly readWatermarks: Readonly<Record<string, number>>
  /** Last Host-accepted pin view, or undefined before the first remote read. */
  readonly pins: ForkWorkspaceSessionStateView | undefined
}

/** Store face used by the plugin and by the renderer's injected hooks. */
export interface WorkspaceOverlayStore extends HostObservable<WorkspaceOverlaySnapshot> {
  /** Mark a session unread immediately before its current last sequence. */
  markUnread(session: SessionSummary): void
  /** Mark a session read through its current last sequence. */
  markRead(session: SessionSummary): void
  /** Read the browser-local watermark for one session. */
  readWatermark(sessionId: SessionId): number | undefined
  /** Install a Host-accepted pin snapshot. */
  installPins(view: ForkWorkspaceSessionStateView): void
  /** Return whether the current Host-accepted snapshot contains the id. */
  isPinned(sessionId: SessionId): boolean
  /** Return the observed revision used by the next mutation. */
  observedPinRevision(): number
  /** Stop notifications and persistence writes after plugin disposal. */
  dispose(): void
}

/**
 * Read the last sequence carried by a public session summary.
 *
 * The current public summary type does not require a sequence field, while
 * assembled clients may carry one from a projection adapter. The adapter is
 * therefore read structurally and falls back to `updatedAt`, which preserves
 * a monotonic browser-local watermark for summaries that have no sequence.
 * @param session - public session summary, possibly extended by an adapter.
 * @returns a finite non-negative sequence-like value.
 */
export function lastSequenceOf(session: SessionSummary): number {
  const candidate = (session as SessionSummary & { readonly lastSeq?: unknown }).lastSeq
  if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0) return candidate
  return Number.isSafeInteger(session.updatedAt) && session.updatedAt >= 0 ? session.updatedAt : 0
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
    const entries = Object.entries(value)
    const result: Record<string, number> = {}
    for (const [sessionId, watermark] of entries) {
      if (sessionId.length === 0 || !Number.isSafeInteger(watermark) || watermark < 0) return Object.freeze({})
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
  pins: ForkWorkspaceSessionStateView | undefined,
): WorkspaceOverlaySnapshot {
  return Object.freeze({ readWatermarks, pins })
}

/** Create the plugin-owned browser state store. */
export function createWorkspaceOverlayStore(): WorkspaceOverlayStore {
  let readWatermarks = readInitialWatermarks()
  let pins: ForkWorkspaceSessionStateView | undefined
  let snapshot = immutableSnapshot(readWatermarks, pins)
  const listeners = new Set<() => void>()
  let disposed = false

  const publish = (): void => {
    snapshot = immutableSnapshot(readWatermarks, pins)
    for (const listener of [...listeners]) listener()
  }
  const writeWatermark = (session: SessionSummary, watermark: number): void => {
    if (disposed) return
    const id = String(session.id)
    if (readWatermarks[id] === watermark) return
    readWatermarks = Object.freeze({ ...readWatermarks, [id]: watermark })
    persistWatermarks(readWatermarks)
    publish()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    markUnread: (session) => {
      writeWatermark(session, Math.max(0, lastSequenceOf(session) - 1))
    },
    markRead: (session) => {
      writeWatermark(session, lastSequenceOf(session))
    },
    readWatermark: sessionId => readWatermarks[String(sessionId)],
    installPins: (view) => {
      if (disposed) return
      pins = Object.freeze({
        revision: view.revision,
        pinnedSessionIds: Object.freeze([...view.pinnedSessionIds]),
      })
      publish()
    },
    isPinned: sessionId => pins?.pinnedSessionIds.includes(sessionId) ?? false,
    observedPinRevision: () => pins?.revision ?? 0,
    dispose: () => {
      disposed = true
      listeners.clear()
    },
  }
}
