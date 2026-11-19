/** Gesture-time path resolution for Chat-owned file references. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@knyazevai/dsh-session/types'
import { resolveWorkspacePath } from '@knyazevai/dsh-util-workspace-path'
import { sessionDirectory } from '@knyazevai/dsh-api-session-controller/client/directories'

/**
 * Bind path resolution to the originating Session without capturing its current directory.
 * @param ctx - Chat plugin context.
 * @param sessionId - Original Session identity.
 * @returns Resolver using the live working directory, falling back to the workspace root.
 */
export function sessionFilePath(ctx: Context, sessionId: SessionId): (path: string) => string {
  return path => resolveWorkspacePath(sessionDirectory(ctx.sessions, sessionId), path)
}
