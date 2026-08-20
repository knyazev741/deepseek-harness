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

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { JsonValue, Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { ExternalToolPrincipalId } from '@deepseek-ai/dsh-tools'
import type { ExternalToolPrincipal, ToolExecutionRecorder } from '@deepseek-ai/dsh-tools'
import { ExternalToolCallId as brandExternalToolCallId, ExternalTurnId } from './types.ts'
import type { ExternalToolCallId as ExternalToolCallIdValue } from './types.ts'
import type {
  ExternalAgentDescriptor,
  ExternalBridgeContext,
  ExternalModelInfo,
  ExternalPermissionAnswerer,
  ExternalPermissionDecision,
  ExternalProviderThreadId,
  ExternalSessionEvent,
  ExternalSessionStartRequest,
  ExternalSessionProvider,
  ExternalSessionStart,
  ReasoningEffort,
  ExternalSessionsService,
  ExternalToolCallData,
  ExternalToolError,
  ExternalToolResultData,
} from './types.ts'

export { ExternalTurnId } from './types.ts'
export { ExternalProviderThreadId, parseExternalProviderThreadId } from './types.ts'
export { ExternalToolCallId } from './types.ts'
export type {
  ExternalAgentDescriptor,
  ExternalBridgeContext,
  ExternalModelDirectory,
  ExternalModelInfo,
  ExternalPermissionAnswerer,
  ExternalPermissionAsk,
  ExternalPermissionDecision,
  ApprovalPolicy,
  ReasoningEffort,
  SandboxMode,
  ExternalSessionEvent,
  ExternalSessionProvider,
  ExternalSessionStart,
  ExternalSessionStartRequest,
  ExternalSessionsService,
  ExternalToolCallData,
  ExternalToolCallRecord,
  ExternalToolError,
  ExternalToolResultData,
  ExternalToolResultRecord,
} from './types.ts'

/** Maximum UTF-8 bytes retained by one external tool call or result event. */
export const MAX_EXTERNAL_TOOL_RECORD_BYTES = 64 * 1024

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
    /**
     * One transient external-agent transcript delta. The host mux projects
     * this event to subscribed clients; it is intentionally not a
     * {@link SessionEvent} and never enters the durable session log.
     * @param payload - the session, provider turn, and incremental text.
     * @mode emit
     */
    'external/session-delta'(payload: {
      sessionId: SessionId
      turnId: ExternalTurnId
      delta: string
    }): void
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
  /** Per-session external scopes disposed before the provider process. */
  private scopes = new Map<SessionId, Scope>()
  /** In-flight start/resume operations shared by concurrent attach callers. */
  private attachments = new Map<SessionId, { promise: Promise<void>; token: object }>()
  /** In-flight disposals shared by concurrent callers until provider teardown settles. */
  private teardowns = new Map<SessionId, Promise<void>>()
  /** Recorder finalizers retained until the provider and gateway are quiescent. */
  private recorderFinalizers = new Map<SessionId, () => Promise<void>>()
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
   * later prompt/interrupt/setModel/dispose resolves during startup, then
   * removes the route when startup rejects.
   * @param request - the start request with a pre-reserved session id.
   * @throws {@link ExternalSessionError} for an unknown provider or a
   *   session id that is already live.
   */
  async start(request: ExternalSessionStartRequest): Promise<void> {
    return this.attach(request, 'start')
  }

  /**
   * Attach a persisted external session to its provider-owned thread. Resume
   * is a distinct operation: providers must reject a missing or unknown id and
   * never create a replacement thread.
   * @param request - the resolved session identity and policy values.
   * @param providerThreadId - the branded provider thread id from the durable log.
   */
  async resume(request: ExternalSessionStartRequest, providerThreadId: ExternalProviderThreadId): Promise<void> {
    if (providerThreadId.length === 0) {
      throw new ExternalSessionError(
        'external provider thread id must be non-empty for resume',
        'INVALID_PROVIDER_THREAD_ID',
      )
    }
    return this.attach(request, 'resume', providerThreadId)
  }

  /**
   * Start or resume one provider attachment while retaining rollback ownership.
   * The attachment remains registered until the provider promise settles so a
   * concurrent disposal can share the same quiescence barrier. A new
   * generation waits behind any prior scope/provider teardown for this id.
   */
  private attach(
    request: ExternalSessionStartRequest,
    operation: 'start' | 'resume',
    providerThreadId?: ExternalProviderThreadId,
  ): Promise<void> {
    const teardown = this.teardowns.get(request.sessionId)
    if (teardown !== undefined) {
      // A new generation may not claim the session id until the previous
      // scope and provider have both quiesced. The teardown cleanup callback
      // is registered before this continuation, so the retry sees no stale
      // gate after successful settlement; a rejection stays fail-loud.
      return teardown.then(() => this.attach(request, operation, providerThreadId))
    }
    const pending = this.attachments.get(request.sessionId)
    if (pending !== undefined) return pending.promise
    const provider = this.expectProvider(request.provider)
    if (this.sessions.has(request.sessionId)) {
      throw new ExternalSessionError(
        `external session ${String(request.sessionId)} is already started`,
        'DUPLICATE_SESSION',
      )
    }
    const resolved: ExternalSessionStart = {
      ...request,
      sandbox: request.sandbox ?? 'read-only',
      approvalPolicy: request.approvalPolicy ?? 'ask',
    }
    this.sessions.set(request.sessionId, request.provider)
    const controller = new AbortController()
    this.disposals.set(request.sessionId, controller)
    const token = {}
    const deferred = Promise.withResolvers<undefined>()
    this.attachments.set(request.sessionId, { promise: deferred.promise, token })
    void (async () => {
      try {
        const bridge = await this.createBridge(request.sessionId, request.provider, controller)
        if (operation === 'start') await provider.start(resolved, bridge)
        else if (providerThreadId === undefined) {
          throw new ExternalSessionError(
            'external provider thread id is required for resume',
            'INVALID_PROVIDER_THREAD_ID',
          )
        } else {
          await provider.resume(resolved, bridge, providerThreadId)
        }
        if (controller.signal.aborted) {
          throw new ExternalSessionError(
            `external session ${String(request.sessionId)} was disposed during startup`,
            'SESSION_DISPOSED',
          )
        }
        deferred.resolve(undefined)
      } catch (error) {
        const ownsRoute = this.sessions.get(request.sessionId) === request.provider
          && this.disposals.get(request.sessionId) === controller
        if (ownsRoute) {
          this.sessions.delete(request.sessionId)
          this.disposals.delete(request.sessionId)
          controller.abort()
          await provider.dispose(request.sessionId).catch(() => {})
          await this.finalizeRecorder(request.sessionId)
          await this.disposeScope(request.sessionId)
        } else {
          controller.abort()
          await this.finalizeRecorder(request.sessionId)
          await this.disposeScope(request.sessionId)
        }
        deferred.reject(error)
      } finally {
        if (this.attachments.get(request.sessionId)?.token === token) {
          this.attachments.delete(request.sessionId)
        }
      }
    })()
    return deferred.promise
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
   * @param reasoningEffort - the optional provider reasoning-effort selection.
   * @throws {@link ExternalSessionError} when the session is not live.
   */
  async setModel(sessionId: SessionId, model: string, reasoningEffort?: ReasoningEffort): Promise<void> {
    await this.providerFor(sessionId).setModel(sessionId, model, reasoningEffort)
  }

  /**
   * Dispose a live external session and its process tree. The bridge's
   * disposal signal fires first; the returned promise waits for any in-flight
   * start/resume, provider teardown, and recorder finalization before
   * disposing the external scope. Concurrent callers receive the same teardown
   * promise.
   * @param sessionId - the live external session.
   * @throws {@link ExternalSessionError} when the session is not live.
   */
  dispose(sessionId: SessionId): Promise<void> {
    const existing = this.teardowns.get(sessionId)
    if (existing !== undefined) return existing
    const providerName = this.sessions.get(sessionId)
    if (providerName === undefined) {
      return Promise.reject(new ExternalSessionError(
        `no live external session ${String(sessionId)}`,
        'UNKNOWN_SESSION',
      ))
    }
    let provider: ExternalSessionProvider
    try {
      provider = this.expectProvider(providerName)
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    this.sessions.delete(sessionId)
    const controller = this.disposals.get(sessionId)
    this.disposals.delete(sessionId)
    controller?.abort()
    const attachment = this.attachments.get(sessionId)?.promise
    const teardown = (async () => {
      // Provider startup/resume owns the bridge until its promise settles. The
      // abort signal requests cancellation, but a provider may be late or
      // non-cooperative, so teardown must wait before disposing that provider.
      await attachment?.catch(() => {})
      try {
        await provider.dispose(sessionId)
      } finally {
        try {
          await this.finalizeRecorder(sessionId)
        } finally {
          await this.disposeScope(sessionId)
        }
      }
    })()
    this.teardowns.set(sessionId, teardown)
    const cleanup = (): void => {
      if (this.teardowns.get(sessionId) === teardown) this.teardowns.delete(sessionId)
    }
    void teardown.then(cleanup, cleanup)
    return teardown
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
   * is a live session in the session store; permission remains host-owned, and
   * deltas leave through the typed Cordis event without depending on the mux.
   * A bridge can outlive provider teardown, so deltas also require the same
   * session route and disposal generation that created the bridge.
   * @param sessionId - the session owned by this bridge.
   * @param provider - the provider route owned by this bridge.
   * @param controller - the disposal controller for this session generation.
   * @returns a promise for the bridge handed to the provider at start.
   */
  private async createBridge(sessionId: SessionId, provider: string, controller: AbortController): Promise<ExternalBridgeContext> {
    const turn = { current: undefined as string | undefined }
    const session = this.ctx.get('sessions')?.get(sessionId)
    const principal = session === undefined
      ? undefined
      : await createExternalPrincipal(this.ctx, session, controller.signal, turn, (event) => {
        appendSessionEvent(session, event)
      }, (scope) => {
        this.scopes.set(sessionId, scope)
      }, (finalize) => {
        this.recorderFinalizers.set(sessionId, finalize)
      }, session.events)
    return {
      ...principal === undefined ? {} : { principal },
      appendEvent: (eventSessionId, event) => {
        // The provider's terminal session-ended event is part of teardown and
        // must remain durable after the cancellation signal fires. Other
        // provider events are live-only once disposal has begun.
        if (eventSessionId !== sessionId || (controller.signal.aborted && (event.type as string) !== 'external/session-ended')) return
        const target = this.ctx.get('sessions')?.get(eventSessionId)
        if (target === undefined) return
        appendSessionEvent(target, event)
        const eventType = event.type as string
        const eventData = event.data as unknown as { readonly turnId?: string }
        if (eventType === 'external/turn-started') turn.current = eventData.turnId
        else if (eventType === 'external/turn-ended' && turn.current === eventData.turnId) turn.current = undefined
        else if (eventType === 'external/session-ended') turn.current = undefined
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
      streamDelta: (streamSessionId, turnId, delta) => {
        if (streamSessionId !== sessionId || controller.signal.aborted) return
        if (this.sessions.get(streamSessionId) !== provider || this.disposals.get(streamSessionId) !== controller) return
        // Live-only: the host mux projects this event; no Session.append call
        // is made, so reconnects backfill committed history only.
        this.ctx.emit('external/session-delta', { sessionId: streamSessionId, turnId, delta })
      },
      disposal: controller.signal,
    }
  }

  /** Dispose the scope owned by one external session, if one was created. */
  private async disposeScope(sessionId: SessionId): Promise<void> {
    const scope = this.scopes.get(sessionId)
    if (scope === undefined) return
    this.scopes.delete(sessionId)
    await scope.dispose()
  }

  /** Await the recorder's terminalization barrier before releasing its scope. */
  private async finalizeRecorder(sessionId: SessionId): Promise<void> {
    const finalize = this.recorderFinalizers.get(sessionId)
    if (finalize === undefined) return
    this.recorderFinalizers.delete(sessionId)
    await finalize()
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
function appendSessionEvent(session: Session, event: ExternalSessionEvent): SessionEvent {
  return session.append(event.type, event.data)
}

interface ExternalTurnRef {
  current: string | undefined
}

interface NormalizedExternalToolCall {
  callId: ExternalToolCallIdValue
  name: string
  arguments: JsonValue
  turnId?: string
}

type NormalizedExternalToolResult = {
  callId: ExternalToolCallIdValue
  name?: string
  isError: false
  result: JsonValue
  turnId?: string
} | {
  callId: ExternalToolCallIdValue
  name?: string
  isError: true
  error: ExternalToolError
  turnId?: string
}

type PendingExternalToolCall = NormalizedExternalToolCall

/**
 * Build the external principal and its durable call/result recorder. A seed
 * validation failure disposes the newly created scope before propagating.
 */
async function createExternalPrincipal(
  root: Context,
  session: Session,
  disposal: AbortSignal,
  turn: ExternalTurnRef,
  append: (event: ExternalSessionEvent) => void,
  retainScope: (scope: Scope) => void,
  retainFinalizer: (finalize: () => Promise<void>) => void,
  events: readonly SessionEvent[],
): Promise<ExternalToolPrincipal> {
  const principal = {
    kind: 'external' as const,
    id: ExternalToolPrincipalId(randomUUID()),
    session,
    ctx: root,
    recorder: undefined as unknown as ToolExecutionRecorder,
  }
  const scope = createScope(root, principal)
  try {
    principal.ctx = scope.ctx
    const recorder = createExternalToolRecorder(disposal, turn, append, events)
    principal.recorder = recorder
    retainFinalizer(recorder.finalize)
    retainScope(scope)
    return principal
  } catch (error) {
    await scope.dispose()
    throw error
  }
}

/**
 * Recorder state is serialized so concurrent gateway calls retain call/result
 * order. Caller-owned values are detached synchronously before entering the
 * queue, and the initial sets are seeded from the owning session log so the
 * call-id uniqueness guarantee survives resume and HMR attachments.
 */
function createExternalToolRecorder(
  disposal: AbortSignal,
  turn: ExternalTurnRef,
  append: (event: ExternalSessionEvent) => void,
  events: readonly SessionEvent[],
): ToolExecutionRecorder & { readonly signal: AbortSignal; readonly finalize: () => Promise<void> } {
  const seeded = seedExternalToolRecorder(events)
  const pending = seeded.pending
  const completed = seeded.completed
  const recorderController = new AbortController()
  let tail = Promise.resolve()
  let finalization: Promise<void> | undefined
  let closing = false

  const enqueue = <T>(operation: () => T | PromiseLike<T>): Promise<T> => {
    const result = tail.then(operation)
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    signal: disposal,
    recordCall: (value) => {
      let call: NormalizedExternalToolCall
      try {
        // Detach caller-owned nested arguments before this operation enters
        // the serialized queue. The queue controls commit order only.
        call = normalizeExternalToolCall(value)
      } catch (error) {
        return rejectedRecorderOperation(error)
      }
      return enqueue(() => {
        assertExternalSessionOpen(disposal)
        if (closing) throw new ExternalSessionError('external session recorder is closing', 'SESSION_DISPOSED')
        const key = String(call.callId)
        if (pending.has(key) || completed.has(key)) {
          throw new ExternalSessionError(`external tool call ${JSON.stringify(key)} is already recorded`, 'DUPLICATE_TOOL_CALL')
        }
        const turnId = call.turnId ?? turn.current
        const data: ExternalToolCallData = {
          ...turnId === undefined ? {} : { turnId },
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
        }
        assertExternalToolRecordSize(data, 'call')
        append({ type: 'external/tool-call', data })
        pending.set(key, { ...call, ...turnId === undefined ? {} : { turnId } })
      })
    },
    recordResult: (value) => {
      let result: NormalizedExternalToolResult
      try {
        // Error facts and JSON result values are detached at API entry for the
        // same reason as call arguments: callers may mutate them immediately.
        result = normalizeExternalToolResult(value)
      } catch (error) {
        return rejectedRecorderOperation(error)
      }
      return enqueue(() => {
        assertRecorderOpen(recorderController.signal)
        const key = String(result.callId)
        const call = pending.get(key)
        if (call === undefined) {
          if (completed.has(key)) {
            throw new ExternalSessionError(`external tool call ${JSON.stringify(key)} already recorded a result`, 'DUPLICATE_TOOL_RESULT')
          }
          throw new ExternalSessionError(`no matching external tool call for ${JSON.stringify(key)}`, 'UNMATCHED_TOOL_RESULT')
        }
        if (result.name !== undefined && result.name !== call.name) {
          throw new ExternalSessionError(`external tool result ${JSON.stringify(key)} names ${JSON.stringify(result.name)} instead of ${JSON.stringify(call.name)}`, 'TOOL_RESULT_NAME_MISMATCH')
        }
        if (result.turnId !== undefined && call.turnId !== undefined && result.turnId !== call.turnId) {
          throw new ExternalSessionError(`external tool result ${JSON.stringify(key)} has a different turn id`, 'TOOL_RESULT_TURN_MISMATCH')
        }
        const turnId = result.turnId ?? call.turnId
        const data: ExternalToolResultData = result.isError
          ? {
            ...turnId === undefined ? {} : { turnId },
            callId: result.callId,
            name: call.name,
            isError: true,
            error: result.error,
          }
          : {
            ...turnId === undefined ? {} : { turnId },
            callId: result.callId,
            name: call.name,
            isError: false,
            result: result.result,
          }
        assertExternalToolRecordSize(data, 'result')
        append({ type: 'external/tool-result', data })
        pending.delete(key)
        completed.add(key)
      })
    },
    finalize: (): Promise<void> => {
      if (finalization !== undefined) return finalization
      closing = true
      finalization = enqueue(() => {
        for (const [key, call] of pending) {
          const data: ExternalToolResultData = {
            ...call.turnId === undefined ? {} : { turnId: call.turnId },
            callId: call.callId,
            name: call.name,
            isError: true,
            error: { message: 'external session was disposed', code: 'SESSION_DISPOSED' },
          }
          assertExternalToolRecordSize(data, 'result')
          append({ type: 'external/tool-result', data })
          pending.delete(key)
          completed.add(key)
        }
        recorderController.abort(new ExternalSessionError('external session recorder finalized', 'SESSION_DISPOSED'))
      })
      return finalization
    },
  }
}

/** Preserve the recorder's promise-based invalid-input failure contract. */
function rejectedRecorderOperation(error: unknown): Promise<never> {
  return Promise.reject(error instanceof Error ? error : new Error(String(error)))
}

interface SeededExternalToolRecorder {
  readonly pending: Map<string, PendingExternalToolCall>
  readonly completed: Set<string>
}

/** Seed recorder uniqueness and pending pairs from the owning session log. */
function seedExternalToolRecorder(events: readonly SessionEvent[]): SeededExternalToolRecorder {
  const pending = new Map<string, PendingExternalToolCall>()
  const completed = new Set<string>()
  for (const event of events) {
    if (event.type === 'external/tool-call') {
      let call: NormalizedExternalToolCall
      try {
        call = normalizeExternalToolCall(event.data)
        assertExternalToolRecordSize(event.data, 'call')
      } catch (error) {
        throw invalidSeededToolRecord('call', error)
      }
      const key = String(call.callId)
      if (pending.has(key) || completed.has(key)) {
        throw new ExternalSessionError(`external tool call ${JSON.stringify(key)} is already recorded`, 'DUPLICATE_TOOL_CALL')
      }
      pending.set(key, call)
      continue
    }
    if (event.type !== 'external/tool-result') continue
    let result: NormalizedExternalToolResult
    try {
      result = normalizeExternalToolResult(event.data)
      assertExternalToolRecordSize(event.data, 'result')
    } catch (error) {
      throw invalidSeededToolRecord('result', error)
    }
    if (result.name === undefined) throw invalidSeededToolRecord('result', new TypeError('name must be non-empty'))
    const key = String(result.callId)
    const call = pending.get(key)
    if (call === undefined) {
      if (completed.has(key)) {
        throw new ExternalSessionError(`external tool call ${JSON.stringify(key)} already recorded a result`, 'DUPLICATE_TOOL_RESULT')
      }
      throw new ExternalSessionError(`no matching external tool call for ${JSON.stringify(key)}`, 'UNMATCHED_TOOL_RESULT')
    }
    if (result.name !== call.name) {
      throw new ExternalSessionError(`external tool result ${JSON.stringify(key)} names ${JSON.stringify(result.name)} instead of ${JSON.stringify(call.name)}`, 'TOOL_RESULT_NAME_MISMATCH')
    }
    if (result.turnId !== undefined && call.turnId !== undefined && result.turnId !== call.turnId) {
      throw new ExternalSessionError(`external tool result ${JSON.stringify(key)} has a different turn id`, 'TOOL_RESULT_TURN_MISMATCH')
    }
    pending.delete(key)
    completed.add(key)
  }
  return { pending, completed }
}

/** Convert an invalid durable seed into a typed attachment failure. */
function invalidSeededToolRecord(kind: 'call' | 'result', error: unknown): ExternalSessionError {
  return new ExternalSessionError(
    `external tool ${kind} record in the session log is invalid: ${error instanceof Error ? error.message : String(error)}`,
    'INVALID_TOOL_RECORD',
  )
}

/** Reject recorder writes after its owning session has started disposal. */
function assertExternalSessionOpen(signal: AbortSignal): void {
  if (signal.aborted) throw new ExternalSessionError('external session has been disposed', 'SESSION_DISPOSED')
}

/** Reject terminal recorder writes only after the finalizer has committed pending calls. */
function assertRecorderOpen(signal: AbortSignal): void {
  if (signal.aborted) throw new ExternalSessionError('external session recorder is closed', 'SESSION_DISPOSED')
}

/** Require a plain object at the unknown recorder boundary. */
function recordObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`external tool ${label} record must be a plain object`)
  }
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`external tool ${label} record must be a plain object`)
  }
  return value as Record<string, unknown>
}

/** Read a required non-empty string from an unknown record. */
function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`external tool ${label} ${key} must be a non-empty string`)
  }
  return value
}

