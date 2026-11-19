/**
 * Import-free type declarations of the `workingDirectory` Session projection, for Client programs that read it.
 * @module @knyazevai/dsh-working-directory/types
 */

import type {} from '@knyazevai/dsh-session-projection/types'

declare module '@knyazevai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Recorded directory of the Session for observations, or null when none is recorded. */
    workingDirectory: string | null
  }
}
