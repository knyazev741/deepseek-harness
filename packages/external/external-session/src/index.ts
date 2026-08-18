/**
 * Service Definition for the external interactive-agent session capability
 * seam (`ctx.externalSessions`): a named-provider registry whose providers
 * drive live sessions on behalf of an external agent process (Codex, Claude
 * Code, an ACP client). A mode at session creation names one registered
 * provider; a later host phase owns the durable `external/*` session-log
 * projection and the permission bridge. This package owns the registry, the
 * session-to-provider dispatch, and the per-session bridge handed at start.
 *
 * Unlike the shell seam (one executor per context), MULTIPLE providers coexist
 * here: each registers under a unique name (doubling as the session mode id)
 * and a caller picks one by name, mirroring the subagent registry
 * (`ctx.subagents`) rather than the single-service executor.
 *
 * @module @deepseek-ai/dsh-external-session
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ExternalTurnId } from './types.ts'
import type {
  ExternalAgentDescriptor,
  ExternalBridgeContext,
  ExternalModelInfo,
  ExternalPermissionAnswerer,
  ExternalPermissionDecision,
  ExternalSessionEvent,
  ExternalSessionProvider,
  ExternalSessionStart,
  ExternalSessionsService,
} from './types.ts'

export { ExternalTurnId } from './types.ts'
export type {
  ExternalAgentDescriptor,
  ExternalBridgeContext,
  ExternalModelDirectory,
  ExternalModelInfo,
  ExternalPermissionAnswerer,
  ExternalPermissionAsk,
  ExternalPermissionDecision,
  ExternalSessionEvent,
  ExternalSessionProvider,
  ExternalSessionStart,
  ExternalSessionsService,
} from './types.ts'

/** Typed failure for the external-session seam. */
export class ExternalSessionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'ExternalSessionError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    externalSessions: ExternalSessions
  }

  interface Events {
    /**
     * A provider became resolvable in the registry.
     * @param descriptor - the registered provider's descriptor.
     * @mode emit
     */
    'external/provider-added'(descriptor: ExternalAgentDescriptor): void
    /**
     * A provider left the registry. Live sessions it already started remain
     * owner-held; new starts under that provider fail loud.
     * @param provider - the provider name that no longer resolves.
     * @mode emit
     */
    'external/provider-removed'(provider: string): void
  }
}

/**
 * Named-provider registry plus dispatch for live external sessions.
 * {@link registerProvider} is effect-scoped and HMR safe; removing a provider
 * blocks new starts but does not revoke live sessions already handed to their
 * holders. Opaque session ids are routed to their owning provider through
 * {@link sessions}.
 */
export class ExternalSessions extends Service implements ExternalSessionsService {
  /** Registered providers keyed by their registry/mode name. */
  private providers = new Map<string, ExternalSessionProvider>()
  /** Live-session routing: session id to owning provider name. */
  private sessions = new Map<SessionId, string>()
  /** Per-session disposal signals aborted on {@link dispose}. */
  private disposals = new Map<SessionId, AbortController>()
  /** The registered permission answerer, or undefined while the channel is unwired. */
  private permissionAnswerer: ExternalPermissionAnswerer | undefined

  constructor(ctx: Context) {
    super(ctx, 'externalSessions')
  }

  /**
   * Register a provider under its registry name. Registration is effect-scoped
   * and HMR safe; removing a provider blocks new starts but does not revoke
   * live sessions already returned to their holders.
   * @param provider - the trusted provider implementation.
   * @returns the exact Cordis effect disposer.
   */
  registerProvider(provider: ExternalSessionProvider): () => void {
    const name = provider.provider
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(function* (this: ExternalSessions) {
      if (this.providers.has(name)) {
        throw new ExternalSessionError(
          `an external session provider named "${name}" is already registered`,
          'DUPLICATE_PROVIDER',
        )
      }
      this.providers.set(name, provider)
      yield () => {
        this.providers.delete(name)
        this.ctx.emit('external/provider-removed', name)
      }
      // A throwing added-listener unwinds the yielded rollback, matching the
      // repository's fail-loud registration semantics.
      this.ctx.emit('external/provider-added', descriptorOf(provider))
    }.bind(this), 'externalSessions.registerProvider()')
  }

  /**
   * Register the permission answerer that every per-session bridge's
   * {@link ExternalBridgeContext.requestPermission} consults. Registration is
   * effect-scoped and HMR safe, mirroring {@link registerProvider}: at most one
   * channel is active, and disposing it restores the fail-closed default.
   * @param answerer - answers an external session's permission asks on behalf
   *   of the human.
   * @returns the exact Cordis effect disposer.
   */
  registerPermissionChannel(answerer: ExternalPermissionAnswerer): () => void {
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(function* (this: ExternalSessions) {
      if (this.permissionAnswerer !== undefined) {
        throw new ExternalSessionError(
          'an external session permission channel is already registered',
          'DUPLICATE_PERMISSION_CHANNEL',
        )
      }
      this.permissionAnswerer = answerer
      yield () => {
        this.permissionAnswerer = undefined
      }
    }.bind(this), 'externalSessions.registerPermissionChannel()')
  }

  /**
   * Look up a provider by its registry name.
   * @param name - the registry/mode name.
   * @returns the provider, or undefined when absent.
   */
  getProvider(name: string): ExternalSessionProvider | undefined {
    return this.providers.get(name)
  }

