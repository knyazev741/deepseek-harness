/**
 * Keyless real-product Web proof for the opt-in Codex mode.
 *
 * Loader composes the shipped Web and Web-Codex layers, while the pinned
 * Codex app-server talks to a loopback Responses SSE fixture. The only fake
 * identity is the wrapper's local account/read answer; thread, model, turn,
 * approval, MCP, compaction, and resume traffic all use the real products.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { codexStateRoot } from '../../../packages/external/external-session-codex/src/index.ts'
import {
  startResponsesFixture,
  type ResponsesFixture,
} from '../../../packages/external/external-session-codex/tests/responses-fixture.ts'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  type LaunchOptions,
  type WebScaffold,
  watchConsole,
  webSnapshotMode,
} from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

const WEB_CODEX_PATCH = resolve('packages/bundle/web-codex/cordis.patch.yml')
const FIXTURE_OVERLAY = resolve('apps/web/tests/fixtures/external-codex.overlay.yml')
const CODEX_WRAPPER = resolve('apps/web/tests/fixtures/external-codex-app-server.mjs')
const CODEX_BIN = join(
  resolve('packages/external/external-session-codex/node_modules/@openai/codex'),
  'bin/codex.js',
)
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/external-codex-session', import.meta.url))
const MODE_PICKER_EXPECTED = join(SNAPSHOT_DIR, 'mode-picker.expected.md')
const LIVE_EXPECTED = join(SNAPSHOT_DIR, 'live.expected.md')
const TRANSCRIPT_EXPECTED = join(SNAPSHOT_DIR, 'transcript.expected.md')
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const CODEX_MODEL_LABEL = 'GPT-5.6-Sol'
const COMMAND = process.platform === 'win32'
  ? 'cmd /c type nul > approval-side-effect'
  : 'touch approval-side-effect'
const APPROVAL_ARGS = {
  cmd: COMMAND,
  sandbox_permissions: 'require_escalated',
  justification: 'exercise the Web Codex approval bridge',
}
const FIXTURE_SCRIPT = [
  { kind: 'advertisedFunctionCall' as const, choices: [{ name: 'exec_command', arguments: APPROVAL_ARGS }] },
  {
    kind: 'codexMcpCall' as const,
    namespace: 'mcp__dsh_harness',
    name: 'fixture_allowed',
    arguments: {},
  },
  { kind: 'complete' as const, text: 'FIRST_TURN_COMMITTED' },
  { kind: 'complete' as const, text: 'COMPACTION_SUMMARY' },
  { kind: 'complete' as const, text: 'SECOND_TURN_COMMITTED' },
]

interface Tripwire {
  warnings: string[]
  consoleErrors: string[]
  pageErrors: string[]
  requestFailures: string[]
}

function launchOptions(shared: Partial<LaunchOptions> = {}): LaunchOptions {
  return {
    extraOverlayPaths: [WEB_CODEX_PATCH, FIXTURE_OVERLAY],
    moduleFallbackAnchors: [resolve('packages/bundle/web-codex/package.json')],
    ...shared,
  }
}

async function withCodexEnvironment<T>(
  fixture: ResponsesFixture,
  traceFile: string,
  run: () => Promise<T>,
): Promise<T> {
  const environment = {
    DSH_CODEX_COMMAND: CODEX_WRAPPER,
    DSH_CODEX_RESPONSES_URL: fixture.baseUrl,
    DSH_CODEX_BIN: CODEX_BIN,
    DSH_CODEX_TRACE_FILE: traceFile,
  }
  const original = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  try {
    return await run()
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
}

interface CodexTraceFrame {
  readonly direction: 'request' | 'response'
  readonly frame: Record<string, unknown>
}

async function readCodexTrace(traceFile: string): Promise<CodexTraceFrame[]> {
  const contents = await readFile(traceFile, 'utf8')
  return contents.split('\n').filter(line => line.length > 0).map((line) => {
    const frame = JSON.parse(line) as unknown
    if (frame === null || typeof frame !== 'object') throw new Error('Codex trace frame is not an object')
    const record = frame as Record<string, unknown>
    if (record.direction !== 'request' && record.direction !== 'response') {
      throw new Error('Codex trace frame has an invalid direction')
    }
    if (record.frame === null || typeof record.frame !== 'object') {
      throw new Error('Codex trace frame payload is not an object')
    }
    return {
      direction: record.direction,
      frame: record.frame as Record<string, unknown>,
    }
  })
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const nested = (value as Record<string, unknown>)[key]
  return nested !== null && typeof nested === 'object'
    ? nested as Record<string, unknown>
    : undefined
}

function providerThreadIdFromStart(
  trace: readonly CodexTraceFrame[],
  start: CodexTraceFrame,
): string | undefined {
  const requestId = start.frame.id
  if (typeof requestId !== 'string') return undefined
  for (const entry of trace) {
    if (entry.direction !== 'response' || entry.frame.id !== requestId) continue
    const resultThread = nestedRecord(nestedRecord(entry.frame, 'result'), 'thread')
    const candidate = resultThread?.id
    if (typeof candidate === 'string') return candidate
  }
  return undefined
}

function registerFixtureTool(context: Context): void {
  context.tools.register(defineContentToolFixture({
    name: 'fixture_allowed',
    description: 'Deterministic allowlisted MCP fixture tool.',
    parameters: {},
    externalEligibility: 'allow',
    async execute() {
      return [{ type: 'text' as const, text: 'FIXTURE_MCP_ALLOWED' }]
    },
  }))
}

function captureSpawnSpecs(scaffold: WebScaffold): SubprocessSpawnSpec[] {
  const specs: SubprocessSpawnSpec[] = []
  const spawn = scaffold.ctx.subprocess.spawn.bind(scaffold.ctx.subprocess)
  vi.spyOn(scaffold.ctx.subprocess, 'spawn').mockImplementation((spec) => {
    specs.push(spec)
    return spawn(spec)
  })
  return specs
}

function codexSession(scaffold: WebScaffold) {
  return scaffold.ctx.sessions.list().find(session => session.header.mode === 'codex')
}

function transcriptProjection(session: ReturnType<typeof codexSession>): string {
  if (session === undefined) return ''
  return session.events.flatMap((event) => {
    switch (event.type) {
      case 'external/session-started':
        return [`${event.type} provider=${event.data.provider} model=${event.data.model ?? ''}`]
      case 'external/message-added':
        return [`${event.type} role=${event.data.role} text=${event.data.text}`]
      case 'external/tool-call':
        return [`${event.type} name=${event.data.name}`]
      case 'external/tool-result':
        return [`${event.type} name=${event.data.name ?? ''} error=${event.data.isError}`]
      case 'external/permission-asked':
        return [`${event.type} title=${event.data.title} options=${event.data.options.join('|')}`]
      case 'external/permission-decided':
        return [`${event.type} outcome=${event.data.outcome}`]
      case 'external/compaction-noticed':
        return [`${event.type} notice=${event.data.notice}`]
      case 'external/model-switched':
        return [`${event.type} model=${event.data.model}`]
      case 'external/turn-ended':
        return [`${event.type} reason=${event.data.stopReason}`]
      default:
        return []
    }
  }).join('\n')
}

async function mcpClientFor(
  scaffold: WebScaffold,
  sessionId: SessionId,
  spawnSpecs: readonly SubprocessSpawnSpec[],
): Promise<Client> {
  const stateRoot = codexStateRoot(join(scaffold.harnessHome, 'external-codex'), String(sessionId))
  const config = await readFile(join(stateRoot, 'config.toml'), 'utf8')
  const url = config.match(/^url = "([^"]+)"$/mu)?.[1]
  const token = [...spawnSpecs].reverse().map(spec => spec.env?.DSH_MCP_BEARER_TOKEN)
    .find((value): value is string => value !== undefined)
  if (url === undefined || token === undefined) throw new Error('Codex MCP lease was not captured')
  const client = new Client({ name: 'web-codex-e2e', version: '1.0.0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }) as unknown as Parameters<Client['connect']>[0])
  return client
}

function assertNoBrowserErrors(tripwires: readonly Tripwire[]): void {
  expect(tripwires.flatMap(tripwire => tripwire.warnings)).toEqual([])
  expect(tripwires.flatMap(tripwire => tripwire.consoleErrors)).toEqual([])
  expect(tripwires.flatMap(tripwire => tripwire.pageErrors)).toEqual([])
  expect(tripwires.flatMap(tripwire => tripwire.requestFailures)).toEqual([])
}

/** Await one durable terminal event from an external provider turn. */
function whenExternalTurnSettled(scaffold: WebScaffold, sessionId: SessionId, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error(`no external turn/end within ${timeoutMs}ms`))
    }, timeoutMs)
    const off = scaffold.ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId || event.type !== 'external/turn-ended') return
      clearTimeout(timer)
      off()
      void scaffold.ctx.sessions.flush(session).then(() => { resolve() }, reject)
    })
  })
}

