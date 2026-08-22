#!/usr/bin/env node

// Launch the pinned app-server through a direct executable wrapper. Codex gets
// a private CODEX_HOME from the Harness provider; this wrapper writes the
// fixture model provider into that home and forwards JSONL stdio unchanged.
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const codexHome = process.env.CODEX_HOME
const responsesUrl = process.env.DSH_CODEX_RESPONSES_URL
const codexBin = process.env.DSH_CODEX_BIN
const traceFile = process.env.DSH_CODEX_TRACE_FILE
if (codexHome === undefined || responsesUrl === undefined || codexBin === undefined) {
  throw new Error('external-codex fixture wrapper requires CODEX_HOME, DSH_CODEX_RESPONSES_URL, and DSH_CODEX_BIN')
}

function traceFrame(direction, line) {
  if (traceFile === undefined || line.length === 0) return
  try {
    const frame = JSON.parse(line)
    if (frame === null || typeof frame !== 'object') return
    appendFileSync(traceFile, `${JSON.stringify({ direction, frame })}\n`)
  } catch {
    // The app-server protocol is JSONL; malformed diagnostics are forwarded
    // but are not method evidence.
  }
}
// The provider grants this private state root to the child sandbox. Write the
// same explicit fixture configuration used by the pinned app-server evidence,
// retaining the Harness MCP section that the provider installed beforehand.
// A file config is required here: passing the nested model/MCP settings as
// app-server CLI overrides leaves the real child with an empty tool roster.
const configPath = `${codexHome}/config.toml`
let existingConfig = ''
try {
  existingConfig = readFileSync(configPath, 'utf8')
} catch (error) {
  if (!(error instanceof Error && error.code === 'ENOENT')) throw error
}
existingConfig = existingConfig.replace(
  '[mcp_servers.dsh_harness]\n',
  '[mcp_servers.dsh_harness]\nenabled = true\ndefault_tools_approval_mode = "approve"\n',
)
if (!existingConfig.includes('model_provider = "fixture"')) {
  const fixtureConfig = [
    'model = "fixture-model"',
    'model_provider = "fixture"',
    'approval_policy = "on-request"',
    'sandbox_mode = "read-only"',
    'disable_response_storage = false',
    'check_for_update_on_startup = false',
    '',
    '[model_providers.fixture]',
    'name = "Fixture Responses"',
    `base_url = ${JSON.stringify(responsesUrl)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
  ].join('\n')
  writeFileSync(configPath, `${fixtureConfig}${existingConfig.length > 0 ? `\n${existingConfig}` : ''}`, { mode: 0o600 })
}

const childEnv = { ...process.env }
delete childEnv.CODEX_CI
const child = spawn(process.execPath, [codexBin, ...process.argv.slice(2)], {
  env: childEnv,
  stdio: ['pipe', 'pipe', 'inherit'],
})
// The pinned app-server's account/read method reports the local OAuth account,
// while this fixture deliberately uses a loopback Responses provider and a
// fake API key. Answer only that preflight probe locally; every initialize,
// model, thread, and turn frame still traverses the real app-server child.
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, newline)
    input = input.slice(newline + 1)
    traceFrame('request', line)
    try {
      const frame = JSON.parse(line)
      if (frame?.method === 'account/read' && frame.id !== undefined) {
        const response = JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id,
          result: { account: { authenticated: true }, requiresOpenaiAuth: false },
        })
        traceFrame('response', response)
        process.stdout.write(`${response}\n`)
        continue
      }
    } catch {
      // Forward malformed or non-JSON lines to the real app-server; its
      // protocol diagnostics remain authoritative for this fixture.
    }
    child.stdin.write(`${line}\n`)
  }
})
let output = ''
child.stdout.on('data', (chunk) => {
  const text = chunk.toString()
  process.stdout.write(text)
  output += text
  let newline
  while ((newline = output.indexOf('\n')) !== -1) {
    const line = output.slice(0, newline)
    output = output.slice(newline + 1)
    traceFrame('response', line)
  }
})
process.stdin.on('end', () => { child.stdin.end() })
child.once('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
