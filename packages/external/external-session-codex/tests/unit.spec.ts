/**
 * Unit tests for `external-session-codex`: stop-reason mapping for unknown
 * terminals, approval-decision selection, argv binding, config validation,
 * and provider registration. These need no Codex process.
 */

import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ExternalSessions from '@deepseek-ai/dsh-external-session'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  apply,
  CODEX_MCP_SERVER_NAME,
  MCP_BEARER_TOKEN_ENV_VAR,
  writeCodexMcpConfig,
} from '../src/index.ts'
import type { McpGatewayLease } from '@deepseek-ai/dsh-mcp-gateway'
import { appServerArgv, CodexExternalSession, createCodexSpawnSpec } from '../src/run.ts'
import {
  CodexExternalWire,
  mapExternalStopReason,
  offeredApprovalDecision,
} from '../src/wire.ts'

async function nextFrame(output: PassThrough): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      output.off('data', onData)
      try {
        resolve(JSON.parse(chunk.toString('utf8').trim()) as Record<string, unknown>)
      } catch (error: unknown) {
        reject(error)
      }
    }
    output.on('data', onData)
    output.once('error', reject)
  })
}

function response(input: PassThrough, frame: Record<string, unknown>, result: unknown): void {
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })}\n`)
}

describe('mapExternalStopReason', () => {
  it('maps clean terminals and interruption', () => {
    expect(mapExternalStopReason('completed', null)).toBe('completed')
    expect(mapExternalStopReason('interrupted', {})).toBe('aborted')
  })

  it('maps a context-window-exceeded failure to max-tokens', () => {
    expect(mapExternalStopReason('failed', { codexErrorInfo: 'contextWindowExceeded' }))
      .toBe('max-tokens')
  })

  it('maps any other failure to error and rejects unknown terminals', () => {
    expect(mapExternalStopReason('failed', { message: 'boom' })).toBe('error')
    expect(() => mapExternalStopReason('halted', null)).toThrow(/invalid terminal turn status/)
  })
})

describe('offeredApprovalDecision', () => {
  it('prefers the requested decision when the wire offers it', () => {
    expect(offeredApprovalDecision(['accept', 'cancel'], 'accept')).toBe('accept')
    expect(offeredApprovalDecision(['accept', 'cancel'], 'cancel')).toBe('cancel')
  })

  it('falls back to the safe decline when the requested decision is not offered', () => {
    expect(offeredApprovalDecision(['accept'], 'cancel')).toBe('decline')
    expect(offeredApprovalDecision(['accept'], 'decline')).toBe('decline')
    expect(offeredApprovalDecision(undefined, 'cancel')).toBe('cancel')
    expect(offeredApprovalDecision(['accept', { acceptWithExecpolicyAmendment: {} }], 'decline'))
      .toBe('decline')
  })
})

describe('appServerArgv', () => {
  it('wraps the command in cmd.exe on win32 and binds argv directly on POSIX', () => {
    expect(appServerArgv('codex', ['app-server', '--stdio'], 'win32'))
      .toEqual(['cmd.exe', '/d', '/s', '/c', 'codex', 'app-server', '--stdio'])
    expect(appServerArgv('codex', ['app-server', '--stdio'], 'darwin'))
      .toEqual(['codex', 'app-server', '--stdio'])
  })
})

describe('CodexExternalWire stable settings', () => {
  it('reads only the account authentication state for preflight', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const wire = new CodexExternalWire(input, output, {
      onTurnStarted: () => {},
      onItemStarted: () => {},
      onCommittedItem: () => {},
      onDelta: () => {},
      onTurnEnded: () => {},
      onProcessClosed: () => {},
      answerApproval: async () => 'decline',
    })
    const signal = new AbortController().signal
    wire.start()
    const account = wire.readAccount(signal)
    const frame = await nextFrame(output)
    expect(frame.method).toBe('account/read')
    response(input, frame, { account: { type: 'none' } })
    await expect(account).resolves.toBe(false)
    wire.close()
    input.destroy()
    output.destroy()
  })

  it('maps sandbox, approval, model, and effort onto stable app-server requests', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const wire = new CodexExternalWire(input, output, {
      onTurnStarted: () => {},
      onItemStarted: () => {},
      onCommittedItem: () => {},
      onDelta: () => {},
      onTurnEnded: () => {},
      onProcessClosed: () => {},
      answerApproval: async () => 'decline',
    })
    const signal = new AbortController().signal
    wire.start()

    const initialize = wire.initialize(signal)
    const initializeFrame = await nextFrame(output)
    expect(initializeFrame.method).toBe('initialize')
    response(input, initializeFrame, {})
    await initialize

    const start = wire.startPersistentThread('/work', signal, {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      sandbox: 'workspace-write',
      approvalPolicy: 'ask',
    })
    const startFrame = await nextFrame(output)
    expect(startFrame).toMatchObject({
      method: 'thread/start',
      params: {
        cwd: '/work',
        ephemeral: false,
        model: 'gpt-5.6-sol',
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
      },
    })
    response(input, startFrame, { thread: { id: 'thread-1' } })
    await start

    const resumed = wire.resumeThread('thread-1', signal, {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    const resumeFrame = await nextFrame(output)
    expect(resumeFrame).toMatchObject({
      method: 'thread/resume',
      params: {
        threadId: 'thread-1',
        model: 'gpt-5.6-sol',
        sandbox: 'read-only',
        approvalPolicy: 'never',
      },
    })
    response(input, resumeFrame, {})
    await resumed

    const turn = wire.startTurn('hello', signal, {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    const turnFrame = await nextFrame(output)
    expect(turnFrame).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'hello', text_elements: [] }],
        model: 'gpt-5.6-sol',
        effort: 'high',
        sandbox: 'read-only',
        approvalPolicy: 'never',
      },
    })
    response(input, turnFrame, { turn: { id: 'turn-1' } })
    await turn
    wire.close()
    input.destroy()
    output.destroy()
  })
})

describe('Codex spawn policy', () => {
  it('confines the exact app-server argv and keeps only explicit credentials', () => {
    const ambientName = 'EXTERNAL_CODEX_AMBIENT_SECRET'
    const previous = process.env[ambientName]
    process.env[ambientName] = 'ambient-secret'
    try {
      const signal = new AbortController().signal
      const spec = createCodexSpawnSpec({
        cwd: '/work',
        command: 'codex',
        args: ['app-server', '--stdio'],
        env: { OPENAI_API_KEY: 'explicit-secret' },
        disposeGraceMs: 3_000,
        sandboxPolicy: {
          mode: 'workspace-write',
          workspaceRoot: '/work',
          stateRoot: '/harness/codex/session-a',
        },
        confine: argv => ({
          argv: ['sandbox-runner', ...argv],
          enforcement: 'full',
          denialSignatures: [],
          runnerFailureRules: [],
        }),
        spawn: () => { throw new Error('spawn is not used by this unit') },
      }, signal)
      expect(spec.argv).toEqual(['sandbox-runner', 'codex', 'app-server', '--stdio'])
      expect(spec.env).toMatchObject({ OPENAI_API_KEY: 'explicit-secret' })
      expect(spec.env).not.toHaveProperty(ambientName)
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, ambientName)
      else process.env[ambientName] = previous
    }
  })

  it('does not grant a configured state root under read-only policy', () => {
    let confinedPolicy: SandboxExecutionPolicy | undefined
    const stateRoot = '/harness/codex/read-only-session'
    createCodexSpawnSpec({
      cwd: '/work',
      command: 'codex',
      args: ['app-server', '--stdio'],
      env: {},
      disposeGraceMs: 3_000,
      sandboxPolicy: { mode: 'read-only', workspaceRoot: '/work' },
      stateRoot,
      confine: (argv, policy) => {
        confinedPolicy = policy
        return {
          argv: [...argv],
          enforcement: 'full',
          denialSignatures: [],
          runnerFailureRules: [],
        }
      },
      spawn: () => { throw new Error('spawn is not used by this unit') },
    })
    expect(confinedPolicy?.stateRoot).toBe(stateRoot)
    if (confinedPolicy === undefined) throw new Error('sandbox policy was not captured')
    expect(writableRoots(confinedPolicy)).toEqual([])
  })

  it('passes the MCP bearer only through the explicit child environment', () => {
    const token = 'mcp-token-not-in-argv'
    const spec = createCodexSpawnSpec({
      cwd: '/work',
      command: 'codex',
      args: ['app-server', '--stdio'],
      env: {},
      disposeGraceMs: 3_000,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '/work' },
      stateRoot: '/harness/codex/session-a',
      mcp: {
        url: 'http://127.0.0.1:43123/mcp/opaque-route',
        bearerToken: token,
        bearerTokenEnvVar: MCP_BEARER_TOKEN_ENV_VAR,
      },
      spawn: () => { throw new Error('spawn is not used by this unit') },
    })
    expect(spec.env?.[MCP_BEARER_TOKEN_ENV_VAR]).toBe(token)
    expect(spec.argv).not.toContain(token)
    expect(spec.argv).not.toContain('http://127.0.0.1:43123/mcp/opaque-route')
  })

  it('replaces only the ephemeral MCP config section and retains rollout state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-mcp-'))
    try {
      await mkdir(join(root, 'sessions'), { recursive: true })
      await writeFile(join(root, 'sessions', 'rollout.jsonl'), 'durable rollout')
      await writeFile(join(root, 'config.toml'), [
        '[model]',
        'name = "fixture"',
        '',
        `[mcp_servers.${CODEX_MCP_SERVER_NAME}]`,
        'url = "http://127.0.0.1:1/mcp/stale"',
        'bearer_token_env_var = "OLD_TOKEN"',
        '',
        '[other]',
        'enabled = true',
        '',
      ].join('\n'))
      const lease = (url: string, bearerToken: string): McpGatewayLease => ({
        url,
        bearerToken,
        [Symbol.asyncDispose]: async () => {},
      })
      await writeCodexMcpConfig(root, lease('http://127.0.0.1:43123/mcp/new-route', 'new-token'))
      const first = await readFile(join(root, 'config.toml'), 'utf8')
      expect(first).toContain('name = "fixture"')
      expect(first).toContain('enabled = true')
      expect(first).toContain('http://127.0.0.1:43123/mcp/new-route')
      expect(first).toContain(`bearer_token_env_var = "${MCP_BEARER_TOKEN_ENV_VAR}"`)
      expect(first).not.toContain('new-token')
      expect(first).not.toContain('/mcp/stale')
      await writeCodexMcpConfig(root, lease('http://127.0.0.1:43123/mcp/resumed-route', 'rotated-token'))
      const resumed = await readFile(join(root, 'config.toml'), 'utf8')
      expect(resumed.match(new RegExp(`^\\[mcp_servers\\.${CODEX_MCP_SERVER_NAME}\\]$`, 'gmu'))).toHaveLength(1)
      expect(resumed).toContain('/mcp/resumed-route')
      expect(resumed).not.toContain('rotated-token')
      await expect(readFile(join(root, 'sessions', 'rollout.jsonl'), 'utf8')).resolves.toBe('durable rollout')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retains cleanup failure on the quiescence barrier', async () => {
    const session = Object.create(CodexExternalSession.prototype) as {
      quiescence: Promise<void>
      cleanupLive(live: unknown): Promise<void>
    }
    session.quiescence = Promise.resolve()
    const failure = new Error('process did not reach quiescence')
    const live = {
      handle: {
        pid: 1,
        stdin: { end: () => {} },
        terminate: () => {},
        waitForExit: async () => { throw failure },
        done: Promise.resolve(),
      },
      wire: { close: () => {} },
    }
    await expect(session.cleanupLive(live)).rejects.toThrow(failure)
    await expect(session.quiescence).rejects.toThrow(failure)
  })
})

describe('external-session-codex config validation', () => {
  /** A fully-resolved config (the loader applies schema defaults); override per test. */
  const fullConfig = (overrides: Partial<Record<string, unknown>> = {}): never =>
    ({ command: 'codex', args: ['app-server', '--stdio'], env: {}, disposeGraceMs: 3_000, ...overrides }) as never

  it('rejects a non-positive or oversized disposeGraceMs', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, fullConfig({ disposeGraceMs: 0 })) }).toThrow(/positive finite/)
    expect(() => { apply(ctx, fullConfig({ disposeGraceMs: -1 })) }).toThrow(/positive finite/)
    expect(() => { apply(ctx, fullConfig({ disposeGraceMs: MAX_TIMER_DELAY_MS + 1 })) })
      .toThrow(/no greater than/)
  })

  it('rejects an empty app-server arg', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, fullConfig({ args: ['app-server', ''] })) }).toThrow(/empty string/)
  })

  it('rejects an empty argument list, blank command, relative state root, and invalid tool names', () => {
    expect(() => { apply(new Context(), fullConfig({ args: [] })) }).toThrow(/at least one argument/)
    expect(() => { apply(new Context(), fullConfig({ command: '  ' })) }).toThrow(/command must be non-empty/)
    expect(() => { apply(new Context(), fullConfig({ stateRoot: 'codex-state' })) }).toThrow(/stateRoot must be an absolute path/)
    expect(() => { apply(new Context(), fullConfig({ allowedTools: ['  '] })) }).toThrow(/empty name/)
    expect(() => { apply(new Context(), fullConfig({ allowedTools: ['read_file', 'read_file'] })) })
      .toThrow(/duplicate/)
  })

  it('registers the codex provider with valid config', async () => {
    const ctx = new Context()
    await ctx.plugin(ExternalSessions)
    expect(() => { apply(ctx, fullConfig()) }).not.toThrow()
    expect(ctx.get('mcpGateway')).toBeUndefined()
    expect(ctx.externalSessions.getProvider('codex')?.provider).toBe('codex')
    expect(ctx.externalSessions.getProvider('codex')?.modelDirectory).toBe('provider')
    await ctx.fiber.dispose()
  })

  it('published provider code loads without a runtime MCP gateway import', async () => {
    const emitted = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
    expect(emitted).not.toContain('@deepseek-ai/dsh-mcp-gateway')
  })
})
