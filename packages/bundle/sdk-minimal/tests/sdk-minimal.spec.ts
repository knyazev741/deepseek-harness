/** The standalone SDK-minimal bundle's complete declared Cordis tree. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

function packageName(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
}

describe('dsh-sdk-minimal bundle', () => {
  it('declares one standalone allowlisted tree with every row dependency', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patches = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    ) as Array<{ insert?: Array<{ id?: string; inject?: string[]; name?: string; config?: Record<string, unknown>; disabled?: unknown }> }>
    expect(patches).toHaveLength(1)
    const rows = patches[0]?.insert ?? []
    expect(rows.map(row => [row.id, row.name])).toEqual([
      ['sdk-app-startup', '@knyazevai/dsh-sdk-app'],
      ['sdk-jsonrpc-server', '@knyazevai/dsh-sdk-jsonrpc-server'],
      ['deepseek-llm-api-extensions', '@knyazevai/dsh-deepseek-llm-api-extensions'],
      ['session-log-deepseek', '@knyazevai/dsh-session-log-deepseek'],
      ['plugin-package-inventory-deepseek', '@knyazevai/dsh-plugin-package-inventory-deepseek'],
      ['llm-deepseek', '@knyazevai/dsh-llm-deepseek'],
      ['sandbox', '@knyazevai/dsh-sandbox-local'],
      ['session-projection', '@knyazevai/dsh-session-projection'],
      ['sandbox-policy', '@knyazevai/dsh-sandbox-policy'],
      ['subprocess', '@knyazevai/dsh-subprocess-local'],
      ['pty', '@knyazevai/dsh-terminal'],
      ['terminal-bash', '@knyazevai/dsh-terminal-bash'],
      ['terminal-pwsh', '@knyazevai/dsh-terminal-bash'],
      ['timer', '@deepseek-ai/cordis-plugin-timer'],
      ['llm', '@knyazevai/dsh-llm'],
      ['session', '@knyazevai/dsh-session'],
      ['session-title', '@knyazevai/dsh-session-title'],
      ['system-prompt', '@knyazevai/dsh-system-prompt'],
      ['tools', '@knyazevai/dsh-tools'],
      ['mcp-resources', '@knyazevai/dsh-mcp-resources'],
      ['agent', '@knyazevai/dsh-agent'],
      ['llm-retry', '@knyazevai/dsh-llm-retry'],
      ['jobs', '@knyazevai/dsh-jobs-local'],
      ['invariants', '@knyazevai/dsh-invariants'],
      ['session-invariant', '@knyazevai/dsh-session/invariant'],
      ['agent-invariant', '@knyazevai/dsh-agent/invariant'],
      ['scope-invariant', '@knyazevai/dsh-scope/invariant'],
      ['agent-loop-invariant', '@knyazevai/dsh-agent-loop/invariant'],
      ['agent-loop', '@knyazevai/dsh-agent-loop'],
      ['persistent-bash', '@knyazevai/dsh-tool-bash-persistent'],
      ['persistent-pwsh', '@knyazevai/dsh-tool-pwsh-persistent'],
      ['sessions', '@knyazevai/dsh-session-persistence-jsonl'],
    ])
    expect(rows.find(row => row.id === 'sdk-app-startup')?.config).toEqual({ profile: 'sdk-minimal' })
    expect(rows.find(row => row.id === 'sdk-jsonrpc-server')).toMatchObject({
      inject: ['sdkAppStartup', 'loader'],
      config: { maxTokensAsSuccess: false },
    })
    expect(rows.find(row => row.id === 'llm-deepseek')?.config).toEqual({
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultContextWindow: { __jsExpr: 'Number(process.env.DSH_CONTEXT_WINDOW ?? 1000000)' },
      streamIdleTimeoutMs: 172800000,
    })
    expect(rows.find(row => row.id === 'system-prompt')?.config).toEqual({
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      personaPrefix: { __jsExpr: "process.env.DSH_SYSTEM_PROMPT ?? 'You are a helpful software engineer assistant.'" },
    })
    expect(rows.find(row => row.id === 'agent-loop')?.config).toEqual({ agents: [] })
    expect(rows.find(row => row.id === 'terminal-bash')).toMatchObject({
      disabled: { __jsExpr: "process.platform === 'win32'" },
    })
    expect(rows.find(row => row.id === 'terminal-pwsh')).toMatchObject({
      disabled: { __jsExpr: "process.platform !== 'win32'" },
      config: { shellDialect: 'pwsh', timeoutMs: 300000 },
    })
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
      [...new Set(rows.map(row => row.name).filter((name): name is string => name !== undefined).map(packageName))].sort(),
    )
  })
})
