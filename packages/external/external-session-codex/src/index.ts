/**
 * Persistent Codex external-agent session provider. Registers the `codex`
 * provider on `ctx.externalSessions` (a Session Definition consumer): each
 * accepted session spawns an official `codex app-server --stdio` child in the
 * session workspace, opens a non-ephemeral thread, and then serves repeated
 * prompts on that thread, streaming deltas and committed items out through the
 * per-session bridge, answering approval asks through the permission channel,
 * and respawning the app-server within the same provider instance when the
 * child process restarts. Durable provider identity belongs to a later phase.
 *
 * @module @deepseek-ai/dsh-external-session-codex
 */

import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ApprovalPolicy,
  ExternalBridgeContext,
  ExternalModelDirectory,
  ExternalModelInfo,
  ExternalSessionProvider,
  ExternalSessionStart,
  ExternalTurnId,
  ReasoningEffort,
} from '@deepseek-ai/dsh-external-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { appServerArgv, CodexExternalSession, type CodexSessionSpec } from './run.ts'

export const name = 'external-session-codex'
export const inject = ['externalSessions', 'subprocess']

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Deployment-owned command, environment, and process-release bound. */
export interface Config {
  /**
   * Optional app-server command or path override; the packaged launcher is
   * used when this is absent.
   */
  command?: string
  /**
   * App-server arguments; defaults to `app-server --stdio`. The full argv is
   * never shell-interpreted.
   */
  args?: string[]
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /** Harness-owned parent directory for per-session Codex homes. */
  stateRoot?: string
  /** Initial reasoning effort used when the request does not provide one. */
  reasoningEffort?: ReasoningEffort
  /** Grace in milliseconds for app-server process-tree termination. */
  disposeGraceMs?: number
}

export const Config = z.object({
  command: z.union([z.string(), undefined]),
  args: z.array(z.string()).default(['app-server', '--stdio']),
  env: z.dict(z.string()).default({}),
  stateRoot: z.string().default(join(tmpdir(), 'dsh-external-codex')),
  reasoningEffort: z.union([z.string(), undefined]) as unknown as z<ReasoningEffort | undefined>,
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
}) as unknown as z<Config>

type ResolvedConfig = Config & {
  readonly args: string[]
  readonly env: Record<string, string>
  readonly stateRoot: string
  readonly disposeGraceMs: number
}

const require = createRequire(import.meta.url)

/** Resolve the packaged launcher when no deployment command override exists.
 * @param args - app-server arguments appended to the packaged launcher.
 * @returns the direct Node-plus-launcher argv.
 */
export function packagedCodexArgv(args: readonly string[]): string[] {
  return [process.execPath, require.resolve('@openai/codex/bin/codex.js'), ...args]
}

/** Return the exact app-server argv for an explicit command or packaged launcher.
 * @param command - explicit command override, or undefined for the package.
 * @param args - app-server arguments.
 * @param platform - platform used for explicit Windows command binding.
 * @returns the direct app-server argv.
 */
export function resolvedCodexArgv(
  command: string | undefined,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  return command === undefined ? packagedCodexArgv(args) : appServerArgv(command, args, platform)
}

/** Key one session's state directory without putting the opaque id in a path.
 * @param root - Harness-owned state parent directory.
 * @param sessionId - opaque session id to key.
 * @returns the private per-session state directory.
 */
export function codexStateRoot(root: string, sessionId: string): string {
  const key = createHash('sha256').update(sessionId, 'utf8').digest('hex')
  return join(resolve(root), key)
}

/** Create a private Harness-owned directory retained by this provider instance. */
async function ensurePrivateStateRoot(root: string, sessionId: string): Promise<string> {
  const stateRoot = codexStateRoot(root, sessionId)
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  await chmod(stateRoot, 0o700)
  return stateRoot
}

function throwable(message: string): never {
  throw new Error(`external-session-codex: ${message}`)
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`external-session-codex: startup aborted: ${String(signal.reason)}`)
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}

interface CodexLifecycle {
  readonly controller: AbortController
  readonly signal: AbortSignal
  start: Promise<void>
  session?: CodexExternalSession
  disposed: boolean
}

/**
 * The `codex` mode's provider: owns one persistent session per started session
 * id and answers the registry's model-seat surface from the native catalog.
 */
