/**
 * Persistent Codex external-agent session provider. Registers the `codex`
 * provider on `ctx.externalSessions` (a Session Definition consumer): each
 * accepted session spawns an official `codex app-server --stdio` child in the
 * session workspace, opens a non-ephemeral thread, and then serves repeated
 * prompts on that thread, streaming deltas and committed items out through the
 * per-session bridge, answering approval asks through the permission channel,
 * and respawning the app-server within the same provider instance when the
 * child process restarts. Durable provider identity is accepted by the
 * explicit resume path.
 *
 * @module @deepseek-ai/dsh-external-session-codex
 */

import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ApprovalPolicy,
  ExternalBridgeContext,
  ExternalModelDirectory,
  ExternalModelInfo,
  ExternalModePreflightResult,
  ExternalProviderThreadId,
  ExternalSessionPreflightRequest,
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
import type { McpGatewayLease } from '@deepseek-ai/dsh-mcp-gateway'
import {
  appServerArgv,
  CodexExternalSession,
  preflightCodexServer,
  type CodexSessionSpec,
} from './run.ts'

export const name = 'external-session-codex'
export const inject = ['externalSessions', 'subprocess']

/** Explicit child-environment name used for the optional MCP gateway credential. */
export const MCP_BEARER_TOKEN_ENV_VAR = 'DSH_MCP_BEARER_TOKEN'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Default deadline for one Codex app-server availability probe. */
export const DEFAULT_PREFLIGHT_TIMEOUT_MS = 30_000

/** Stable Codex config key for the Harness MCP server. */
export const CODEX_MCP_SERVER_NAME = 'dsh_harness'

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
  /** Deadline in milliseconds for the pre-session app-server availability probe. */
  preflightTimeoutMs?: number
  /** Tool names requested from the optional authenticated Harness MCP gateway. */
  mcpTools?: string[]
  /** Alias for mcpTools used by deployment profiles to state the allowlist explicitly. */
  allowedTools?: string[]
}

export const Config = z.object({
  command: z.union([z.string(), undefined]),
  args: z.array(z.string()).default(['app-server', '--stdio']),
  env: z.dict(z.string()).default({}),
  stateRoot: z.string().default(join(tmpdir(), 'dsh-external-codex')),
  reasoningEffort: z.union([z.string(), undefined]) as unknown as z<ReasoningEffort | undefined>,
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  preflightTimeoutMs: z.number().default(DEFAULT_PREFLIGHT_TIMEOUT_MS),
  mcpTools: z.array(z.string()).default([]),
  allowedTools: z.union([z.array(z.string()), undefined]),
}) as unknown as z<Config>

