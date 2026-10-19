/** Runtime invariant companion for the GitHub Actions session-source marker. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@knyazevai/dsh-invariants'
import type { Session, SessionEvent } from '@knyazevai/dsh-session'

const PACKAGE_NAME = '@knyazevai/dsh-fork-session-source'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fork-session-source-invariant'

/** The invariant registry is required before this companion can register. */
export const inject = ['invariants']

/** Recognize current plugin records and the historical event name. */
function isSourceMarker(event: { readonly type: string }): boolean {
  return event.type === 'plugin:fork/session-source' || event.type === 'fork/session-source'
}

/** Whether an unknown event value is exactly the marker's durable payload. */
function hasLiteralPayload(event: { readonly data: unknown }): boolean {
  const rawData: unknown = event.data
  if (rawData === null || typeof rawData !== 'object' || Array.isArray(rawData)) return false
  const data = rawData as Record<string, unknown>
  return Object.keys(data).length === 1 && data.source === 'github-actions'
}

/** Validate one source marker's envelope and payload. */
function validateMarker(event: {
  readonly seq: number
  readonly data: unknown
  readonly ignorable?: boolean
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: unknown
}, fail: InvariantFailure): void {
  if (!hasLiteralPayload(event)) {
    fail(`session event ${event.seq} has a non-literal plugin:fork/session-source payload`)
  }
  if (event.ignorable !== true) {
    fail(`session event ${event.seq} plugin:fork/session-source marker is not ignorable`)
  }
  if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) {
    fail(`session event ${event.seq} plugin:fork/session-source marker carries surface metadata`)
  }
}

/** Validate every existing source marker in one session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  let markers = 0
  // oxlint-disable-next-line typescript/no-deprecated -- Existing fork history read retained during upstream migration.
  for (const event of session.snapshotEvents()) {
    if (!isSourceMarker(event)) continue
    markers += 1
    if (markers > 1) fail(`session ${String(session.id)} contains more than one plugin:fork/session-source marker`)
    validateMarker(event, fail)
  }
}

/** Install checks for existing sessions and synchronous future append candidates. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (!isSourceMarker(event)) return
    // oxlint-disable-next-line typescript/no-deprecated -- Existing fork history read retained during upstream migration.
    if (session.snapshotEvents().some(isSourceMarker)) {
      fail(`session ${String(session.id)} contains more than one plugin:fork/session-source marker`)
    }
    validateMarker(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the source-marker invariant companion.
 * @param ctx - context carrying the invariant registry.
 * @returns the installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