class CodexProvider implements ExternalSessionProvider {
  readonly provider = 'codex'
  readonly label = 'Codex'
  readonly modelDirectory: ExternalModelDirectory = 'provider'
  private readonly sessions = new Map<SessionId, CodexExternalSession>()
  private readonly lifecycles = new Map<SessionId, CodexLifecycle>()

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  async start(request: ExternalSessionStart, bridge: ExternalBridgeContext): Promise<void> {
    if (this.lifecycles.has(request.sessionId)) {
      throwable(`external session ${String(request.sessionId)} is already starting or live`)
    }
    const controller = new AbortController()
    const signal = AbortSignal.any([bridge.disposal, controller.signal])
    const lifecycle: CodexLifecycle = {
      controller,
      signal,
      start: Promise.resolve(),
      disposed: false,
    }
    this.lifecycles.set(request.sessionId, lifecycle)
    const start = this.startLifecycle(request, bridge, lifecycle)
    lifecycle.start = start
    // Keep the failed owner until the registry rolls its route back or a
    // concurrent disposal claims it. Both paths must be able to reap the
    // partially constructed child without turning the handoff into an
    // UNKNOWN_SESSION failure.
    await start
  }

  private async startLifecycle(
    request: ExternalSessionStart,
    bridge: ExternalBridgeContext,
    lifecycle: CodexLifecycle,
  ): Promise<void> {
    let session: CodexExternalSession | undefined
    try {
      const liveSession = this.ctx.get('sessions')?.get(request.sessionId)
      if (liveSession === undefined) throwable(`no live Session for ${String(request.sessionId)}`)
      const policy = this.resolveSandboxPolicy(liveSession, request)
      const resolvedRequest: ExternalSessionStart = {
        ...request,
        ...request.reasoningEffort === undefined && this.config.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: request.reasoningEffort ?? this.config.reasoningEffort },
        sandbox: policy.mode,
        approvalPolicy: this.resolveApprovalPolicy(liveSession, request.approvalPolicy),
      }
      const stateRoot = await ensurePrivateStateRoot(this.config.stateRoot, String(request.sessionId))
      throwIfAborted(lifecycle.signal)
      session = new CodexExternalSession(
        resolvedRequest,
        bridge,
        this.spec(request.cwd, policy, stateRoot),
      )
      lifecycle.session = session
      this.sessions.set(request.sessionId, session)
      await session.start(lifecycle.signal)
      throwIfAborted(lifecycle.signal)
    } catch (error: unknown) {
      if (session !== undefined && this.sessions.get(request.sessionId) === session) {
        this.sessions.delete(request.sessionId)
        await session.dispose().catch(() => {})
      }
      throw error
    }
  }

  prompt(sessionId: SessionId, text: string): Promise<{ turnId: ExternalTurnId }> {
    return this.ready(sessionId).then(({ lifecycle, session }) => session.prompt(text, lifecycle.signal))
  }

  /** Interrupt a live turn; a startup-time call is a defined no-op. */
  interrupt(sessionId: SessionId): void {
    const lifecycle = this.lifecycles.get(sessionId)
    if (lifecycle === undefined) throwable(`no live external session ${String(sessionId)}`)
    if (lifecycle.disposed) return
    lifecycle.session?.interrupt()
  }

  /**
   * Run the app-server's native compact on the live session; the run records
   * `external/compaction-noticed` through the session bridge on completion.
   * @param sessionId - the live external session.
   */
  async compact(sessionId: SessionId): Promise<void> {
    const { lifecycle, session } = await this.ready(sessionId)
    await session.compact(lifecycle.signal)
  }

  /**
   * List the models this native install can switch to. Uses a live session's
   * wire when one exists; otherwise a short-lived wire against the deployment
   * working directory (the catalog is local, so the workspace is immaterial).
   * @returns the disclosed models.
   */
  async listModels(): Promise<ExternalModelInfo[]> {
    const signal = new AbortController().signal
    for (const session of this.sessions.values()) {
      if (session.isLive()) return session.listModels(signal)
    }
    const sessionId = SessionId(`external-codex-bare-${randomUUID()}`)
    const inertBridge: ExternalBridgeContext = {
      appendEvent: () => {},
      requestPermission: () => throwable('bare model listing has no permission channel'),
      streamDelta: () => {},
      disposal: new AbortController().signal,
    }
    const session = new CodexExternalSession(
      {
        sessionId,
        provider: 'codex',
        cwd: process.cwd(),
        sandbox: 'read-only',
        approvalPolicy: 'ask',
      },
      inertBridge,
      this.spec(process.cwd(), {
        mode: 'read-only',
        workspaceRoot: process.cwd(),
        sessionId,
      }, await ensurePrivateStateRoot(this.config.stateRoot, String(sessionId))),
    )
    try {
      await session.start(signal)
      return await session.listModels(signal)
    } finally {
      await session.dispose()
    }
  }

  /**
   * Store a model/effort selection for the next stable `turn/start` request.
   * @param sessionId - the live external session.
   * @param model - the selected model id.
   * @param reasoningEffort - optional selected reasoning effort.
   */
  async setModel(sessionId: SessionId, model: string, reasoningEffort?: ReasoningEffort): Promise<void> {
    const { session } = await this.ready(sessionId)
    await session.setModel(model, reasoningEffort)
  }

  async dispose(sessionId: SessionId): Promise<void> {
    const lifecycle = this.lifecycles.get(sessionId)
    if (lifecycle === undefined) throwable(`no live external session ${String(sessionId)}`)
    lifecycle.disposed = true
    lifecycle.controller.abort()
    await lifecycle.start.catch(() => {})
    const session = lifecycle.session
    if (session !== undefined && this.sessions.get(sessionId) === session) {
      this.sessions.delete(sessionId)
      await session.dispose()
    }
    if (this.lifecycles.get(sessionId) === lifecycle) this.lifecycles.delete(sessionId)
  }

  private async ready(sessionId: SessionId): Promise<{
    lifecycle: CodexLifecycle
    session: CodexExternalSession
  }> {
    const lifecycle = this.lifecycles.get(sessionId)
    if (lifecycle === undefined) throwable(`no live external session ${String(sessionId)}`)
    await lifecycle.start
    if (lifecycle.disposed) throw abortError(lifecycle.signal)
    const session = lifecycle.session
    if (session === undefined || this.sessions.get(sessionId) !== session) {
      throwable(`no live external session ${String(sessionId)}`)
    }
    return { lifecycle, session }
  }

  private resolveSandboxPolicy(session: Session, request: ExternalSessionStart): SandboxExecutionPolicy {
    const service = this.ctx.get('sandboxPolicy')
    if (service !== undefined) return service.resolve({ session })
    return {
      mode: request.sandbox,
      workspaceRoot: request.cwd,
      sessionId: session.id,
    }
  }

  private resolveApprovalPolicy(session: Session, fallback: ApprovalPolicy): ApprovalPolicy {
    const service = this.ctx.get('approval')
    if (service === undefined) return fallback
    return effectiveApprovalPolicy(session.events) ?? service.config.policy ?? fallback
  }

  private spec(cwd: string, sandboxPolicy: SandboxExecutionPolicy, stateRoot: string): CodexSessionSpec {
    const sandbox = this.ctx.get('sandbox')
    return {
      cwd,
      command: this.config.command ?? 'codex',
      args: this.config.args,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      stateRoot,
      sandboxPolicy,
      ...sandbox === undefined
        ? {}
        : { confine: (argv: readonly string[], policy: SandboxExecutionPolicy) => sandbox.confine(argv, policy as SandboxPolicy) },
      argv: resolvedCodexArgv(this.config.command, this.config.args),
      spawn: spec => this.ctx.subprocess.spawn(spec),
      onError: (error) => {
        this.ctx.logger.warn(`external-session-codex: child session: ${error.message}`)
      },
    }
  }
}

/**
 * Register the `codex` external-session provider.
 * @param ctx - context carrying the external-session registry and subprocess services.
 * @param config - explicit command, arguments, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    ...config,
    args: config.args ?? ['app-server', '--stdio'],
    env: config.env ?? {},
    stateRoot: config.stateRoot ?? join(tmpdir(), 'dsh-external-codex'),
    disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
  }
  if (!Number.isFinite(resolved.disposeGraceMs) || resolved.disposeGraceMs <= 0) {
    throwable(`disposeGraceMs must be a positive finite number, got ${resolved.disposeGraceMs}`)
  }
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throwable(`disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  for (const arg of resolved.args) {
    if (arg.length === 0) {
      throwable('app-server args must not contain an empty string')
    }
  }
  if (resolved.command !== undefined && resolved.command.length === 0) {
    throwable('command must be non-empty when configured')
  }
  if (resolved.stateRoot.length === 0) throwable('stateRoot must be non-empty')
  ctx.externalSessions.registerProvider(new CodexProvider(ctx, resolved))
}