/** Read an optional non-empty string from an unknown record. */
function optionalString(record: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`external tool ${label} ${key} must be a non-empty string when provided`)
  }
  return value
}

/** Snapshot one gateway value at the recorder's JSON boundary. */
function requiredJsonValue(value: unknown, label: string): JsonValue {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) {
    throw new TypeError(`external tool ${label} must be JSON-serializable`)
  }
  return snapshot as JsonValue
}

/** Normalize one unknown call record into its durable fields. */
function normalizeExternalToolCall(value: unknown): NormalizedExternalToolCall {
  const record = recordObject(value, 'call')
  const callId = brandExternalToolCallId(requiredString(record, 'callId', 'call'))
  const name = requiredString(record, 'name', 'call')
  const turnId = optionalString(record, 'turnId', 'call')
  return {
    callId,
    name,
    arguments: requiredJsonValue(record.arguments, 'call arguments'),
    ...turnId === undefined ? {} : { turnId },
  }
}

/** Normalize an error value into explicit bounded error facts. */
function normalizeExternalToolError(value: unknown): ExternalToolError {
  if (value instanceof Error) {
    const message = value.message.length > 0 ? value.message : value.name
    const code = typeof (value as Error & { code?: unknown }).code === 'string'
      ? (value as Error & { code: string }).code
      : undefined
    return { message, ...code === undefined ? {} : { code } }
  }
  if (typeof value === 'string' && value.length > 0) return { message: value }
  const record = recordObject(value, 'result error')
  const message = requiredString(record, 'message', 'result error')
  const directCode = record.code
  const info = record.info
  const infoCode = typeof info === 'object' && info !== null && !Array.isArray(info)
    ? (info as Record<string, unknown>).code
    : undefined
  const code = typeof directCode === 'string' ? directCode : typeof infoCode === 'string' ? infoCode : undefined
  return { message, ...code === undefined ? {} : { code } }
}

