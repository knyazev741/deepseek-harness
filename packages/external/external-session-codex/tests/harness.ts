/**
 * Keyless real-product harness for `external-session-codex`: boots a Cordis
 * context with the external-session registry, the local subprocess runtime,
 * and the codex plugin, then drives the provider directly through a recorded
 * bridge. The pinned `@openai/codex` app-server talks to a loopback Responses
 * SSE fixture, so no real API key or network is used.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ExternalSessions from '@deepseek-ai/dsh-external-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ExternalBridgeContext,
  ExternalPermissionDecision,
  ExternalSessionProvider,
} from '@deepseek-ai/dsh-external-session'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { vi } from 'vitest'
import * as codex from '../src/index.ts'
import {
  startResponsesFixture,
  type ResponsesBehavior,
  type ResponsesFixture,
} from './responses-fixture.ts'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const codexBinDir = join(packageRoot, 'node_modules', '.bin')

/** One appended session event or live delta captured by the recorded bridge. */
export interface CodexRecorded {
  readonly events: Array<{ type: string; data: unknown }>
  readonly deltas: Array<{ turnId: string; delta: string }>
  readonly permissionAsks: Array<{ askId: string; title: string; options: readonly string[] }>
}

/** A running keyless harness; {@link start} opens the session, {@link close} tears down. */
export interface CodexTestHarness {
  readonly ctx: Context
  readonly provider: ExternalSessionProvider
  readonly sessionId: SessionId
  readonly recorded: CodexRecorded
  readonly fixture: ResponsesFixture
  readonly handles: SubprocessHandle[]
  readonly workspace: string
  readonly codexHome: string
  /** Set the decision every permission ask resolves with. */
  setPermissionAnswer(decision: ExternalPermissionDecision): void
  /** Open the session on the recorded bridge (provider.start). */
  start(): Promise<void>
  /** Wait until at least `count` events of `type` have been recorded. */
  waitCount(type: string, count: number, timeoutMs?: number): Promise<void>
  /** Wait until the recorded deltas mention `needle`. */
  waitDelta(needle: string, timeoutMs?: number): Promise<void>
  /** Wait until `count` turns have ended (`external/turn-ended`). */
  waitTurns(count: number, timeoutMs?: number): Promise<void>
  /** Tear down the context, fixture, and temp tree. */
  close(): Promise<void>
}

function makeBridge(recorded: CodexRecorded): {
  bridge: ExternalBridgeContext
  setAnswer: (decision: ExternalPermissionDecision) => void
} {
  let answer: ExternalPermissionDecision = 'allowed'
  const bridge: ExternalBridgeContext = {
    appendEvent: (_sessionId, event) => {
      recorded.events.push({ type: event.type, data: event.data })
    },
    requestPermission: async (_sessionId, ask) => {
      recorded.permissionAsks.push({
        askId: ask.askId,
        title: ask.title,
        options: [...ask.options],
      })
      return answer
    },
    streamDelta: (_sessionId, turnId, delta) => {
      recorded.deltas.push({ turnId: String(turnId), delta })
    },
    disposal: new AbortController().signal,
  }
  return {
    bridge,
    setAnswer: (decision) => { answer = decision },
  }
}

function poll(predicate: () => boolean, describe: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${describe}`))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

/**
 * Boot one keyless real-product harness against the pinned Codex fixture.
 * @param script - one Responses behavior per expected model request.
 * @returns the running harness (session not yet started).
 */
export async function startCodexHarness(
  script: readonly ResponsesBehavior[],
): Promise<CodexTestHarness> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-external-codex-'))
  const workspace = join(root, 'workspace')
  const codexHome = join(root, 'codex-home')
  mkdirSync(workspace)
  mkdirSync(codexHome)
  const fixture = await startResponsesFixture(script)
  writeFileSync(join(codexHome, 'config.toml'), [
    'model = "fixture-model"',
    'model_provider = "fixture"',
    'approval_policy = "on-request"',
    'sandbox_mode = "read-only"',
    'disable_response_storage = false',
    'check_for_update_on_startup = false',
    '',
    '[model_providers.fixture]',
    'name = "Fixture Responses"',
    `base_url = "${fixture.baseUrl}"`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
  ].join('\n'))
  const env = {
    OPENAI_API_KEY: 'dsh-fake-openai-key',
    CODEX_HOME: codexHome,
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'xdg'),
    PATH: `${codexBinDir}${delimiter}${process.env.PATH ?? ''}`,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost',
  }
  const ctx = new Context()
  await ctx.plugin(ExternalSessions)
  await ctx.plugin(LocalSubprocessRuntime)

  const handles: SubprocessHandle[] = []
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const handle = spawn(spec)
    handles.push(handle)
    return handle
  })

  await ctx.plugin(codex, { env, disposeGraceMs: 2_000 })
  const provider = ctx.externalSessions.getProvider('codex')
  if (provider === undefined) {
    throw new Error('codex provider did not register')
  }

  const recorded: CodexRecorded = { events: [], deltas: [], permissionAsks: [] }
  const { bridge, setAnswer } = makeBridge(recorded)
  const sessionId = SessionId('external-codex-test-session')

  const harness: CodexTestHarness = {
    ctx,
    provider,
    sessionId,
    recorded,
    fixture,
    handles,
    workspace,
    codexHome,
    setPermissionAnswer: setAnswer,
    start: () => provider.start({ sessionId, provider: 'codex', cwd: workspace }, bridge),
    waitCount: (type, count, timeoutMs = 120_000) => poll(
      () => recorded.events.filter(event => event.type === type).length >= count,
      `${count}x ${type} (saw ${recorded.events.filter(e => e.type === type).length})`,
      timeoutMs,
    ),
    waitDelta: (needle, timeoutMs = 120_000) => poll(
      () => recorded.deltas.some(delta => delta.delta.includes(needle)),
      `delta ${JSON.stringify(needle)}`,
      timeoutMs,
    ),
    waitTurns: (count, timeoutMs = 120_000) => poll(
      () => recorded.events.filter(event => event.type === 'external/turn-ended').length >= count,
      `${count} turns to end`,
      timeoutMs,
    ),
    close: async () => {
      await provider.dispose(sessionId).catch(() => {})
      for (const handle of handles) {
        if (handle.pid > 0) handle.terminate()
        await handle.done.catch(() => {})
      }
      await ctx.fiber.dispose().catch(() => {})
      await fixture.close().catch(() => {})
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
  }
  return harness
}
