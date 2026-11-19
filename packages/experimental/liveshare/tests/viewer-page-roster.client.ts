/**
 * Test-only client roster of the assembled viewer page.
 *
 * A served viewer page is the owner's own Web shell with the owner's client plugins; this roster is the
 * subset the viewer page specs need: the wire plugin, the Gateway, remote access, the Session/Workspace controllers,
 * Session status, the menu service, presentation plugins, and the Liveshare `./client` face, which mounts the viewer
 * surfaces when the carrier names a share. Every row is the package's own `/client` face registered as a module-table
 * factory. It must be imported only after {@link prepareViewerRemoteFaces} answered the generated
 * `/remote` faces these plugins import.
 *
 * @module @knyazevai/dsh-experimental-liveshare/tests/viewer-page-roster
 */

import * as apiGateway from '@knyazevai/dsh-api-gateway/client'
import * as apiRemoteAccess from '@knyazevai/dsh-api-remote-access/client'
import * as apiRemotes from '@knyazevai/dsh-api-remotes/client'
import * as apiSessionController from '@knyazevai/dsh-api-session-controller/client'
import * as apiWorkspaceController from '@knyazevai/dsh-api-workspace-controller/client'
import * as clientConnection from '@knyazevai/dsh-client-connection/client'
import * as clientFileUpload from '@knyazevai/dsh-client-file-upload/client'
import * as clientLocale from '@knyazevai/dsh-client-locale/client'
import * as clientModules from '@knyazevai/dsh-client-modules/client'
import * as clientResources from '@knyazevai/dsh-client-resources/client'
import * as clientShortcuts from '@knyazevai/dsh-client-shortcuts/client'
import * as uiAttachment from '@knyazevai/dsh-client-ui-attachment/client'
import * as uiChat from '@knyazevai/dsh-client-ui-chat/client'
import * as uiContextMenu from '@knyazevai/dsh-client-ui-context-menu/client'
import * as uiConversation from '@knyazevai/dsh-client-ui-conversation/client'
import * as uiDeliverables from '@knyazevai/dsh-client-ui-deliverables/client'
import * as uiFileDrag from '@knyazevai/dsh-client-ui-file-drag/client'
import * as uiLayout from '@knyazevai/dsh-client-ui-layout/client'
import * as uiRenderer from '@knyazevai/dsh-client-ui-renderer/client'
import * as uiSession from '@knyazevai/dsh-client-ui-session/client'
import * as uiSessionStatus from '@knyazevai/dsh-client-ui-session-status/client'
import * as uiSettings from '@knyazevai/dsh-client-ui-settings/client'
import * as uiSidebar from '@knyazevai/dsh-client-ui-sidebar/client'
import * as uiSidebarRight from '@knyazevai/dsh-client-ui-sidebar-right/client'
import * as uiTheme from '@knyazevai/dsh-client-ui-theme/client'
import * as uiTool from '@knyazevai/dsh-client-ui-tool/client'
import * as uiTrajectory from '@knyazevai/dsh-client-ui-trajectory/client'
import * as uiWorkspace from '@knyazevai/dsh-client-ui-workspace/client'
import * as typertRegistry from '@knyazevai/dsh-typert-registry/client'
import * as liveshare from '../src/client/index.ts'

/** One module-table row: the entry id the Loader creates, and that plugin's client exports. */
export interface ViewerPageRosterRow {
  readonly id: string
  readonly exports: Readonly<Record<string, unknown>>
}

/** Entry id of the module-system bootstrap whose exports the facade hands to the module system. */
export const VIEWER_PAGE_BOOTSTRAP_ID = '@knyazevai/dsh-client-modules'

/** The viewer page roster; Cordis composes these entries by service injection, so order is irrelevant. */
export const VIEWER_PAGE_ROSTER: readonly ViewerPageRosterRow[] = [
  { id: '@knyazevai/dsh-typert-registry', exports: typertRegistry },
  { id: '@knyazevai/dsh-experimental-liveshare', exports: liveshare },
  { id: VIEWER_PAGE_BOOTSTRAP_ID, exports: clientModules },
  { id: '@knyazevai/dsh-client-connection', exports: clientConnection },
  { id: '@knyazevai/dsh-api-gateway', exports: apiGateway },
  { id: '@knyazevai/dsh-api-remote-access', exports: apiRemoteAccess },
  { id: '@knyazevai/dsh-api-remotes', exports: apiRemotes },
  { id: '@knyazevai/dsh-api-session-controller', exports: apiSessionController },
  { id: '@knyazevai/dsh-api-workspace-controller', exports: apiWorkspaceController },
  { id: '@knyazevai/dsh-client-file-upload', exports: clientFileUpload },
  { id: '@knyazevai/dsh-client-locale', exports: clientLocale },
  { id: '@knyazevai/dsh-client-resources', exports: clientResources },
  { id: '@knyazevai/dsh-client-shortcuts', exports: clientShortcuts },
  { id: '@knyazevai/dsh-client-ui-renderer', exports: uiRenderer },
  { id: '@knyazevai/dsh-client-ui-theme', exports: uiTheme },
  { id: '@knyazevai/dsh-client-ui-settings', exports: uiSettings },
  { id: '@knyazevai/dsh-client-ui-layout', exports: uiLayout },
  { id: '@knyazevai/dsh-client-ui-session', exports: uiSession },
  { id: '@knyazevai/dsh-client-ui-session-status', exports: uiSessionStatus },
  { id: '@knyazevai/dsh-client-ui-sidebar', exports: uiSidebar },
  { id: '@knyazevai/dsh-client-ui-conversation', exports: uiConversation },
  { id: '@knyazevai/dsh-client-ui-chat', exports: uiChat },
  { id: '@knyazevai/dsh-client-ui-context-menu', exports: uiContextMenu },
  { id: '@knyazevai/dsh-client-ui-tool', exports: uiTool },
  { id: '@knyazevai/dsh-client-ui-attachment', exports: uiAttachment },
  { id: '@knyazevai/dsh-client-ui-file-drag', exports: uiFileDrag },
  { id: '@knyazevai/dsh-client-ui-sidebar-right', exports: uiSidebarRight },
  { id: '@knyazevai/dsh-client-ui-trajectory', exports: uiTrajectory },
  { id: '@knyazevai/dsh-client-ui-deliverables', exports: uiDeliverables },
  { id: '@knyazevai/dsh-client-ui-workspace', exports: uiWorkspace },
]
