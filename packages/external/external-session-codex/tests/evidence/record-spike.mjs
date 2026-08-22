#!/usr/bin/env node
/**
 * Throwaway evidence recorder for the pinned codex app-server 0.147.0 wire.
 *
 * This is a spike tool, not a product test. It spawns the real `codex
 * app-server --stdio` native binary, drives it over newline-delimited JSON-RPC
 * against an in-process OpenAI Responses SSE fixture (the same harness shape
 * as packages/subagent/subagent-codex/tests/real-product.spec.ts), and dumps
 * every observed frame into the JSON files described by ./README.md.
 *
 * Handle a native binary path (see README "environment") as the first
 * argument, or it resolves one from the subagent-codex devDependency.
 *
 * Usage:
 *   node record-spike.mjs [native-binary-path]
 *
 * Writes in place:
 *   thread-persistence.json, turn-notifications.json, approvals.json,
 *   models.json, compact.json
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const subagentCodexPkg = resolve(join(here, '../../../../subagent/subagent-codex'))

const JSONRPC = '2.0'

/** Resolve the native codex binary: explicit arg, else the subagent-codex devDependency platform package. */
function resolveBinary(platform = process.platform, arch = process.arch) {
  const byTarget = {
    'darwin-arm64': 'codex-darwin-arm64',
    'darwin-x64': 'codex-darwin-x64',
    'linux-x64': 'codex-linux-x64',
    'linux-arm64': 'codex-linux-arm64',
  }
  const pkgName = byTarget[`${platform}-${arch}`]
  if (pkgName === undefined) {
    throw new Error(`no packaged codex binary for ${platform}-${arch}; pass a native path explicitly`)
  }
  const vendorRoot = join(
    subagentCodexPkg,
    'node_modules',
    '@openai',
    pkgName,
    'vendor',
  )
  const exe = platform === 'win32' ? 'codex.exe' : 'codex'
  const candidate = process.platform === 'win32'
    ? join(vendorRoot, `x86_64-pc-windows-msvc`, 'bin', exe)
    : join(vendorRoot, `${arch}-apple-${platform === 'darwin' ? 'darwin' : 'unknown-linux-musl'}`, 'bin', exe)
  return existsSync(candidate) ? candidate : join(vendorRoot, 'aarch64-apple-darwin', 'bin', 'codex')
}

/**
 * Minimal OpenAI Responses SSE fixture plus JSON-RPC frame collector.
 * @param {object} opts
 * @param {Array<object>} opts.script - one behavior per Responses request.
 * @param {Array<object>} opts.frames - shared frame log.
 */
async function startFixture(script, frames, fallbackText) {
  const behaviors = [...script]
  const requests = []
  const open = new Set()
  const server = createServer((req, res) => {
    open.add(res)
    res.on('close', () => open.delete(res))
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      requests.push({ path: req.url, body: parsed })
      frames.push({
        kind: 'fixture', note: 'Responses model request seen by the fixture (trimmed)',
        url: req.url, body: summarizeModelRequest(parsed),
      })
      const behavior = behaviors.shift()
      if (behavior === undefined) {
        if (fallbackText !== undefined) {
          frames.push({
            kind: 'fixture', note: 'Responses model request from auto-compaction (fallback complete)',
            url: req.url, body: summarizeModelRequest(parsed),
          })
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          for (const event of completeEvents(fallbackText)) res.write(`data: ${JSON.stringify(event)}\n\n`)
          res.end('data: [DONE]\n\n')
          return
        }
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'fixture script exhausted' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (behavior.kind === 'hold') return
      const events = behavior.kind === 'complete'
        ? completeEvents(behavior.text)
        : functionCallEvents(behavior.name, behavior.arguments)
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolvePort, rejectPort) => {
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => { server.off('error', rejectPort); resolvePort() })
  })
  const port = server.address().port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    async close() {
      for (const r of open) r.destroy()
      await new Promise((r) => { server.close(r); server.closeAllConnections() })
    },
  }
}

function responseObject(text) {
  const message = {
    id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', annotations: [], logprobs: [], text }],
  }
  return {
    id: 'resp_fixture', object: 'response', created_at: 1, status: 'completed',
    background: false, error: null, incomplete_details: null, instructions: null,
    max_output_tokens: null, max_tool_calls: null, model: 'fixture-model',
    output: [message], parallel_tool_calls: true, previous_response_id: null,
    prompt_cache_key: null, prompt_cache_retention: null,
    reasoning: { effort: null, summary: null }, safety_identifier: null,
    service_tier: 'default', store: false, temperature: null,
    text: { format: { type: 'text' }, verbosity: 'medium' },
    tool_choice: 'auto', tools: [], top_logprobs: 0, top_p: null,
    truncation: 'disabled',
    usage: {
      input_tokens: 10, input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 11,
    },
    user: null, metadata: {},
  }
}