  /**
   * List registered provider names in insertion order.
   * @returns the registered names.
   */
  list(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * List registered agents' descriptors.
   * @returns the descriptors in insertion order.
   */
  listAgents(): ExternalAgentDescriptor[] {
    return [...this.providers.values()].map(descriptorOf)
  }

  /**
   * Begin a live external session on the named provider, handing it a bridge.
   * Records the session-to-provider route before awaiting the provider so a
   * later prompt/interrupt/setModel/dispose always resolves, even if start
   * rejects.
   * @param request - the start request with a pre-reserved session id.
   * @throws {@link ExternalSessionError} for an unknown provider or a
   *   session id that is already live.
   */
  async start(request: ExternalSessionStart): Promise<void> {
    const provider = this.expectProvider(request.provider)
    if (this.sessions.has(request.sessionId)) {
      throw new ExternalSessionError(
        `external session ${String(request.sessionId)} is already started`,
        'DUPLICATE_SESSION',
      )
    }
    this.sessions.set(request.sessionId, request.provider)
    const controller = new AbortController()
    this.disposals.set(request.sessionId, controller)
    await provider.start(request, this.createBridge(controller))
  }

  /**
   * Submit one prompt to a live external session.
   * @param sessionId - the live external session.
   * @param text - the user text to deliver.
   * @returns the provider-issued turn id.
   * @throws {@link ExternalSessionError} when the session is not live.
   */
  async prompt(sessionId: SessionId, text: string): Promise<{ turnId: ExternalTurnId }> {
    return this.providerFor(sessionId).prompt(sessionId, text)
  }

  /**
   * Stop the current turn of a live external session.
   * @param sessionId - the live external session.
   * @throws {@link ExternalSessionError} when the session is not live.
   */
  interrupt(sessionId: SessionId): void {
    this.providerFor(sessionId).interrupt(sessionId)
  }

  /**
   * Compact a live external session through its provider's native mechanism;
   * the provider records `external/compaction-noticed` on the bridge.
   * @param sessionId - the live external session.
   * @throws {@link ExternalSessionError} when the session is not live or the
   *   provider's native compact rejects.
   */
  async compact(sessionId: SessionId): Promise<void> {
    await this.providerFor(sessionId).compact(sessionId)
  }

  /**
   * List the models a provider can switch to.
   * @param provider - the registered provider name.
   * @returns the disclosed models.
   * @throws {@link ExternalSessionError} for an unknown provider.
   */
  async listModels(provider: string): Promise<ExternalModelInfo[]> {
    return this.expectProvider(provider).listModels()
  }

  /**
   * Switch a live external session to a listed model.
   * @param sessionId - the live external session.
   * @param model - the model id to switch to.
   * @throws {@link ExternalSessionError} when the session is not live.
   */
  async setModel(sessionId: SessionId, model: string): Promise<void> {
    await this.providerFor(sessionId).setModel(sessionId, model)
  }

  /**
   * Dispose a live external session and its process tree. The bridge's
   * disposal signal fires before the provider tears down.
   * @param sessionId - the live external session.
   * @throws {@link ExternalSessionError} when the session is not live.
   */
  async dispose(sessionId: SessionId): Promise<void> {
    const provider = this.providerFor(sessionId)
    this.sessions.delete(sessionId)
    const controller = this.disposals.get(sessionId)
    this.disposals.delete(sessionId)
    controller?.abort()
    await provider.dispose(sessionId)
  }

  /** Look up a provider for dispatch or fail loud. */
  private expectProvider(name: string): ExternalSessionProvider {
    const provider = this.providers.get(name)
    if (provider === undefined) {
      throw new ExternalSessionError(
        `no external session provider registered for "${name}"`,
        'UNKNOWN_PROVIDER',
      )
    }
    return provider
  }

  /** Resolve the provider owning a live session or fail loud. */
  private providerFor(sessionId: SessionId): ExternalSessionProvider {
    const name = this.sessions.get(sessionId)
    if (name === undefined) {
      throw new ExternalSessionError(
        `no live external session ${String(sessionId)}`,
        'UNKNOWN_SESSION',
      )
    }
    return this.expectProvider(name)
  }

  /**
   * Build the live bridge for one session. `appendEvent` writes only when there
   * is a live session in the session store; permission and delta wiring are
   * host responsibilities filled in later phases.
   * @param controller - the disposal controller for this session.
   * @returns the bridge handed to the provider at start.
   */
  private createBridge(controller: AbortController): ExternalBridgeContext {
    return {
      appendEvent: (sessionId, event) => {
        const session = this.ctx.get('sessions')?.get(sessionId)
        if (session === undefined) return
        appendSessionEvent(session, event)
      },
      requestPermission: async (sessionId, ask): Promise<ExternalPermissionDecision> => {
        const answerer = this.permissionAnswerer
        if (answerer === undefined) {
          // Phase 1: the ask-user permission bridge (a host plugin) registers
          // this channel; until then it fails closed.
          throw new ExternalSessionError(
            'external session permission channel is not wired (the external-permission host plugin wires it)',
            'PERMISSION_UNWIRED',
          )
        }
        return answerer(sessionId, ask)
      },
      streamDelta: (_sid, _turnId, _delta) => {
        // Live-only: deltas ride the host frame channel and are never durable.
      },
      disposal: controller.signal,
    }
  }
}

/** Project a provider onto its public descriptor fields. */
function descriptorOf(provider: ExternalSessionProvider): ExternalAgentDescriptor {
  return {
    provider: provider.provider,
    label: provider.label,
    modelDirectory: provider.modelDirectory,
  }
}

/**
 * Append one pre-formed session event fragment to a live session. External
 * events are log-only and require no surface intent, so the payload's type
 * correlation is re-established here against the merge-extensible envelope.
 * @param session - the live session to append to.
 * @param event - the event fragment to record.
 */
function appendSessionEvent(session: Session, event: ExternalSessionEvent): void {
  session.append(event.type, event.data)
}

export default ExternalSessions
