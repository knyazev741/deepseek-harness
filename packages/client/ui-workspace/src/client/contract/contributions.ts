/* eslint-disable @stylistic/max-len */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionSummary, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
/** Data shared by Workspace Session row contributions. */
export interface WorkspaceSessionRowContext { readonly session: SessionSummary; readonly workspace: WorkspaceView; readonly selected: boolean }
/** A filter tab contributed to the Workspace browser. */
export interface WorkspaceListView { readonly id: string; readonly order: number; readonly label: string; include(context: WorkspaceSessionRowContext): boolean }
/** A comparator contributed to every active Workspace browser view. */
export interface WorkspaceListPolicy { readonly id: string; readonly order: number; compare(left: WorkspaceSessionRowContext, right: WorkspaceSessionRowContext): number }
/** Client service for registering Workspace browser filters, ordering, and row slots. */
export interface WorkspaceContributions { registerView(view: WorkspaceListView): () => void; registerPolicy(policy: WorkspaceListPolicy): () => void; readonly views: HostObservable<readonly WorkspaceListView[]>; readonly policies: HostObservable<readonly WorkspaceListPolicy[]> }