function completeEvents(text) {
  const completed = responseObject(text)
  const message = completed.output[0]
  const part = message.content[0]
  return [
    { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: text, logprobs: [] },
    { type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text, logprobs: [] },
    { type: 'response.content_part.done', item_id: message.id, output_index: 0, content_index: 0, part },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: completed },
  ]
}

function functionCallEvents(name, args) {
  const argumentsText = JSON.stringify(args)
  const item = {
    id: 'fc_fixture', type: 'function_call', status: 'completed', name,
    arguments: argumentsText, call_id: 'call_fixture',
  }
  const completed = { ...responseObject(''), output: [item], usage: {
    input_tokens: 10, input_tokens_details: { cached_tokens: 0 },
    output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 } }
  return [
    { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: argumentsText },
    { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: argumentsText },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: completed },
  ]
}

/** JSON-RPC client over the codex stdio process; records every frame. */
class RpcClient {
  constructor(child, frames) {
    this.child = child
    this.frames = frames
    this.buf = ''
    this.pending = new Map()
    this.serverRequests = []
    this.nextId = 1
    child.stdout.on('data', (d) => this.#onData(d))
  }
  #onData(d) {
    this.buf += d.toString()
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      if (!line.trim()) continue
      const frame = JSON.parse(line)
      this.frames.push({ kind: 'server', frame: clean(frame) })
      if (frame.id !== undefined && frame.method !== undefined) {
        this.serverRequests.push(frame)
        this.#handleServerRequest(frame)
      } else if (frame.id !== undefined) {
        const waiter = this.pending.get(frame.id)
        if (waiter) { this.pending.delete(frame.id); waiter(frame) }
      }
    }
  }
  async #handleServerRequest(frame) {
    const { method, params } = frame
    const respond = (result) => {
      const out = { jsonrpc: JSONRPC, id: frame.id, result }
      this.frames.push({ kind: 'client', note: `response to server ${method}`, frame: clean(out) })
      this.child.stdin.write(`${JSON.stringify(out)}\n`)
    }
    const decision = this.approvalDecisions?.shift()
    switch (method) {
      case 'item/commandExecution/requestApproval':
        respond({ decision })
        break
      case 'item/fileChange/requestApproval':
        respond({ decision: 'decline' })
        break
      case 'item/permissions/requestApproval':
        respond({ permissions: {}, scope: 'turn' })
        break
      case 'item/tool/requestUserInput':
        respond({ answers: {} })
        break
      case 'mcpServer/elicitation/request':
        respond({ action: 'decline', content: null, _meta: null })
        break
      default:
        respond({ error: { code: -32601, message: `recorder: no canned response for ${method}` } })
    }
  }
  send(method, params) {
    const id = this.nextId++
    const out = { jsonrpc: JSONRPC, id, method, params }
    this.frames.push({ kind: 'client', frame: clean(out) })
    this.child.stdin.write(`${JSON.stringify(out)}\n`)
    return new Promise((resolve, reject) => {
      this.pending.set(id, (resp) => resp.result ? resolve(resp) : reject(resp.error))
    })
  }
  notify(method, params) {
    const out = { jsonrpc: JSONRPC, method, params }
    this.frames.push({ kind: 'client', note: `notification ${method}`, frame: clean(out) })
    this.child.stdin.write(`${JSON.stringify(out)}\n`)
  }
}

/** Trim a Responses request body to a compact, stable evidence summary. */
function summarizeModelRequest(body) {
  const out = { model: body.model }
  if (Array.isArray(body.input)) {
    out.input = body.input.flatMap((item) => {
      if (item === null || typeof item !== 'object') return []
      const text = Array.isArray(item.content)
        ? item.content.flatMap((part) =>
          part !== null && typeof part === 'object' && typeof part.text === 'string'
            ? [part.text]
            : [])
        : []
      return [{ role: item.role ?? 'assistant', text }]
    })
  }
  if (Array.isArray(body.tools)) {
    out.toolNames = body.tools.flatMap((tool) => {
      if (tool === null || typeof tool !== 'object') return []
      if (tool.type === 'function' && typeof tool.name === 'string') return [tool.name]
      if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
        return tool.tools.flatMap((t) =>
          t !== null && typeof t === 'object' && t.type === 'function' && typeof t.name === 'string'
            ? [`${tool.name}/${t.name}`]
            : [])
      }
      return [tool.type]
    })
  }
  return out
}

