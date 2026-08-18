/**
 * The persistent Codex external-session runtime: owns the app-server child
 * process, the interactive wire, cold reattach (thread/resume after a process
 * restart), and the projection of live wire activity onto the session bridge —
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
import type { ExternalModelInfo, ExternalSessionStart } from '@deepseek-ai/dsh-external-session'
import { ExternalTurnId } from '@deepseek-ai/dsh-external-session'
import type { SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import type { ExternalBridgeContext } from '@deepseek-ai/dsh-external-session'
import type {
  ExternalMessageAddedData,
  ExternalPermissionOutcome,
  ExternalToolActivityData,
} from '@deepseek-ai/dsh-session-projection'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  CodexExternalWire,
  mapExternalStopReason,
  offeredApprovalDecision,
  type CodexApprovalAsk,
  type CodexTurnEnd,
  type CodexWireHooks,
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
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for an unexpected app-server closure mid-session. */
  readonly onError?: (error: Error) => void
}

/** One live app-server process and its interactive wire. */
interface LiveProcess {
  readonly handle: SubprocessHandle
  readonly wire: CodexExternalWire
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed subprocess/wire failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
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
  private threadId: string | undefined
  private live: LiveProcess | undefined
  private activeEnd: { raw: string; promise: Promise<void>; resolve: () => void } | undefined
  private disposed = false

  constructor(
    request: ExternalSessionStart,
    bridge: ExternalBridgeContext,
    spec: CodexSessionSpec,
  ) {
    this.sessionId = request.sessionId
    this.bridge = bridge
    this.spec = spec
  }

  /** True while an app-server child is alive and usable. */
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
    this.append('external/session-started', { provider: 'codex', cwd: this.spec.cwd })
  }

  /**
   * Submit one prompt as the next serial turn on the persistent thread.
   * @param text - the user prompt text.
   * @param signal - operation cancellation.
   * @returns the provider-issued turn id; the turn streams and completes asynchronously.
   */
  async prompt(text: string, signal: AbortSignal): Promise<{ turnId: ExternalTurnId }> {
    if (this.activeEnd !== undefined) await this.activeEnd.promise
    await this.ensureLive(signal, true)
    const raw = await this.liveWire().startTurn(text, signal)
    const resolvers = Promise.withResolvers<void>()
    this.activeEnd = { raw, promise: resolvers.promise, resolve: resolvers.resolve }
    this.append('external/message-added', { turnId: raw, role: 'user', text })
    return { turnId: ExternalTurnId(raw) }
  }

  /**
   * List the models this native install can switch to, through the live wire.
   * @param signal - operation cancellation.
   * @returns the disclosed models.
   */
  async listModels(signal: AbortSignal): Promise<ExternalModelInfo[]> {
    await this.ensureLive(signal, true)
    return this.liveWire().listModels(signal)
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
    this.append('external/session-ended', { stopReason: 'completed' })
    this.live?.wire.interrupt()
    this.live?.wire.close()
    const live = this.live
    this.live = undefined
    const handle = live?.handle
    if (handle === undefined) return
    if (handle.pid > 0) {
      try {
        handle.stdin?.end()
      } catch {
        // A concurrently closed stdin does not change tree ownership below.
      }
      handle.terminate()
      await handle.waitForExit()
    }
    await handle.done.catch(() => {})
  }

  /** Build the wire hooks that project live app-server activity onto the bridge. */
  private makeHooks(): CodexWireHooks {
    return {
      onTurnStarted: (turnId) => {
        this.append('external/turn-started', { turnId })
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
        if (this.disposed) return
        this.spec.onError?.(error)
        if (this.live !== undefined) {
          // The app-server died mid-session; the next operation respawns and
          // resumes the persisted thread.
          this.live = undefined
        }
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
      this.activeEnd = undefined
      active.resolve()
    }
  }

  /** Ask the human through the bridge and answer the app-server approval. */
  private async answerApproval(ask: CodexApprovalAsk): Promise<string> {
    const askId = ask.itemId.length > 0 ? ask.itemId : `ask-${randomUUID()}`
    const title = ask.reason ?? 'Run a command in the workspace'
    const options = this.approvalOptions(ask.availableDecisions)
    this.append('external/permission-asked', { askId, title, options })
    let outcome: ExternalPermissionOutcome
    try {
      const decision = await this.bridge.requestPermission(this.sessionId, { askId, title, options })
      outcome = decision
    } catch (error) {
      // A failed or unwired permission channel fails closed to the human's
      // cancel outcome and the safest offered decision.
      this.spec.onError?.(thrown(error))
      outcome = 'cancelled'
    }
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
   * @param resume - whether to `thread/resume` the persisted thread (deep path
   *   after a process restart) instead of creating a new one.
   */
  private async ensureLive(signal: AbortSignal, resume: boolean): Promise<void> {
    if (this.live !== undefined) return
    const handle = this.spec.spawn({
      argv: appServerArgv(this.spec.command, this.spec.args),
      cwd: this.spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: this.spec.disposeGraceMs,
      env: this.spec.env,
      signal: this.bridge.disposal,
    })
    const wire = new CodexExternalWire(
      handle.stdout as NonNullable<SubprocessHandle['stdout']>,
      handle.stdin as NonNullable<SubprocessHandle['stdin']>,
      this.makeHooks(),
    )
    const processFailure: Promise<never> = handle.done.then(
      outcome => Promise.reject(new Error(
        'external-session-codex: app-server exited before the operation settled '
        + `(code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})`,
      )),
      (error: unknown) => Promise.reject(thrown(error)),
    )
    processFailure.catch(() => {})
    void handle.done.then(
      () => { if (this.live?.handle === handle) this.live = undefined },
      () => {},
    )
    this.live = { handle, wire }
    try {
      wire.start()
      await Promise.race([wire.initialize(signal), processFailure])
      if (this.threadId === undefined || !resume) {
        const id = await Promise.race([wire.startPersistentThread(this.spec.cwd, signal), processFailure])
        this.threadId = id
      } else {
        await Promise.race([wire.resumeThread(this.threadId, signal), processFailure])
      }
    } catch (error: unknown) {
      this.live = undefined
      await this.disposeChild(handle, wire)
      throw thrown(error)
    }
  }

  /** The live wire, or fail loud if no app-server child is alive. */
  private liveWire(): CodexExternalWire {
    const wire = this.live?.wire
    if (wire === undefined) {
      throw new Error('external-session-codex: no live app-server wire')
    }
    return wire
  }

  private disposeChild(handle: SubprocessHandle, wire: CodexExternalWire): Promise<void> {
    wire.close()
    if (handle.pid > 0) {
      try {
        handle.stdin?.end()
      } catch {
        // A concurrently closed stdin does not change tree ownership below.
      }
      handle.terminate()
    }
    const joined = (): Promise<void> => handle.done.then(() => {}, () => {})
    return handle.waitForExit().then(joined, joined)
  }

  private append<K extends keyof SessionEventMap>(type: K, data: SessionEventMap[K]): void {
    this.bridge.appendEvent(this.sessionId, { type, data })
  }
}
