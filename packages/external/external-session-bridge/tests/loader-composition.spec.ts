/**
 * REAL-composition boot test for the external-session bridge driver,
 * following the repo REAL-composition policy: a cordis.yml is loaded through
 * the Loader with the external-session family composed (registry, projection,
 * permission bridge, user-questions, and this driver) plus keyless stub
 * plugins for an external provider and the human questioner. It asserts the
 * full mode-aware session lifecycle against the durable session log and the
 * provider lifecycle: session-started recorded, a turn appended, permission
 * resolved through the Task-1 bridge channel, and dispose tearing the provider
 * down. Only the external "child process" is faked — the stub provider is real
 * Loader-composed code.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import ExternalSessions, {
  ExternalTurnId,
  type ExternalBridgeContext,
  type ExternalSessionProvider,
  type ExternalSessionStart,
} from '@deepseek-ai/dsh-external-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as externalPermission from '@deepseek-ai/dsh-external-permission'
import * as bridge from '@deepseek-ai/dsh-external-session-bridge'

/** Module-level provider state the test asserts against. */
const providerState: {
  disposed: boolean
  bridge: ExternalBridgeContext | undefined
} = { disposed: false, bridge: undefined }

/** A keyless stub external provider: no child process, writes the transcript through its bridge. */
const stubProvider: ExternalSessionProvider = {
  provider: 'stub',
  label: 'Stub Agent',
  modelDirectory: 'config',
  async start(request: ExternalSessionStart, bridgeCtx: ExternalBridgeContext): Promise<void> {
    providerState.bridge = bridgeCtx
    bridgeCtx.appendEvent(request.sessionId, {
      type: 'external/session-started',
      data: { provider: 'stub', cwd: request.cwd },
    })
  },
  async prompt(sessionId, _text) {
    providerState.bridge!.appendEvent(sessionId, { type: 'external/turn-started', data: { turnId: 't1' } })
    providerState.bridge!.appendEvent(sessionId, {
      type: 'external/message-added',
      data: { turnId: 't1', role: 'user', text: 'hello' },
    })
    providerState.bridge!.appendEvent(sessionId, {
      type: 'external/message-added',
      data: { turnId: 't1', role: 'agent', text: 'done' },
    })
    providerState.bridge!.appendEvent(sessionId, {
      type: 'external/turn-ended',
      data: { turnId: 't1', stopReason: 'completed' },
    })
    return { turnId: ExternalTurnId('t1') }
  },
  interrupt() {},
  async compact() {},
  async listModels() { return [] },
  async setModel() {},
  async dispose() { providerState.disposed = true },
}

/** Keyless Loader-composed helper plugin: register the stub provider. */
export const StubProviderPlugin = {
  name: 'stub-external-provider',
  inject: ['externalSessions'],
  apply(ctx: Context): void {
    ctx.externalSessions.registerProvider(stubProvider)
  },
}

/** Keyless Loader-composed helper plugin: answer every ask with the first option (allowed). */
export const StubQuestionsPlugin = {
  name: 'stub-user-questions-provider',
  inject: ['userQuestions'],
  apply(ctx: Context): void {
    ctx.userQuestions.registerProvider({
      async ask(request) {
        return { answers: [{ id: request.questions[0]?.id ?? 'missing', selected: ['allow'] }] }
      },
    })
  },
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  providerState.disposed = false
  providerState.bridge = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-external-bridge-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjection],
    ['@deepseek-ai/dsh-external-session', ExternalSessions],
    ['@deepseek-ai/dsh-user-questions', UserQuestionService],
    ['@deepseek-ai/dsh-external-permission', externalPermission],
    ['@deepseek-ai/dsh-external-session-bridge', bridge],
    ['stub:provider', StubProviderPlugin],
    ['stub:questions', StubQuestionsPlugin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

const COMPOSITION = [
  "- name: '@deepseek-ai/dsh-session'",
  "- name: '@deepseek-ai/dsh-session-projection'",
  "- name: '@deepseek-ai/dsh-external-session'",
  "- name: '@deepseek-ai/dsh-user-questions'",
  "- name: '@deepseek-ai/dsh-external-permission'",
  "- name: '@deepseek-ai/dsh-external-session-bridge'",
  "- name: 'stub:provider'",
  "- name: 'stub:questions'",
]

/** Flush the microtask/macrotask boundary so an async provider start settles. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('external-session-bridge REAL composition', () => {
  it('drives an external-mode session: started, turn, permission, and dispose teardown', async () => {
    const ctx = await loadYaml(COMPOSITION)

    // A host session created in mode `stub` — the durable header carries the
    // mode; the gateway would stamp it, but the store accepts the same meta.
    const session = ctx.sessions.create(SessionId('e1'), { meta: { cwd: '/tmp', mode: 'stub' } })
    expect(session.header.mode).toBe('stub')
    await flush()

    // The transcript projection unit was registered by the driver.
    expect(Object.keys(ctx.sessionProjections.snapshot(session).values)).toContain('external/transcript')

    // session-started recorded in the durable log.
    expect(session.events.map(event => event.type)).toContain('external/session-started')

    // A turn appended through the provider bridge lands in the log.
    await ctx.externalSessions.prompt(session.id, 'hello')
    expect(session.events.map(event => event.type)).toContain('external/message-added')
    expect(session.events.map(event => event.type)).toContain('external/turn-ended')

    // Permission resolves through the Task-1 bridge → external-permission
    // channel → stub user-questions human answerer.
    await expect(providerState.bridge!.requestPermission(session.id, {
      askId: 'ask-1',
      title: 'proceed?',
      options: ['allow', 'reject'],
    })).resolves.toBe('allowed')

    // Disposing the context tears the provider (and thus its process tree)
    // down via the driver's session/disposed reaction.
    await ctx.fiber.dispose()
    expect(providerState.disposed).toBe(true)
  })

  it('leaves a native (no-mode) session untouched', async () => {
    const ctx = await loadYaml(COMPOSITION)
    const session = ctx.sessions.create(SessionId('n1'), { meta: { cwd: '/tmp' } })
    expect(session.header.mode).toBeUndefined()
    await flush()
    // No external activity recorded, no error, and the provider was never started.
    expect(session.events).toEqual([])
    expect(providerState.bridge).toBeUndefined()
  })
})