/** Redact volatile values (ids, timestamps, absolute paths) for stable diffs. */
function clean(value, budget = new Map()) {
  if (Array.isArray(value)) return value.map((v) => clean(v, budget))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === 'id') {
        if (typeof v === 'string' && /^[0-9a-f]{8}-/i.test(v)) {
          const n = budget.get(v) ?? budget.size + 1
          budget.set(v, n)
          out[k] = `<volatile:id#${n}>`
          continue
        }
      }
      if ((k === 'cwd' || k === 'absolute_path' || /Path$/.test(k)) && typeof v === 'string') {
        const n = budget.get(v) ?? budget.size + 1
        budget.set(v, n)
        out[k] = `<volatile:path#${n}>`
        continue
      }
      if ((k === 'startedAtMs' || k === 'emittedAtMs' || k === 'startedAt' || k === 'completedAt' || k === 'createdAt') && typeof v === 'number') {
        out[k] = '<volatile:ms>'
        continue
      }
      out[k] = clean(v, budget)
    }
    return out
  }
  return value
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function initialize(rpc) {
  await rpc.send('initialize', {
    clientInfo: { name: 'dsh-evidence', title: 'DSH Evidence Recorder', version: '0.0.1' },
    capabilities: { experimentalApi: false, requestAttestation: false },
  })
  rpc.notify('initialized')
}