/** Answer the generic question composer used by external permission bridges. */
async function answerExternalPermission(page: Page, label: string): Promise<void> {
  const composer = page.locator('[data-question-key]').last()
  await composer.waitFor({ timeout: 60_000 })
  const option = composer.getByRole('radio', { name: label, exact: true })
  await option.click()
  await option.press('Enter')
}

describe('web e2e: interactive Codex mode', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let browserContext: BrowserContext
  let page: Page
  let fixture: ResponsesFixture
  let sessionId: SessionId
  let spawnSpecs: SubprocessSpawnSpec[]
  let tripwire: Tripwire
  let traceRoot: string
  let traceFile: string
  const tripwires: Tripwire[] = []

  beforeAll(async () => {
    await mkdir(SNAPSHOT_DIR, { recursive: true })
    traceRoot = await mkdtemp(join(tmpdir(), 'dsh-external-codex-web-trace-'))
    traceFile = join(traceRoot, 'app-server.jsonl')
    fixture = await startResponsesFixture(FIXTURE_SCRIPT, {
      eventDelayMs: 1_000,
      allowStatelessContinuation: true,
    })
    await withCodexEnvironment(fixture, traceFile, async () => {
      scaffold = await launchWebScaffold(launchOptions({ retainWorld: true }))
    })
    registerFixtureTool(scaffold.ctx)
    spawnSpecs = captureSpawnSpecs(scaffold)
    browser = await chromium.launch()
    browserContext = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    page = await browserContext.newPage()
    tripwire = watchConsole(page)
    tripwires.push(tripwire)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    try { fixture?.assertConsumed() } catch (error: unknown) { failures.push(error) }
    await page?.close().catch((error: unknown) => failures.push(error))
    await browserContext?.close().catch((error: unknown) => failures.push(error))
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    try { assertNoBrowserErrors(tripwires) } catch (error: unknown) { failures.push(error) }
    await fixture?.close().catch((error: unknown) => failures.push(error))
    await rm(traceRoot, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Codex Web e2e cleanup failed')
  })

  it('offers Codex in the assembled mode picker', async () => {
    await page.getByRole('button', { name: /DSH Agent/ }).click()
    const codex = page.getByRole('menuitem', { name: 'Codex' })
    await codex.waitFor({ state: 'visible', timeout: 30_000 })
    expect(await codex.count()).toBe(1)
    if (MODE !== 'record') {
      await compareOrRefreshGolden(
        MODE_PICKER_EXPECTED,
        await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd),
        MODE,
      )
    }
    await page.keyboard.press('Escape')
  }, 60_000)

  it('creates Codex without a native Agent and selects model plus effort', async () => {
    const before = new Set(scaffold.ctx.sessions.list().map(session => String(session.id)))
    await page.getByRole('button', { name: /DSH Agent/ }).click()
    await page.getByRole('menuitem', { name: 'Codex' }).click()
    const modelSeat = page.getByRole('button', { name: /Model/ }).last()
    await modelSeat.waitFor({ state: 'visible', timeout: 30_000 })
    await modelSeat.click()
    await page.getByRole('menuitem', { name: new RegExp(`^${CODEX_MODEL_LABEL}`) }).click()

    await expect.poll(
      () => scaffold.ctx.sessions.list().find(session => !before.has(String(session.id)) && session.header.mode === 'codex'),
      { timeout: 30_000 },
    ).not.toBeUndefined()
    const session = codexSession(scaffold)
    if (session === undefined) throw new Error('Codex session was not created')
    sessionId = session.id
    expect(scaffold.ctx.agents.get(session.id)).toBeUndefined()

    const currentModel = page.getByRole('button', { name: `Select model, current ${CODEX_MODEL_LABEL}` })
    await currentModel.waitFor({ state: 'visible', timeout: 30_000 })
    await currentModel.click()
    await page.getByRole('menuitem', { name: /^Effort/ }).click()
    await page.getByRole('menuitemradio', { name: /^high/i }).click()
    await expect.poll(
      () => scaffold.ctx.sessions.get(sessionId)?.events.some(event => event.type === 'external/model-switched'),
      { timeout: 30_000 },
    ).toBe(true)
  }, 90_000)

  it('streams then commits a response, gates a command, and records its file', async () => {
    const input = page.locator('textarea:enabled').last()
    await input.waitFor({ timeout: 15_000 })
    const settled = whenExternalTurnSettled(scaffold, sessionId, 120_000)
    await input.fill('Run the fixture command, then report the completed marker.')
    await input.press('Enter')
    await answerExternalPermission(page, 'Allow')
    await expect.poll(() => fixture.requests.length, { timeout: 30_000 }).toBeGreaterThan(1)
    const liveSeat = page.locator('[data-testid="external-live-seat"]')
    await liveSeat.waitFor({ state: 'attached', timeout: 60_000 })
    if (MODE !== 'record') {
      await compareOrRefreshGolden(
        LIVE_EXPECTED,
        await captureStableAria(page, '[data-testid="external-live-seat"]', scaffold.workspaceCwd),
        MODE,
      )
    }
    await page.getByText('FIRST_TURN_COMMITTED', { exact: true }).waitFor({ timeout: 60_000 })
    await settled
    await expect.poll(() => page.locator('[data-testid="external-live-seat"]').count(), { timeout: 30_000 }).toBe(0)
    expect(existsSync(join(scaffold.workspaceCwd, 'workspace', 'approval-side-effect'))).toBe(true)
    expect(fixture.requests[0]?.body).toMatchObject({ reasoning: { effort: 'high' } })
  }, 180_000)

  it('routes the allowlisted MCP call through Codex and rejects an unlisted gateway call', async () => {
    const client = await mcpClientFor(scaffold, sessionId, spawnSpecs)
    try {
      await expect(client.listTools()).resolves.toMatchObject({ tools: [{ name: 'fixture_allowed' }] })
      await expect(client.callTool({ name: 'fixture_unlisted', arguments: {} })).rejects.toThrow()
      const events = scaffold.ctx.sessions.get(sessionId)?.events ?? []
      expect(events.some(event => event.type === 'external/tool-call' && event.data.name === 'fixture_allowed')).toBe(true)
      expect(events.some(event => event.type === 'external/tool-result'
        && event.data.name === 'fixture_allowed' && !event.data.isError)).toBe(true)
    } finally {
      await client.close()
    }
  }, 90_000)

  it('compacts through the Web command route before the Host restart', async () => {
    const input = page.locator('textarea:enabled').last()
    await input.fill('/compact')
    await input.press('Enter')
    await expect.poll(
      () => scaffold.ctx.sessions.get(sessionId)?.events.some(event => event.type === 'external/compaction-noticed'),
      { timeout: 60_000 },
    ).toBe(true)
    await page.getByText(/external agent compacted/i).waitFor({ timeout: 30_000 })
  }, 90_000)

  it('restarts the Host, resumes the same thread, and submits a second turn', async () => {
    const shared = {
      workspaceCwd: scaffold.workspaceCwd,
      persistenceRoot: scaffold.persistenceRoot,
      harnessHome: scaffold.harnessHome,
      webPort: Number(new URL(scaffold.baseUrl).port),
    }
    await page.close()
    await scaffold.close()
    await withCodexEnvironment(fixture, traceFile, async () => {
      scaffold = await launchWebScaffold(launchOptions(shared))
    })
    registerFixtureTool(scaffold.ctx)
    spawnSpecs = captureSpawnSpecs(scaffold)
    page = await browserContext.newPage()
    tripwire = watchConsole(page)
    tripwires.push(tripwire)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const restartedTripwire = tripwires.at(-1)
    if (restartedTripwire === undefined) throw new Error('restarted page tripwire was not retained')
    await page.evaluate(() => { console.error('__task9_restarted_page_tripwire__') })
    expect(restartedTripwire.consoleErrors).toContain('__task9_restarted_page_tripwire__')
    restartedTripwire.consoleErrors.splice(
      restartedTripwire.consoleErrors.indexOf('__task9_restarted_page_tripwire__'),
      1,
    )
    const workspaceChooser = page.getByRole('textbox', { name: 'Choose workspace' })
    if (await workspaceChooser.count() > 0 && await workspaceChooser.first().isVisible()) {
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
    } else {
      await page.locator('textarea:enabled').last().waitFor({ timeout: 30_000 })
    }
    await page.getByText('FIRST_TURN_COMMITTED', { exact: true }).waitFor({ timeout: 30_000 })

    const input = page.locator('textarea:enabled').last()
    const settled = whenExternalTurnSettled(scaffold, sessionId, 120_000)
    await input.fill('Continue the resumed Codex thread and report the second marker.')
    await input.press('Enter')
    await page.locator('[data-testid="external-live-seat"]').waitFor({ state: 'attached', timeout: 60_000 })
    await page.getByText('SECOND_TURN_COMMITTED', { exact: true }).waitFor({ timeout: 60_000 })
    await settled
    expect(fixture.requests).toHaveLength(5)
    expect(transcriptProjection(codexSession(scaffold))).toContain('SECOND_TURN_COMMITTED')
    const trace = await readCodexTrace(traceFile)
    const resumedSession = codexSession(scaffold)
    const sessionCwd = resumedSession?.header.cwd
    if (sessionCwd === undefined) throw new Error('resumed Codex session has no workspace cwd')
    const threadStarts = trace.filter((entry) => {
      if (entry.direction !== 'request' || entry.frame.method !== 'thread/start') return false
      return nestedRecord(entry.frame, 'params')?.cwd === sessionCwd
    })
    const threadResumes = trace.filter(entry => entry.direction === 'request' && entry.frame.method === 'thread/resume')
    expect(threadStarts).toHaveLength(1)
    expect(threadResumes).toHaveLength(1)
    const providerThreadId = providerThreadIdFromStart(trace, threadStarts[0]!)
    if (providerThreadId === undefined) throw new Error('thread/start response did not return a provider thread id')
    expect(nestedRecord(threadResumes[0]!.frame, 'params')).toMatchObject({ threadId: providerThreadId })
    const resumedEvents = codexSession(scaffold)?.events ?? []
    expect(resumedEvents.some(event => event.type === 'external/session-started'
      && event.data.providerThreadId === providerThreadId)).toBe(true)
    const mcpStarted = trace.filter((entry) => {
      if (entry.direction !== 'response' || entry.frame.method !== 'item/started') return false
      return nestedRecord(nestedRecord(entry.frame, 'params'), 'item')?.type === 'mcpToolCall'
    })
    expect(mcpStarted).toHaveLength(1)
    expect(nestedRecord(nestedRecord(mcpStarted[0]!.frame, 'params'), 'item')).toMatchObject({
      server: 'dsh_harness',
      tool: 'fixture_allowed',
    })
    const mcpCompleted = trace.filter((entry) => {
      if (entry.direction !== 'response' || entry.frame.method !== 'item/completed') return false
      return nestedRecord(nestedRecord(entry.frame, 'params'), 'item')?.type === 'mcpToolCall'
    })
    expect(mcpCompleted).toHaveLength(1)
    expect(nestedRecord(nestedRecord(mcpCompleted[0]!.frame, 'params'), 'item')).toMatchObject({
      server: 'dsh_harness',
      tool: 'fixture_allowed',
      status: 'completed',
    })
    expect(trace.some((entry) => {
      if (entry.direction !== 'response' || entry.frame.method !== 'mcpServer/startupStatus/updated') return false
      const params = nestedRecord(entry.frame, 'params')
      return params?.name === 'dsh_harness' && params.status === 'ready'
    })).toBe(true)

    await compareOrRefreshGolden(
      UI_EXPECTED,
      await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd),
      MODE,
    )
    await compareOrRefreshGolden(
      TRANSCRIPT_EXPECTED,
      transcriptProjection(codexSession(scaffold)),
      MODE,
    )
    if (MODE !== 'record') {
      await assertFixtureInventory(SNAPSHOT_DIR, ['live.expected.md', 'mode-picker.expected.md', 'transcript.expected.md', 'ui.expected.md'])
    }
  }, 180_000)

  it('kept every browser surface clean and consumed the fixture', () => {
    assertNoBrowserErrors(tripwires)
    fixture.assertConsumed()
  })
})
