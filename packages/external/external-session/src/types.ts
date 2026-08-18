/**
 * The seam's consumer-facing contracts: the {@link ExternalAgentDescriptor},
 * {@link ExternalSessionStart}, and {@link ExternalModelInfo} payloads, the
 * {@link ExternalBridgeContext} handed to a provider at {@link ExternalSessionsService.start},
 * and the {@link ExternalSessionProvider} contract that later tasks code against.
 * Internal control state belongs with the {@link ExternalSessions} implementation;
 * this module stays the published surface.
 *
 * Opaque cross-boundary ids are branded. {@link ExternalTurnId} is the one the
 * seam owns; {@link SessionId} comes pre-branded from `dsh-session`, imported
 * here without a cycle because `dsh-session` never depends on this family.
 *
 * @module @deepseek-ai/dsh-external-session/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionEventMap, SessionEventType, SessionId } from '@deepseek-ai/dsh-session'

/**
 * Which surface answers {@link ExternalSessionsService.listModels} for a mode.
 * `provider` means the provider exposes a native model catalog; `config`
 * means it resolves a validated roster from its own configuration.
 */
export type ExternalModelDirectory = 'provider' | 'config'

/** Identifies one submitted turn inside an external session. */
export type ExternalTurnId = Branded<'ExternalTurnId'>

/**
 * Brand a string as an {@link ExternalTurnId}.
 * @param id - the raw turn id.
 * @returns the same string, branded.
 */
export function ExternalTurnId(id: string): ExternalTurnId {
  return id as ExternalTurnId
}

/**
 * A registered external agent's public face: the registry name doubles as the
 * session mode id, the label feeds the mode picker (Chinese copy lives
 * client-side), and {@link ExternalAgentDescriptor.modelDirectory} says who
 * answers model listing.
 */
export interface ExternalAgentDescriptor {
  /** Registry name, also the session mode id and the key {@link ExternalSessionStart.provider} names. */
  readonly provider: string
  /** UI label for the mode; product copy lives in the client, not this field. */
  readonly label: string
  /** Who answers {@link ExternalSessionsService.listModels}. */
  readonly modelDirectory: ExternalModelDirectory
}

/**
 * The request that {@link ExternalSessionsService.start} resolves before a
 * provider owns a live session. The session id is pre-reserved by the host
 * session creation (a later phase), so the provider never invents it.
 */
export interface ExternalSessionStart {
  /** Pre-reserved durable session id owned by the host. */
  readonly sessionId: SessionId
  /** Provider name, also the session mode id. */
  readonly provider: string
  /** Absolute working directory that names an enterable directory. */
  readonly cwd: string
  /** Optional initial model the mode should drive with. */
  readonly model?: string
}

/** One disclosed model the external agent can switch to. */
export interface ExternalModelInfo {
  /** Model id accepted by {@link ExternalSessionsService.setModel}. */
  readonly id: string
  /** Human-readable model name for selectors. */
  readonly name: string
  /** Optional user-facing distinction from otherwise similar models. */
  readonly description?: string
}

/** A permission request an external agent poses to the human. */
export interface ExternalPermissionAsk {
  /** Opaque id the provider correlates a decision back to. */
  readonly askId: string
  /** Short question presented to the human. */
  readonly title: string
  /** The offered choices; `allowed`/`rejected` map onto the first two. */
  readonly options: readonly string[]
}

/** The settled outcome of one {@link ExternalPermissionAsk}. */
export type ExternalPermissionDecision = 'allowed' | 'rejected' | 'cancelled'

/**
 * Answers one external session's permission ask on behalf of the human. Host
 * packages register an implementation on the service so the per-session bridge
 * stops failing closed; the provider correlates by ask id and applies the
 * returned decision.
 * @param sessionId - the live external session posing the ask.
 * @param ask - the permission question and its options.
 * @returns the decision applied to the ask.
 */
export type ExternalPermissionAnswerer = (
  sessionId: SessionId,
  ask: ExternalPermissionAsk,
) => Promise<ExternalPermissionDecision>

/**
 * A writer-side session-event fragment (type plus payload) that a provider
 * hands to {@link ExternalBridgeContext.appendEvent}; the live session stamps
 * `seq`, `time`, and (for the log-only family) `ignorable`. The type union is
 * the merge-extensible session envelope, so the `external/*` events merged in a
 * later phase become valid members without this package teaching their names.
 */
export interface ExternalSessionEvent<T extends SessionEventType = SessionEventType> {
  /** The session event type. */
  type: T
  /** The event payload; must be JSON-serializable. */
  data: SessionEventMap[T]
}

