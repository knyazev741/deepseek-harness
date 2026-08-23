import type { WorkspaceListView } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'

/** Read the fork-owned projection value without importing a private upstream type. */
function sessionSource(session: SessionSummary): unknown {
  return session.projectionValues?.forkSessionSource
}

/** Whether one summary belongs in the Background view. */
export function isBackgroundSession(session: SessionSummary): boolean {
  return session.running || sessionSource(session) === 'github-actions'
}

/** Build the contributed Background filter. */
export function createBackgroundView(t: TranslateNS<typeof NS>): WorkspaceListView {
  return {
    id: 'fork.background',
    order: 100,
    label: t('background'),
    include: ({ session }) => isBackgroundSession(session),
  }
}
