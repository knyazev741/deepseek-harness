/* eslint-disable @stylistic/max-len */
import type { HostObservable } from '@knyazevai/dsh-client-ui-slots'
import type { SessionSummary } from '@knyazevai/dsh-api-session-controller/client'
import type { WorkspaceView } from '@knyazevai/dsh-api-workspace-controller/client'
/** Data shared by Workspace Session row contributions. */
export interface WorkspaceSessionRowContext { readonly session: SessionSummary; readonly workspace: WorkspaceView; readonly selected: boolean }
/** Menu-specific row context supplied to action contributions. */
export interface WorkspaceSessionRowMenuContext extends WorkspaceSessionRowContext { readonly closeMenu: () => void }
/** A filter tab contributed to the Workspace browser. */
export interface WorkspaceListView { readonly id: string; readonly order: number; readonly label: string; include(context: WorkspaceSessionRowContext): boolean }
/** Comparator and optional top-section promotion contributed to every active Workspace browser view. */
export interface WorkspaceListPolicy {
  readonly id: string
  readonly order: number
  compare(left: WorkspaceSessionRowContext, right: WorkspaceSessionRowContext): number
  /** Return true to place this session in the shared promoted section above Workspace groups. */
  promote?(context: WorkspaceSessionRowContext): boolean
}
/** Client service for registering Workspace browser filters, ordering, and row slots. */
export interface WorkspaceContributions {
  /** Register a view for the lifetime of the returned disposer.
   * @param view - Unique view definition.
   * @returns Disposer that removes this view.
   */
  registerView(view: WorkspaceListView): () => void
  /** Register a list policy for the lifetime of the returned disposer.
   * @param policy - Unique ordering or filtering policy.
   * @returns Disposer that removes this policy.
   */
  registerPolicy(policy: WorkspaceListPolicy): () => void
  readonly views: HostObservable<readonly WorkspaceListView[]>
  readonly policies: HostObservable<readonly WorkspaceListPolicy[]>
}
