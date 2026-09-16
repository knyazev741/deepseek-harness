/** Projection definition for the durable GitHub Actions session-source marker. */

import { z } from 'zod'
import type { SessionEvent } from '@knyazevai/dsh-session'
import type { ProjectionDefinition } from '@knyazevai/dsh-session-projection'
import type { ForkSessionSource } from './types.ts'

const sourceSchema = z.union([z.literal('github-actions'), z.null()])
const eventDataSchema = z.object({ source: z.literal('github-actions') }).strict()

/** The strict durable payload schema used while folding the source marker. */
export const forkSessionSourceEventDataSchema = eventDataSchema

/** The JSON-safe projection state and wire schema. */
export const forkSessionSourceSchema = sourceSchema

/** Last-known-value projection for the `fork/session-source` event. */
export const forkSessionSourceProjectionDefinition = {
  key: 'forkSessionSource',
  stateSchema: sourceSchema,
  init: () => null,
  apply: (state, event: SessionEvent) => {
    if (event.type !== 'fork/session-source') return state
    return eventDataSchema.parse(event.data).source
  },
  wire: {
    viewSchema: sourceSchema,
    view: state => state,
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'forkSessionSource', ForkSessionSource> & {
  wire: NonNullable<ProjectionDefinition<'forkSessionSource', ForkSessionSource>['wire']>
}