/**
 * The live, non-durable conduit handed to a provider at start. Events written
 * through {@link ExternalBridgeContext.appendEvent} enter the durable session
 * log (log-only, `ignorable: true`); deltas ride
 * {@link ExternalBridgeContext.streamDelta} on the live path and are never
 * logged. The permission channel and the live delta sink are wired by host
 * packages in later phases; until then the defaults fail closed.
 */
export interface ExternalBridgeContext {
  /**
   * Append one log-only session event to the live session. The event is a
   * writer-side fragment (type plus payload); the session stamps sequencing and
   * the `ignorable` marker. A live session must already be registered in the
   * session store. Absent a live session the event is dropped: durability is
   * host-owned, not promised here.
   * @param sessionId - the session to append to.
   * @param event - the event fragment to record.
   */
  appendEvent(sessionId: SessionId, event: ExternalSessionEvent): void
  /**
   * Ask the human whether the external agent may proceed with a permission
   * request, resolving with the decision. Fails closed (rejects) while no
   * permission channel is wired.
   * @param sessionId - the session posing the request.
   * @param ask - the permission question and its options.
   * @returns the human's decision applied to the ask.
   */
  requestPermission(sessionId: SessionId, ask: ExternalPermissionAsk): Promise<ExternalPermissionDecision>
  /**
   * Forward a live transcript delta for one turn. Live-only: never written to
   * the durable log.
   * @param sessionId - the session producing the delta.
   * @param turnId - the turn the delta belongs to.
   * @param delta - the incremental text delta.
   */
  streamDelta(sessionId: SessionId, turnId: ExternalTurnId, delta: string): void
  /** Aborts once the session is disposed, so the provider can tear down its process. */
  readonly disposal: AbortSignal
}

/**
 * A named provider driving live external sessions, as the registry's
 * registered member. It carries the descriptor fields the registry reports and
 * the same operational set as {@link ExternalSessionsService} minus registry
 * concerns; `start` additionally receives the per-session bridge.
 */
export interface ExternalSessionProvider extends ExternalAgentDescriptor {
  /**
   * Begin driving one live external session.
   * @param request - the resolved start request.
   * @param bridge - the live conduit the provider writes transcripts through.
   */
  start(request: ExternalSessionStart, bridge: ExternalBridgeContext): Promise<void>
  /**
   * Submit one user prompt as the next turn.
   * @param sessionId - the live external session.
   * @param text - the user text to deliver.
   * @returns the provider-issued turn id.
   */
  prompt(sessionId: SessionId, text: string): Promise<{ turnId: ExternalTurnId }>
  /**
   * Stop the current turn without disposing the session.
   * @param sessionId - the live external session.
   */
  interrupt(sessionId: SessionId): void
  /**
   * List the models this mode can switch to, from its native catalog or its
   * configured roster per {@link ExternalAgentDescriptor.modelDirectory}.
   * @returns the disclosed models.
   */
  listModels(): Promise<ExternalModelInfo[]>
  /**
   * Switch the live session to a listed model.
   * @param sessionId - the live external session.
   * @param model - a model id from {@link ExternalSessionProvider.listModels}.
   */
  setModel(sessionId: SessionId, model: string): Promise<void>
  /**
   * Dispose the live session and its process tree.
   * @param sessionId - the live external session.
   */
  dispose(sessionId: SessionId): Promise<void>
}

/**
 * The registry surface later tasks code against. It owns named-provider
 * registration, session-to-provider dispatch, and the per-session bridge it
 * hands at {@link ExternalSessionsService.start}.
 */
export interface ExternalSessionsService {
  /** List the registered agents' descriptors. */
  listAgents(): ExternalAgentDescriptor[]
  /**
   * Begin a live external session on the named provider, handing it a bridge.
   * @param request - the start request with a pre-reserved session id.
   */
  start(request: ExternalSessionStart): Promise<void>
  /**
   * Submit one prompt to a live external session.
   * @param sessionId - the live external session.
   * @param text - the user text to deliver.
   * @returns the provider-issued turn id.
   */
  prompt(sessionId: SessionId, text: string): Promise<{ turnId: ExternalTurnId }>
  /**
   * Stop the current turn of a live external session.
   * @param sessionId - the live external session.
   */
  interrupt(sessionId: SessionId): void
  /**
   * List the models a provider can switch to.
   * @param provider - the registered provider name.
   * @returns the disclosed models.
   */
  listModels(provider: string): Promise<ExternalModelInfo[]>
  /**
   * Switch a live external session to a listed model.
   * @param sessionId - the live external session.
   * @param model - the model id to switch to.
   */
  setModel(sessionId: SessionId, model: string): Promise<void>
  /**
   * Dispose a live external session and its process tree.
   * @param sessionId - the live external session.
   */
  dispose(sessionId: SessionId): Promise<void>
}
