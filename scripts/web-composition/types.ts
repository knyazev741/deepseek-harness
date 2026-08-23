/** Supported assembled Web profile names. */
export type WebCompositionProfile = 'web' | 'fork-web'

/** Evidence collected from one built and served Web composition. */
export interface WebCompositionEvidence {
  /** Profile whose emitted artifacts were inspected. */
  readonly profile: WebCompositionProfile
  /** CSS files found beneath the built frontend output, in path order. */
  readonly cssFiles: readonly string[]
  /** Package id of the parser-blocking client bootstrap module. */
  readonly bootstrapModule: string
  /** Package ids in the emitted boot graph, sorted for stable reporting. */
  readonly pluginIds: readonly string[]
  /** Upstream theme package id required by both Web compositions. */
  readonly themePluginId: string
}
