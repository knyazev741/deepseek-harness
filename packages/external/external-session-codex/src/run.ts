/**
 * The persistent Codex external-session runtime: owns the app-server child
 * process, the interactive wire, same-process child respawn (thread/resume
 * after a child restart), and the projection of live wire activity onto the
 * session bridge —
 * log-only `external/*` events plus `streamDelta` on the live frame path.
 *
 * Prompts run strictly serially: each `prompt` awaits the prior turn's
 * terminal notification before starting the next, so a persistent thread is
 * never asked to run two turns at once. The method surface mirrors the
 * provider contract; the process/wire details are private to this module.
 *
 * @module @deepseek-ai/dsh-external-session-codex/run
 */

import { randomUUID } from 'node:crypto'
import type {
  ExternalModelInfo,
  ExternalSessionStart,
  ReasoningEffort,
} from '@deepseek-ai/dsh-external-session'
import { ExternalTurnId } from '@deepseek-ai/dsh-external-session'
import type { SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import type { ExternalBridgeContext } from '@deepseek-ai/dsh-external-session'
import type { ConfinedArgv, SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {
  ExternalMessageAddedData,
  ExternalPermissionOutcome,
  ExternalToolActivityData,
} from '@deepseek-ai/dsh-session-projection'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  CodexExternalWire,
  mapExternalStopReason,
  offeredApprovalDecision,
  type CodexApprovalAsk,
  type CodexTurnEnd,
  type CodexWireHooks,
  type CodexWireSettings,
  type JsonObject,
} from './wire.ts'

/** Fully resolved inputs for one persistent Codex external session. */
export interface CodexSessionSpec {
  /** The session workspace, also supplied to `thread/start`. */
  readonly cwd: string
  /** Explicit deployment/test environment layered after the shared scrub. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared process-tree owner. */
  readonly disposeGraceMs: number
  /** App-server command and args, resolved by the provider's validated Config. */
  readonly command: string
  /** App-server arguments (defaults to `app-server --stdio`). */
  readonly args: readonly string[]
  /** Fully resolved file-effect policy for this session's child. */
  readonly sandboxPolicy: SandboxExecutionPolicy
  /** Optional sandbox wrapper for a non-dangerous file-effect policy. */
  readonly confine?: (argv: readonly string[], policy: SandboxExecutionPolicy) => ConfinedArgv
  /** Direct executable argv used by the packaged launcher. */
  readonly argv?: readonly string[]
  /** Private per-session `CODEX_HOME` directory owned by the provider. */
  readonly stateRoot?: string
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for an unexpected app-server closure mid-session. */
  readonly onError?: (error: Error) => void
}

/**
 * Build the exact subprocess request for one Codex app-server.
 *
 * The command is an argv, never a shell string. Explicit environment entries
 * are layered after the shared credential scrub, and restricted sessions must
 * provide a sandbox wrapper rather than silently running unconfined.
 * @param spec - resolved session command, policy, and process options.
 * @param signal - disposal signal inherited by the child.
 * @returns the fully specified managed-child request.
 */
export function createCodexSpawnSpec(
  spec: CodexSessionSpec,
  signal?: AbortSignal,
): SubprocessSpawnSpec {
  const rawArgv = [...(spec.argv ?? appServerArgv(spec.command, spec.args))]
  const policy = spec.stateRoot === undefined
    ? spec.sandboxPolicy
    : { ...spec.sandboxPolicy, stateRoot: spec.stateRoot }
  const argv = spec.sandboxPolicy.mode === 'danger-full-access'
    ? rawArgv
    : spec.confine?.(rawArgv, policy).argv
  if (argv === undefined) {
    throw new Error(
      `external-session-codex: sandbox mode "${spec.sandboxPolicy.mode}" has no confinement provider`,
    )
  }
  return {
    argv,
    cwd: spec.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    graceMs: spec.disposeGraceMs,
    signal,
    env: {
      ...scrubbedParentEnv(),
      ...spec.env,
      ...spec.stateRoot === undefined ? {} : { CODEX_HOME: spec.stateRoot },
    },
  }
}

/** One live app-server process and its interactive wire. */
interface LiveProcess {
  readonly handle: SubprocessHandle
  readonly wire: CodexExternalWire
  cleanup?: Promise<void>
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed subprocess/wire failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(`external-session-codex: operation aborted: ${String(signal.reason)}`)
}

/**
 * Bind one app-server argv for a platform. Windows npm/pnpm installs expose
 * `codex.cmd`, which requires `cmd.exe`; argv is config-owned and never
 * shell-interpreted here.
 * @param command - validated `codex` command or path.
 * @param args - validated app-server arguments.
 * @param platform - host platform used to select the executable boundary.
 * @returns argv for the Codex app-server command.
 */
export function appServerArgv(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  return platform === 'win32'
    ? ['cmd.exe', '/d', '/s', '/c', command, ...args]
    : [command, ...args]
}

/**
 * One persistent external session on an app-server child. Not constructed
 * directly by consumers; the provider builds it per started session and drives
 * it through the {@link CodexExternalSession} method set.
 */
export class CodexExternalSession {
  private readonly sessionId: SessionId
  private readonly bridge: ExternalBridgeContext
  private readonly spec: CodexSessionSpec
  private settings: CodexWireSettings
  private modelCatalog: readonly ExternalModelInfo[] | undefined
  private threadId: string | undefined
  private live: LiveProcess | undefined
  private activeEnd: {
    raw: string
    promise: Promise<void>
    resolve: () => void
    settled: boolean
  } | undefined
  /** Serializes all prompt operations, including process/thread preparation. */
  private promptSerial: Promise<void> = Promise.resolve()
  private readonly pendingApprovals = new Set<PromiseWithResolvers<ExternalPermissionOutcome>>()
  /** Serializes process cleanup so a respawn cannot race the old tree. */
  private quiescence: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(
    request: ExternalSessionStart,
    bridge: ExternalBridgeContext,
    spec: CodexSessionSpec,
  ) {
    this.sessionId = request.sessionId
    this.bridge = bridge
    this.spec = spec
    this.settings = {
      ...request.model === undefined ? {} : { model: request.model },
      ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort },
      sandbox: request.sandbox,
      approvalPolicy: request.approvalPolicy,
    }
  }

  /** True while an app-server child is alive and usable.
   * @returns whether this session currently owns a live wire.
   */
  isLive(): boolean {
    return this.live !== undefined
  }

  /**
   * Spawn the app-server child, handshake, and open (or resume) the persistent
   * thread, then record `external/session-started`.
   * @param signal - operation cancellation.
   */
  async start(signal: AbortSignal): Promise<void> {
    if (this.live !== undefined) return
    await this.ensureLive(signal, false)
    this.append('external/session-started', {
      provider: 'codex',
      cwd: this.spec.cwd,
      ...this.settings.model === undefined ? {} : { model: this.settings.model },
    })
  }

  /**
   * Submit one prompt as the next serial turn on the persistent thread.
   * @param text - the user prompt text.
   * @param signal - operation cancellation.
   * @returns the provider-issued turn id; the turn streams and completes asynchronously.
   */
  async prompt(text: string, signal: AbortSignal): Promise<{ turnId: ExternalTurnId }> {
    const previous = this.promptSerial
    let release!: () => void
    this.promptSerial = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await this.promptUnlocked(text, signal)
    } finally {
      release()
    }
  }

  private async promptUnlocked(text: string, signal: AbortSignal): Promise<{ turnId: ExternalTurnId }> {
    if (this.activeEnd !== undefined) await this.activeEnd.promise
    await this.ensureLive(signal, true)
    const resolvers = Promise.withResolvers<void>()
    const active = {
      raw: '',
      promise: resolvers.promise,
      resolve: resolvers.resolve,
      settled: false,
    }
    this.activeEnd = active
    try {
      const raw = await this.liveWire().startTurn(text, signal, this.settings)
      if (active.settled) {
        throw new Error('external-session-codex: app-server closed while starting the turn')
      }
      active.raw = raw
      this.append('external/message-added', { turnId: raw, role: 'user', text })
      return { turnId: ExternalTurnId(raw) }
    } catch (error: unknown) {
      if (!active.settled) {
        active.settled = true
        if (this.activeEnd === active) this.activeEnd = undefined
        active.resolve()
      }
      throw thrown(error)
    }
  }

  /** Store model and reasoning settings for the next stable `turn/start`.
   * @param model - selected native model id.
   * @param reasoningEffort - optional stable reasoning effort.
   */
  async setModel(model: string, reasoningEffort?: ReasoningEffort): Promise<void> {
    if (model.length === 0) throw new Error('external-session-codex: model must be non-empty')
    const catalog = this.modelCatalog ?? await this.listModels(new AbortController().signal)
    if (!catalog.some(entry => entry.id === model)) {
      throw new Error(`external-session-codex: model "${model}" is not listed by the native catalog`)
    }
    this.settings = {
      ...this.settings,
      model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    }
    if (reasoningEffort === undefined) {
      this.settings = {
        ...this.settings.model === undefined ? {} : { model: this.settings.model },
        sandbox: this.settings.sandbox,
        approvalPolicy: this.settings.approvalPolicy,
      }
    }
    this.append('external/model-switched', { model })
  }

  /**
   * List the models this native install can switch to, through the live wire.
   * @param signal - operation cancellation.
   * @returns the disclosed models.
   */
  async listModels(signal: AbortSignal): Promise<ExternalModelInfo[]> {
    await this.ensureLive(signal, true)
    const models = await this.liveWire().listModels(signal)
    this.modelCatalog = models
    return models
  }

  /**
   * Start the native compact path.
   * @param signal - operation cancellation.
   */
  async compact(signal: AbortSignal): Promise<void> {
    await this.ensureLive(signal, true)
    await this.liveWire().compact(signal)
    this.append('external/compaction-noticed', {
      notice: 'The external agent compacted its conversation context.',
    })
  }

  /** Best-effort interruption of the active turn; no-op when idle. */
  interrupt(): void {
    this.live?.wire.interrupt()
  }

  /**
   * Dispose the session: record `external/session-ended`, interrupt any active
   * turn, then close the wire and run the whole-tree termination ladder
   * (stdin EOF grace, then the shared process-tree escalation).
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const pending of this.pendingApprovals) pending.resolve('cancelled')
    this.pendingApprovals.clear()
    this.append('external/session-ended', { stopReason: 'completed' })
    this.live?.wire.interrupt()
    const live = this.live
    this.live = undefined
    this.settleActiveTurn('aborted')
    if (live !== undefined) await this.cleanupLive(live)
    await this.quiescence
  }

  /** Build the wire hooks that project live app-server activity onto the bridge. */
  private makeHooks(onProcessClosed: (error: Error) => void): CodexWireHooks {
    return {
      onTurnStarted: (turnId) => {
        this.append('external/turn-started', { turnId })
        if (this.activeEnd?.raw === '') this.activeEnd.raw = turnId
      },
      onItemStarted: (turnId, item) => {
        this.emitToolActivity(turnId, item)
      },
      onCommittedItem: (turnId, item) => {
        if (item.type === 'agentMessage' && typeof item.text === 'string') {
          this.append('external/message-added', {
            turnId,
            role: 'agent',
            text: item.text,
          } satisfies ExternalMessageAddedData)
        }
        this.emitToolActivity(turnId, item)
      },
      onDelta: (turnId, delta) => {
        this.bridge.streamDelta(this.sessionId, ExternalTurnId(turnId), delta)
      },
      onTurnEnded: (end) => {
        this.finishTurn(end)
      },
      onProcessClosed: (error) => {
        onProcessClosed(error)
      },
      answerApproval: async (ask) => {
        return this.answerApproval(ask)
      },
    }
  }

  /** Emit a tool-activity event for a commandExecution item's start or commit. */
  private emitToolActivity(turnId: string, item: JsonObject): void {
    if (item.type !== 'commandExecution') return
    const title = typeof item.command === 'string' ? item.command : 'command execution'
    const started = item.status === 'inProgress'
    const completed = item.status !== 'inProgress'
    if (!started && !completed) return
    const kind = started ? 'call' : 'result'
    const activity: ExternalToolActivityData = completed && typeof item.exitCode === 'number'
      ? { turnId, kind, title, detail: `${String(item.status)} (exit ${item.exitCode})` }
      : { turnId, kind, title }
    this.append('external/tool-activity', activity)
  }

  /** Terminate the active turn bookkeeping and record `external/turn-ended`. */
  private finishTurn(end: CodexTurnEnd): void {
    const stopReason = mapExternalStopReason(end.status, end.error)
    this.append('external/turn-ended', { turnId: end.id, stopReason })
    const active = this.activeEnd
    if (active !== undefined && active.raw === end.id) {
      active.settled = true
      this.activeEnd = undefined
      active.resolve()
    }
  }

  /** Settle a turn that cannot receive a terminal wire notification. */
  private settleActiveTurn(stopReason: 'aborted' | 'error'): void {
    const active = this.activeEnd
    if (active === undefined || active.settled) return
    active.settled = true
    this.activeEnd = undefined
    if (active.raw.length > 0) {
      this.append('external/turn-ended', { turnId: active.raw, stopReason })
    }
    active.resolve()
  }

  /** Ask the human through the bridge and answer the app-server approval. */
  private async answerApproval(ask: CodexApprovalAsk): Promise<string> {
    if (this.disposed || this.bridge.disposal.aborted) return 'cancel'
    const askId = ask.itemId.length > 0 ? ask.itemId : `ask-${randomUUID()}`
    const title = ask.reason ?? 'Run a command in the workspace'
    const options = this.approvalOptions(ask.availableDecisions)
    this.append('external/permission-asked', { askId, title, options })
    const cancellation = Promise.withResolvers<ExternalPermissionOutcome>()
    this.pendingApprovals.add(cancellation)
    const onDispose = (): void => { cancellation.resolve('cancelled') }
    this.bridge.disposal.addEventListener('abort', onDispose, { once: true })
    let outcome: ExternalPermissionOutcome
    try {
      const decision = await Promise.race([
        this.bridge.requestPermission(this.sessionId, { askId, title, options }),
        cancellation.promise,
      ])
      outcome = decision === 'cancelled' ? 'cancelled' : decision
    } catch (error) {
      // A failed or unwired permission channel fails closed to the human's
      // cancel outcome and the safest offered decision.
      this.spec.onError?.(thrown(error))
      outcome = 'cancelled'
    } finally {
      this.bridge.disposal.removeEventListener('abort', onDispose)
      this.pendingApprovals.delete(cancellation)
    }
    if (this.disposed || this.bridge.disposal.aborted) return 'cancel'
    const requested = outcome === 'allowed' ? 'accept' : outcome === 'rejected' ? 'decline' : 'cancel'
    const decision = offeredApprovalDecision(ask.availableDecisions, requested)
    this.append('external/permission-decided', { askId, outcome })
    return decision
  }

  /** The human-facing options for an approval, derived from the offered decisions. */
  private approvalOptions(available: unknown): readonly string[] {
    const options = ['Allow', 'Reject']
    if (Array.isArray(available) && available.some(entry =>
      entry === 'cancel'
      || (entry !== null && typeof entry === 'object' && 'cancel' in (entry as JsonObject)),
    )) {
      options.push('Cancel')
    }
    return options
  }

  /**
   * Guarantee a live child: spawn one when absent or after an unexpected
   * death, handshake, and open or resume the persistent thread.
   * @param signal - operation cancellation.
   * @param resume - whether to `thread/resume` the in-memory thread id after a
   *   child restart instead of creating a new one.
   */
  private async ensureLive(signal: AbortSignal, resume: boolean): Promise<void> {
    if (this.live !== undefined) return
    await this.quiescence
    throwIfAborted(signal)
    if (this.disposed) throw new Error('external-session-codex: session is disposed')
    const handle = this.spec.spawn(createCodexSpawnSpec(this.spec, this.bridge.disposal))
    const liveRef: { current?: LiveProcess } = {}
    const wire = new CodexExternalWire(
      handle.stdout as NonNullable<SubprocessHandle['stdout']>,
      handle.stdin as NonNullable<SubprocessHandle['stdin']>,
      this.makeHooks((error) => {
        if (liveRef.current !== undefined) this.handleProcessClosed(liveRef.current, error)
      }),
    )
    const live: LiveProcess = { handle, wire }
    liveRef.current = live
    const processFailure: Promise<never> = handle.done.then(
      outcome => Promise.reject(new Error(
        'external-session-codex: app-server exited before the operation settled '
        + `(code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})`,
      )),
      (error: unknown) => Promise.reject(thrown(error)),
    )
    processFailure.catch(() => {})
    void handle.done.then(
      (outcome) => {
        if (live !== undefined && this.live?.handle === handle) {
          this.handleProcessClosed(live, new Error(
            'external-session-codex: app-server exited before the operation settled '
            + `(code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})`,
          ))
        }
      },
      (error: unknown) => {
        if (live !== undefined && this.live?.handle === handle) this.handleProcessClosed(live, thrown(error))
      },
    )
    this.live = live
    try {
      wire.start()
      await Promise.race([wire.initialize(signal), processFailure])
      if (this.threadId === undefined || !resume) {
        const id = await Promise.race([wire.startPersistentThread(this.spec.cwd, signal, this.settings), processFailure])
        this.threadId = id
      } else {
        await Promise.race([wire.resumeThread(this.threadId, signal, this.settings), processFailure])
      }
    } catch (error: unknown) {
      if (this.live?.handle === handle) this.live = undefined
      await this.cleanupLive(live)
      throw thrown(error)
    }
  }

  /** Handle one process failure for the exact child that owned the wire. */
  private handleProcessClosed(live: LiveProcess, error: Error): void {
    if (this.disposed || this.live?.handle !== live.handle) return
    this.live = undefined
    this.spec.onError?.(error)
    this.settleActiveTurn('error')
    void this.cleanupLive(live).catch((cleanupError: unknown) => {
      this.spec.onError?.(thrown(cleanupError))
    })
  }

  /**
   * Enqueue one child teardown behind all earlier process trees. A cleanup
   * rejection remains on the quiescence barrier: later respawn and disposal
   * observe the failure instead of treating an unreaped child as settled.
   */
  private cleanupLive(live: LiveProcess | undefined): Promise<void> {
    if (live === undefined) return this.quiescence
    if (live.cleanup !== undefined) return live.cleanup
    const previous = this.quiescence
    const cleanup = previous.then(() => this.disposeChild(live.handle, live.wire))
    live.cleanup = cleanup
    this.quiescence = cleanup
    void cleanup.catch(() => {})
    return cleanup
  }

  /** The live wire, or fail loud if no app-server child is alive. */
  private liveWire(): CodexExternalWire {
    const wire = this.live?.wire
    if (wire === undefined) {
      throw new Error('external-session-codex: no live app-server wire')
    }
    return wire
  }

  private async disposeChild(handle: SubprocessHandle, wire: CodexExternalWire): Promise<void> {
    wire.close()
    if (handle.pid > 0) {
      try {
        handle.stdin?.end()
      } catch {
        // A concurrently closed stdin does not change tree ownership below.
      }
      handle.terminate()
    }
    const exited = await handle.waitForExit()
    if (!exited) throw new Error('external-session-codex: process tree did not reach quiescence')
    await handle.done.catch(() => {})
  }

  private append<K extends keyof SessionEventMap>(type: K, data: SessionEventMap[K]): void {
    this.bridge.appendEvent(this.sessionId, { type, data })
  }
}
