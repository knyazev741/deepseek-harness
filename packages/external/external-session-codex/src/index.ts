/**
 * Persistent Codex external-agent session provider. Registers the `codex`
 * provider on `ctx.externalSessions` (a Session Definition consumer): each
 * accepted session spawns an official `codex app-server --stdio` child in the
 * session workspace, opens a non-ephemeral thread, and then serves repeated
 * prompts on that thread, streaming deltas and committed items out through the
 * per-session bridge, answering approval asks through the permission channel,
 * and reattaching via `thread/resume` when the app-server process restarts.
 *
 * @module @deepseek-ai/dsh-external-session-codex
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ExternalBridgeContext,
  ExternalModelDirectory,
  ExternalModelInfo,
  ExternalSessionProvider,
  ExternalSessionStart,
  ExternalTurnId,
} from '@deepseek-ai/dsh-external-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { CodexExternalSession, type CodexSessionSpec } from './run.ts'

export const name = 'external-session-codex'
export const inject = ['externalSessions', 'subprocess']

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Deployment-owned command, environment, and process-release bound. */
export interface Config {
  /**
   * App-server command or path; resolves `codex` from PATH by default.
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
  /** Grace in milliseconds for app-server process-tree termination. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  command: z.string().default('codex'),
  args: z.array(z.string()).default(['app-server', '--stdio']),
  env: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

type ResolvedConfig = Required<Config>

function throwable(message: string): never {
  throw new Error(`external-session-codex: ${message}`)
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

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  async start(request: ExternalSessionStart, bridge: ExternalBridgeContext): Promise<void> {
    const session = new CodexExternalSession(request, bridge, this.spec(request.cwd))
    this.sessions.set(request.sessionId, session)
    await session.start(new AbortController().signal)
  }

  prompt(sessionId: SessionId, text: string): Promise<{ turnId: ExternalTurnId }> {
    return this.require(sessionId).prompt(text, new AbortController().signal)
  }

  interrupt(sessionId: SessionId): void {
    this.require(sessionId).interrupt()
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
      { sessionId, provider: 'codex', cwd: process.cwd() },
      inertBridge,
      this.spec(process.cwd()),
    )
    try {
      await session.start(signal)
      return await session.listModels(signal)
    } finally {
      await session.dispose()
    }
  }

  /**
   * Switch the live session to a listed model.
   * @throws always — the 0.147.0 app-server exposes no runtime model-switch on
   *   a live thread and no per-turn model option (tests/evidence/README.md
   *   lists no `thread/model` method, and `turn/start`/`thread/start`/`thread/resume`
   *   accept no `model` field). Native `model/list` still discloses the
   *   config-selected catalog.
   */
  setModel(): Promise<void> {
    return Promise.reject(
      new Error(
        'external-session-codex: the Codex app-server 0.147.0 exposes no runtime model-switch on a live thread; '
        + 'the native model list is read-only (select the model in Codex config instead)',
      ),
    )
  }

  async dispose(sessionId: SessionId): Promise<void> {
    const session = this.require(sessionId)
    this.sessions.delete(sessionId)
    await session.dispose()
  }

  private require(sessionId: SessionId): CodexExternalSession {
    const session = this.sessions.get(sessionId)
    if (session === undefined) {
      throwable(`no live external session ${String(sessionId)}`)
    }
    return session
  }

  private spec(cwd: string): CodexSessionSpec {
    return {
      cwd,
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
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
  const resolved = config as ResolvedConfig
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
  ctx.externalSessions.registerProvider(new CodexProvider(ctx, resolved))
}