async function launch(script, { approvalDecisions = [], sandboxMode = 'read-only', reuse, fallbackText } = {}) {
  const frames = []
  const fixture = await startFixture(script, frames, fallbackText)
  const root = reuse?.cwd ?? mkdtempSync(join(tmpdir(), 'codex-evidence-'))
  const home = reuse?.home ?? join(root, 'home')
  const xdg = reuse?.xdg ?? join(root, 'xdg')
  mkdirSync(home, { recursive: true })
  mkdirSync(xdg, { recursive: true })
  writeFileSync(join(home, 'config.toml'), [
    'model = "fixture-model"',
    'model_provider = "fixture"',
    'approval_policy = "on-request"',
    `sandbox_mode = "${sandboxMode}"`,
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
    ...process.env,
    OPENAI_API_KEY: 'dsh-fake-openai-key',
    CODEX_HOME: home,
    HOME: root,
    XDG_CONFIG_HOME: xdg,
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost',
  }
  const child = spawn(BINARY, ['app-server', '--stdio'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.on('data', () => {})
  const rpc = new RpcClient(child, frames)
  rpc.approvalDecisions = approvalDecisions
  const close = async () => {
    try { child.stdin.end() } catch {}
    child.kill('SIGTERM')
    await new Promise((r) => { child.on('exit', r); setTimeout(r, 500).unref() })
    await fixture.close()
  }
  return { frames, rpc, child, close, home, cwd: root }
}

const BINARY = process.argv[2] ?? resolveBinary()

async function main() {
  const out = { codexVersion: '0.147.0' }

  // ---- thread persistence ----
  {
    const a = await launch([{ kind: 'complete', text: 'TURN_ONE_FIXTURE' }, { kind: 'complete', text: 'TURN_TWO_FIXTURE' }])
    await initialize(a.rpc)
    const t0 = await a.rpc.send('thread/start', { cwd: a.cwd, ephemeral: false })
    const threadId = t0.result.thread.id
    await a.rpc.send('turn/start', { threadId, input: [{ type: 'text', text: 'FIRST_TURN_TEXT', text_elements: [] }] })
    await waitForTurnEnd(a)
    await a.rpc.send('turn/start', { threadId, input: [{ type: 'text', text: 'SECOND_TURN_ON_SAME_THREAD', text_elements: [] }] })
    await waitForTurnEnd(a)
    await a.close()
    // Cold reattach: fresh process against the persisted CODEX_HOME + cwd.
    const b = await launch([], { reuse: { home: a.home, cwd: a.cwd } })
    await initialize(b.rpc)
    const resume = await b.rpc.send('thread/resume', { threadId })
    await b.close()
    out['thread-persistence'] = { frames: [...a.frames, { kind: 'note', note: 'wire restarted; fresh app-server resume of the persisted thread' }, ...b.frames], threadId }
  }

  // ---- turn notifications (plus a hold+interrupt turn) ----
  {
    const { frames, rpc, close, cwd } = await launch([
      { kind: 'complete', text: 'NOTIFICATION_FAMILY_SENTINEL' },
      { kind: 'hold' },
    ])
    await initialize(rpc)
    const t0 = await rpc.send('thread/start', { cwd, ephemeral: true })
    const threadId = t0.result.thread.id
    await rpc.send('turn/start', { threadId, input: [{ type: 'text', text: 'DELTA_TURN', text_elements: [] }] })
    await waitForTurnEnd(rpc)
    // Second turn held open by the fixture, then interrupted locally.
    const t2 = await rpc.send('turn/start', { threadId, input: [{ type: 'text', text: 'INTERRUPTED_TURN', text_elements: [] }] })
    const turnId = t2.result.turn.id
    await wait(300)
    await rpc.send('turn/interrupt', { threadId, turnId })
    await waitForTurnEnd(rpc)
    await close()
    out['turn-notifications'] = { frames, threadId }
  }

  // ---- approvals (accept + decline arms) ----
  {
    const cmd = process.platform === 'win32' ? 'cmd /c type nul > approval-side-effect' : 'true'
    const { frames, rpc, close, cwd } = await launch([
      { kind: 'functionCall', name: 'shell_command', arguments: { command: cmd, sandbox_permissions: 'require_escalated', justification: 'evidence accept arm' } },
      { kind: 'complete', text: 'AFTER_ALLOW' },
      { kind: 'functionCall', name: 'shell_command', arguments: { command: cmd, sandbox_permissions: 'require_escalated', justification: 'evidence decline arm' } },
      { kind: 'complete', text: 'AFTER_DECLINE' },
    ], { approvalDecisions: ['accept', 'decline'] })
    await rpc.send('initialize', { clientInfo: { name: 'dsh-evidence', title: 'DSH Evidence Recorder', version: '0.0.1' }, capabilities: { experimentalApi: false, requestAttestation: false } })
    rpc.notify('initialized')
    const t0 = await rpc.send('thread/start', { cwd, ephemeral: false })
    const threadId = t0.result.thread.id
    await rpc.send('turn/start', { threadId, input: [{ type: 'text', text: 'APPROVAL_ACCEPT_TURN', text_elements: [] }] })
    await waitForTurnEnd(rpc)
    await rpc.send('turn/start', { threadId, input: [{ type: 'text', text: 'APPROVAL_DECLINE_TURN', text_elements: [] }] })
    await waitForTurnEnd(rpc)
    await close()
    out['approvals'] = { frames, threadId }
  }

  // ---- models ----
  {
    const { frames, rpc, close } = await launch([])
    await rpc.send('initialize', { clientInfo: { name: 'dsh-evidence', title: 'DSH Evidence Recorder', version: '0.0.1' }, capabilities: { experimentalApi: false, requestAttestation: false } })
    rpc.notify('initialized')
    await rpc.send('model/list', {})
    await close()
    out['models'] = { frames }
  }

  // ---- compact ----
  {
    const { frames, rpc, close, cwd } = await launch([{ kind: 'complete', text: 'PRECOMPACT_CONTENT' }], { fallbackText: 'COMPACTION_SUMMARY_FIXTURE' })
    await initialize(rpc)
    const t0 = await rpc.send('thread/start', { cwd, ephemeral: false })
    const threadId = t0.result.thread.id
    await rpc.send('turn/start', { threadId, input: [{ type: 'text', text: 'CONTENT_BEFORE_COMPACT', text_elements: [] }] })
    await waitForTurnEnd(rpc)
    const compact = await rpc.send('thread/compact/start', { threadId })
    await waitForCompaction(rpc)
    await close()
    out['compact'] = { frames, threadId }
  }

  for (const [key, value] of Object.entries(out)) {
    if (key === 'codexVersion') continue
    writeFileSync(join(here, `${key}.json`), `${JSON.stringify(value, null, 2)}\n`)
    console.log(`wrote ${key}.json (${value.frames.length} frames)`)
  }
}

async function waitForTurnEnd(rpc) {
  // Poll the recorded frames until the turn/completed notification arrives.
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    await wait(50)
    if (rpc.frames.some((f) => f.kind === 'server' && f.frame.method === 'turn/completed')) return
  }
  throw new Error('turn/completed not observed within timeout')
}

async function waitForCompaction(rpc) {
  // thread/compact/start is asynchronous: wait for a thread/compacted
  // notification (or a thread/status/changed settling back to idle) then a
  // small settle window so any trailing frames are captured.
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    await wait(100)
    const compacted = rpc.frames.some((f) => f.kind === 'server' && f.frame.method === 'thread/compacted')
    const idle = rpc.frames.some((f) =>
      f.kind === 'server' && f.frame.method === 'thread/status/changed'
      && f.frame.params?.status?.type === 'idle')
    if (compacted || idle) {
      await wait(800)
      return
    }
  }
}

try {
  await main()
} catch (error) {
  console.error('recorder failed:', error)
  process.exitCode = 1
}
