/** Snapshot-local Loader facade for the fork first-chunk timeout plugin. */

export { apply } from '@deepseek-ai/dsh-fork-llm-first-chunk-timeout'

/** Fixture plugin name used by Loader diagnostics. */
export const name = 'first-chunk-timeout-plugin'
/** Service required by the wrapped production plugin. */
export const inject = ['llm']
