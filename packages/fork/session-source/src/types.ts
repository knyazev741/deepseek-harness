/** Public durable and projection types for the GitHub Actions source marker. */

/** The source value recorded when a session is created in GitHub Actions. */
export type ForkSessionSource = 'github-actions' | null

declare module '@knyazevai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only marker identifying a session created in GitHub Actions. */
    'fork/session-source': { source: 'github-actions' }
  }
}

declare module '@knyazevai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Folded source marker, or null before a marker is present. */
    forkSessionSource: ForkSessionSource
  }

  interface SessionProjectionMap {
    /** Client-visible source marker, or null when the session has no marker. */
    forkSessionSource: ForkSessionSource
  }
}