type ResolvedConfig = Config & {
  readonly args: string[]
  readonly env: Record<string, string>
  readonly stateRoot: string
  readonly disposeGraceMs: number
  readonly preflightTimeoutMs: number
  readonly mcpTools: readonly string[]
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

/**
 * Upsert the ephemeral Harness MCP server in one private Codex home.
 *
 * The endpoint and environment-variable name are configuration facts; the
 * bearer value remains in the child environment only. Existing Codex settings
 * and rollout files are retained, while a stale Harness section is replaced
 * for each new attachment (including resume).
 * @param stateRoot - private per-session `CODEX_HOME` directory.
 * @param lease - live gateway endpoint and in-memory bearer credential.
 */
export async function writeCodexMcpConfig(stateRoot: string, lease: McpGatewayLease): Promise<void> {
  const endpoint = new URL(lease.url)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
    || endpoint.username !== '' || endpoint.password !== ''
    || endpoint.search !== '' || endpoint.hash !== '') {
    throw new Error('external-session-codex: MCP endpoint must be an authenticated loopback URL')
  }
  if (lease.bearerToken.length === 0 || lease.url.includes(lease.bearerToken)) {
    throw new Error('external-session-codex: MCP bearer token must not be embedded in its URL')
  }
  const header = `[mcp_servers.${CODEX_MCP_SERVER_NAME}]`
  const block = [
    header,
    `url = ${JSON.stringify(lease.url)}`,
    `bearer_token_env_var = ${JSON.stringify(MCP_BEARER_TOKEN_ENV_VAR)}`,
  ].join('\n')
  const configPath = join(stateRoot, 'config.toml')
  let existing = ''
  try {
    existing = await readFile(configPath, 'utf8')
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const lines = existing.split(/\r?\n/u)
  const section = lines.findIndex(line => line.trim() === header)
  const replacement = block.split('\n')
  let next: string
  if (section === -1) {
    next = `${existing.trimEnd()}${existing.trimEnd().length === 0 ? '' : '\n\n'}${block}\n`
  } else {
    let end = section + 1
    while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/u.test(lines[end] ?? '')) end += 1
    next = [...lines.slice(0, section), ...replacement, ...lines.slice(end)].join('\n').replace(/\n*$/u, '\n')
  }
  await writeFile(configPath, next, { encoding: 'utf8', mode: 0o600 })
  await chmod(configPath, 0o600)
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
  mcpLease?: McpGatewayLease | undefined
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

  /**
   * Probe the configured executable and account/sandbox availability without
   * creating a persistent Codex thread or publishing a Harness session.
   * @param request - workspace and requested sandbox policy.
   * @returns a typed availability result suitable for `session.externalModes`.
   */
  async preflight(request: ExternalSessionPreflightRequest): Promise<ExternalModePreflightResult> {
    if (request.cwd.length === 0 || !isAbsolute(request.cwd)) {
      return {
        ok: false,
        failure: { code: 'INVALID_CONFIG', message: 'Codex preflight requires an absolute workspace path.' },
      }
    }
    const mode = request.sandbox ?? 'read-only'
    const sandbox = this.ctx.get('sandbox')
    if (mode !== 'danger-full-access' && sandbox === undefined) {
      return {
        ok: false,
        failure: {
          code: 'SANDBOX_INCOMPATIBLE',
          message: `Codex sandbox mode "${mode}" is unavailable in this deployment.`,
        },
      }
    }
    const sessionId = SessionId(`external-codex-preflight-${randomUUID()}`)
    const stateRoot = codexStateRoot(this.config.stateRoot, String(sessionId))
    // Codex initializes a private SQLite runtime and model cache even during
    // a read-only availability probe. Keep the requested workspace outside
    // the probe policy, but grant the provider-owned state directory itself;
    // the probe must be able to start the real app-server without granting it
    // writes to the user's workspace.
    const preflightPolicy: SandboxExecutionPolicy = mode === 'danger-full-access'
      ? { mode, workspaceRoot: request.cwd, sessionId }
      : { mode: 'workspace-write', workspaceRoot: stateRoot, sessionId }
    const controller = new AbortController()
    const timeoutReason = new Error('external-session-codex: preflight deadline exceeded')
    const timer = setTimeout(() => {
      controller.abort(timeoutReason)
    }, this.config.preflightTimeoutMs)
    try {
      await ensurePrivateStateRoot(this.config.stateRoot, String(sessionId))
      await preflightCodexServer(this.spec(request.cwd, preflightPolicy, stateRoot), controller.signal)
      return { ok: true }
    } catch (error: unknown) {
      const timedOut = controller.signal.reason === timeoutReason
      const message = timedOut
        ? 'Codex preflight timed out before the app-server became ready.'
        : error instanceof Error ? error.message : String(error)
      const lowered = message.toLowerCase()
      const code = timedOut
        ? 'PREFLIGHT_FAILED' as const
        : lowered.includes('enoent') || lowered.includes('not found')
          ? 'BINARY_MISSING' as const
          : lowered.includes('account') || lowered.includes('auth') || lowered.includes('login')
            ? 'AUTH_UNAVAILABLE' as const
            : lowered.includes('sandbox') || lowered.includes('confin')
              ? 'SANDBOX_INCOMPATIBLE' as const
              : lowered.includes('config') || lowered.includes('invalid')
                ? 'INVALID_CONFIG' as const
                : 'PREFLIGHT_FAILED' as const
      return { ok: false, failure: { code, message } }
    } finally {
      clearTimeout(timer)
      await rm(stateRoot, { recursive: true, force: true })
    }
  }

  async start(request: ExternalSessionStart, bridge: ExternalBridgeContext): Promise<void> {
    return this.open(request, bridge)
  }

  async resume(
    request: ExternalSessionStart,
    bridge: ExternalBridgeContext,
    providerThreadId: ExternalProviderThreadId,
  ): Promise<void> {
    if (providerThreadId.length === 0) {
      throwable('provider thread id must be non-empty for resume')
    }
    return this.open(request, bridge, providerThreadId)
  }

  private async open(
    request: ExternalSessionStart,
    bridge: ExternalBridgeContext,
    providerThreadId?: ExternalProviderThreadId,
  ): Promise<void> {
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
    const start = this.startLifecycle(request, bridge, lifecycle, providerThreadId)
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
    providerThreadId?: ExternalProviderThreadId,
  ): Promise<void> {
    let session: CodexExternalSession | undefined
    let mcpLease: McpGatewayLease | undefined
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
      const gateway = this.ctx.get('mcpGateway')
      if (gateway !== undefined && bridge.principal !== undefined && this.config.mcpTools.length > 0) {
        mcpLease = await gateway.create({
          principal: bridge.principal,
          tools: this.config.mcpTools,
          signal: lifecycle.signal,
        })
        lifecycle.mcpLease = mcpLease
        await writeCodexMcpConfig(stateRoot, mcpLease)
        throwIfAborted(lifecycle.signal)
      }
      session = new CodexExternalSession(
        resolvedRequest,
        bridge,
        this.spec(request.cwd, policy, stateRoot, mcpLease),
      )
      lifecycle.session = session
      this.sessions.set(request.sessionId, session)
      if (providerThreadId === undefined) await session.start(lifecycle.signal)
      else await session.resume(providerThreadId, lifecycle.signal)
      throwIfAborted(lifecycle.signal)
    } catch (error: unknown) {
      if (mcpLease !== undefined) {
        lifecycle.mcpLease = undefined
        await Promise.resolve(mcpLease[Symbol.asyncDispose]()).catch(() => {})
      }
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
    const stateRoot = await ensurePrivateStateRoot(this.config.stateRoot, String(sessionId))
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
      // The catalog request starts the real app-server, which initializes its
      // private SQLite runtime even though no workspace turn is issued. Give
      // that temporary state root a writable policy while keeping the host
      // workspace outside the bare listing's grant.
      this.spec(process.cwd(), {
        mode: 'workspace-write',
        workspaceRoot: stateRoot,
        sessionId,
      }, stateRoot),
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
    const mcpLease = lifecycle.mcpLease
    lifecycle.mcpLease = undefined
    if (mcpLease !== undefined) await mcpLease[Symbol.asyncDispose]()
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

  private spec(
    cwd: string,
    sandboxPolicy: SandboxExecutionPolicy,
    stateRoot: string,
    mcpLease?: McpGatewayLease,
  ): CodexSessionSpec {
    const sandbox = this.ctx.get('sandbox')
    return {
      cwd,
      command: this.config.command ?? 'codex',
      args: this.config.args,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      stateRoot,
      ...mcpLease === undefined ? {} : {
        mcp: {
          url: mcpLease.url,
          bearerToken: mcpLease.bearerToken,
          bearerTokenEnvVar: MCP_BEARER_TOKEN_ENV_VAR,
        },
      },
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
  const configuredTools = config.allowedTools !== undefined
    ? config.allowedTools
    : config.mcpTools ?? []
  const resolved: ResolvedConfig = {
    ...config.command === undefined ? {} : { command: config.command },
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    ...config.allowedTools === undefined ? {} : { allowedTools: config.allowedTools },
    args: config.args ?? ['app-server', '--stdio'],
    env: config.env ?? {},
    stateRoot: config.stateRoot ?? join(tmpdir(), 'dsh-external-codex'),
    disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
    preflightTimeoutMs: config.preflightTimeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS,
    mcpTools: configuredTools,
  }
  if (!Number.isFinite(resolved.disposeGraceMs) || resolved.disposeGraceMs <= 0) {
    throwable(`disposeGraceMs must be a positive finite number, got ${resolved.disposeGraceMs}`)
  }
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throwable(`disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isFinite(resolved.preflightTimeoutMs) || resolved.preflightTimeoutMs <= 0) {
    throwable(`preflightTimeoutMs must be a positive finite number, got ${resolved.preflightTimeoutMs}`)
  }
  if (resolved.preflightTimeoutMs > MAX_TIMER_DELAY_MS) {
    throwable(`preflightTimeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  for (const arg of resolved.args) {
    if (arg.length === 0) {
      throwable('app-server args must not contain an empty string')
    }
  }
  if (resolved.args.length === 0) throwable('app-server args must contain at least one argument')
  if (resolved.command !== undefined && resolved.command.trim().length === 0) {
    throwable('command must be non-empty when configured')
  }
  if (resolved.stateRoot.length === 0 || !isAbsolute(resolved.stateRoot)) {
    throwable('stateRoot must be an absolute path')
  }
  const toolNames = new Set<string>()
  for (const tool of resolved.mcpTools) {
    if (tool.trim().length === 0) throwable('allowed tools must not contain an empty name')
    if (toolNames.has(tool)) throwable(`allowed tools must not contain duplicate "${tool}"`)
    toolNames.add(tool)
  }
  ctx.externalSessions.registerProvider(new CodexProvider(ctx, resolved))
}