/** Normalize one unknown result record into its durable fields. */
function normalizeExternalToolResult(value: unknown): NormalizedExternalToolResult {
  const record = recordObject(value, 'result')
  const callId = brandExternalToolCallId(requiredString(record, 'callId', 'result'))
  const name = optionalString(record, 'name', 'result')
  const turnId = optionalString(record, 'turnId', 'result')
  const hasResult = Object.hasOwn(record, 'result')
  const hasValue = Object.hasOwn(record, 'value')
  const hasError = Object.hasOwn(record, 'error') && record.error !== undefined
  if (hasResult && hasValue) throw new TypeError('external tool result cannot include both result and value')
  const isError = record.isError
  if (isError !== undefined && typeof isError !== 'boolean') {
    throw new TypeError('external tool result isError must be boolean')
  }
  const failed = isError ?? hasError
  if (failed) {
    if (hasResult || hasValue) throw new TypeError('external tool error result cannot include a value')
    if (!hasError) throw new TypeError('external tool error result must include an explicit error')
    return {
      callId,
      ...name === undefined ? {} : { name },
      isError: true,
      error: normalizeExternalToolError(record.error),
      ...turnId === undefined ? {} : { turnId },
    }
  }
  if (!hasResult && !hasValue) throw new TypeError('external tool success result must include result or value')
  return {
    callId,
    ...name === undefined ? {} : { name },
    isError: false,
    result: requiredJsonValue(hasResult ? record.result : record.value, 'result value'),
    ...turnId === undefined ? {} : { turnId },
  }
}

/** Enforce the complete durable data record's UTF-8 byte limit. */
function assertExternalToolRecordSize(data: ExternalToolCallData | ExternalToolResultData, kind: 'call' | 'result'): void {
  const encoded = JSON.stringify(data)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_EXTERNAL_TOOL_RECORD_BYTES) {
    throw new ExternalSessionError(`external tool ${kind} record is too large`, 'TOOL_RECORD_TOO_LARGE')
  }
}

export default ExternalSessions
