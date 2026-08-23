/** Type aliases for the provider-neutral external-session registry. */

import type { ExternalSessionModeMap } from './index.ts'

/** Mode ids declared by providers through declaration merging. */
export type ExternalSessionMode = Extract<keyof ExternalSessionModeMap, string>

/** Provider type associated with one declared mode id. */
export type ExternalSessionProvider<Mode extends ExternalSessionMode> = ExternalSessionModeMap[Mode]
