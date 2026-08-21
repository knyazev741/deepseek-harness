/**
 * Wire-safe branded ids shared by the external-session host and client
 * contracts. This leaf deliberately has no Cordis, session, or provider
 * imports, so client packages do not pull the server service definition into
 * their type graph.
 *
 * @module @deepseek-ai/dsh-external-session/protocol
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one submitted turn inside an external session. */
export type ExternalTurnId = Branded<'ExternalTurnId'>

/**
 * Brand a string as an {@link ExternalTurnId} at the trusted host boundary.
 * @param id - the raw turn id.
 * @returns the same string carrying the external-turn brand.
 */
export function ExternalTurnId(id: string): ExternalTurnId {
  return id as ExternalTurnId
}
