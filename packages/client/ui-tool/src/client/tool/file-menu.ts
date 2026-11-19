/** Tool-owned path resolution supplied by the existing toolview registration. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@knyazevai/dsh-session/types'
import { sessionDirectory } from '@knyazevai/dsh-api-session-controller/client/directories'
import { resolveWorkspacePath } from '@knyazevai/dsh-util-workspace-path'

/** File paths are resolved when a gesture begins, not when the Slot is mounted. */
export interface ToolFileInjected {
  /** Resolve an argument from the live Session directory. @param path - Recorded path. @returns Host path. */
  resolveFilePath: (path: string) => string
}

/**
 * Bind a toolview's path reader to its originating Session.
 * @param ctx - Tool plugin context.
 * @returns Existing Slot registration's inject callback.
 */
export function toolFileInject(ctx: Context): (sessionId: SessionId) => ToolFileInjected {
  return sessionId => ({
    resolveFilePath: path => resolveWorkspacePath(sessionDirectory(ctx.sessions, sessionId), path),
  })
}
