import type { ReactElement } from 'react'
import type { PropsRuntime, InjectFace, HostObservable } from '@knyazevai/dsh-client-ui-slots'
import { StateDot } from '@knyazevai/dsh-client-ui-primitives'
import type { WorkspaceOverlaySnapshot } from './store.ts'
import { lastSequenceOf } from './store.ts'

/** Business face injected into the left workspace-row status contribution. */
export interface WorkspaceRowStatusInjected {
  hooks: {
    overlay: HostObservable<WorkspaceOverlaySnapshot>
  }
}

/** Full props for the fork-owned unread status contribution. */
export type WorkspaceRowStatusProps =
  PropsRuntime<'workspace.session-row.status'>
  & InjectFace<WorkspaceRowStatusInjected>

/** Render the green completion dot for an unread, idle, non-selected session. */
export function WorkspaceRowStatus({ session, selected, useOverlay }: WorkspaceRowStatusProps): ReactElement | null {
  const sequence = lastSequenceOf(session)
  const unread = useOverlay((snapshot) => {
    if (snapshot.manualUnread[String(session.id)] === true) return true
    // A projection can advance during an active run, and the selected row is
    // already visible to the user. Neither state is an unread completion.
    if (session.running || selected) return false
    const watermark = snapshot.readWatermarks[String(session.id)]
    return sequence !== undefined && watermark !== undefined && watermark < sequence
  })
  return unread ? <StateDot state="done" /> : null
}
