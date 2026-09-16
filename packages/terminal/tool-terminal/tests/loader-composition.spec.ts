import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@knyazevai/dsh-llm'
import { Session, SessionId } from '@knyazevai/dsh-session'
import AgentRegistry from '@knyazevai/dsh-agent'
import type { Agent } from '@knyazevai/dsh-agent'
import SystemPrompt from '@knyazevai/dsh-system-prompt'
import ToolRuntime from '@knyazevai/dsh-tools'
import TerminalSessionService from '@knyazevai/dsh-terminal'
import SandboxProvider from '@knyazevai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@knyazevai/dsh-sandbox'
import SandboxPolicyService from '@knyazevai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@knyazevai/dsh-session-projection'
import LocalSubprocessRuntime from '@knyazevai/dsh-subprocess-local'
import * as TerminalLocal from '@knyazevai/dsh-terminal-bash'
import * as ToolPty from '@knyazevai/dsh-tool-terminal'
import { unsupportedInbox } from '@knyazevai/dsh-agent-loop-testkit'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

class PassthroughSandbox extends SandboxProvider {
  async confine(argv: readonly string[], _policy: SandboxPolicy): Promise<ConfinedArgv> {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

async function agent(ctx: Context): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const id = SessionId('pty-loader-agent')
  const session = Session.create(id)
  const value: Agent = {
    id, options: {}, session, inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const suite = process.platform === 'linux' || process.platform === 'darwin' ? describe : describe.skip

suite('terminal real Loader composition through cordis.yml', () => {
  it('boots cordis.yml and preserves shell state across real tool calls', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-pty-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@knyazevai/dsh-agent'",
      "- name: '@knyazevai/dsh-system-prompt'",
      "- name: '@knyazevai/dsh-tools'",
      "- name: '@knyazevai/dsh-terminal'",
      "- name: '@knyazevai/dsh-test-sandbox'",
      "- name: '@knyazevai/dsh-session-projection'",
      "- name: '@knyazevai/dsh-sandbox-policy'",
      '  config:',
      '    mode: danger-full-access',
      `    workspaceRoot: ${JSON.stringify(root)}`,
      "- name: '@knyazevai/dsh-subprocess-local'",
      "- name: '@knyazevai/dsh-terminal-bash'",
      '  config:',
      '    pollIntervalMs: 10',
      '    exactProbeAfterMs: 20',
      '    idleSilenceMs: 250',
      '    handoffGraceMs: 250',
      '    timeoutMs: 2000',
      '    disposeGraceMs: 500',
      "- name: '@knyazevai/dsh-tool-terminal'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@knyazevai/dsh-agent', AgentRegistry],
      ['@knyazevai/dsh-system-prompt', SystemPrompt],
      ['@knyazevai/dsh-tools', ToolRuntime],
      ['@knyazevai/dsh-terminal', TerminalSessionService],
      ['@knyazevai/dsh-test-sandbox', PassthroughSandbox],
      ['@knyazevai/dsh-session-projection', SessionProjectionRegistry],
      ['@knyazevai/dsh-sandbox-policy', SandboxPolicyService],
      ['@knyazevai/dsh-subprocess-local', LocalSubprocessRuntime],
      ['@knyazevai/dsh-terminal-bash', TerminalLocal],
      ['@knyazevai/dsh-tool-terminal', ToolPty],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const owner = await agent(context)
    const signal = new AbortController().signal
    const spawn = await context.tools.execute({
      signal, callId: ToolCallId('spawn'), name: 'terminal_open', arguments: { type: 'shell', name: 'main', cwd: root }, agent: owner,
    })
    expect(resultText(spawn)).toContain('started terminal session pty-1 (main)')

    await context.tools.execute({
      signal, callId: ToolCallId('state'), name: 'terminal_send', arguments: { sessionId: 'pty-1', text: 'export KEEP=loader; cd /' }, agent: owner,
    })
    const read = await context.tools.execute({
      signal, callId: ToolCallId('read'), name: 'terminal_send', arguments: { sessionId: 'pty-1', text: 'printf "cwd=%s keep=%s\\n" "$PWD" "$KEEP"' }, agent: owner,
    })
    expect(resultText(read)).toContain('cwd=/ keep=loader')
    expect(context.terminals.list(owner)).toHaveLength(1)
  }, 15_000)
})
