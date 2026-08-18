/**
 * Keyless real-product tests for `external-session-codex`, driving the pinned
 * `@openai/codex@0.147.0` app-server against a loopback Responses SSE fixture
 * (see responses-fixture.ts). No real API key or network is used.
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as ExternalCodexInvariant from '@deepseek-ai/dsh-external-session-codex/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { startCodexHarness, type CodexTestHarness } from './harness.ts'

const command = process.platform === 'win32'
  ? 'cmd /c type nul > approval-side-effect'
  : 'touch approval-side-effect'
const execCommandArgs = {
  cmd: command,
  sandbox_permissions: 'require_escalated',
  justification: 'exercise the external permission bridge',
}

/** Extract per-role user text from a recorded Responses request body. */
function responseInputTexts(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.input)) return []
  return body.input.flatMap((item): string[] => {
    if (item === null || typeof item !== 'object') return []
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) return []
    return content.flatMap((part): string[] => (
      part !== null
      && typeof part === 'object'
      && typeof (part as Record<string, unknown>).text === 'string'
        ? [(part as Record<string, unknown>).text as string]
        : []
    ))
  })
}

async function awaitQuiescent(harness: CodexTestHarness): Promise<void> {
  expect(harness.handles.length).toBeGreaterThan(0)
  for (const handle of harness.handles) {
    await expect(handle.waitForExit()).resolves.toBe(true)
    const outcome = await handle.done
    expect(outcome).toHaveProperty('exitCode')
    expect(outcome).toHaveProperty('signal')
  }
}

/** Agent-role committed message texts, in recorded order. */
function agentMessageTexts(harness: CodexTestHarness): string[] {
  return harness.recorded.events
    .filter(event => event.type === 'external/message-added')
    .filter(event => (event.data as { role: string }).role === 'agent')
    .map(event => (event.data as { text: string }).text)
}

/** Let the session's process-death bookkeeping settle after a kill. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 150))
}

describe('external-session-codex registration', () => {
  it('registers the codex provider with a native model directory', async () => {
    const harness = await startCodexHarness([])
    try {
      expect(harness.provider.provider).toBe('codex')
      const agents = harness.ctx.externalSessions.listAgents()
      const codexAgent = agents.find(agent => agent.provider === 'codex')
      expect(codexAgent).toMatchObject({ provider: 'codex', modelDirectory: 'provider' })
      expect(codexAgent?.label.length).toBeGreaterThan(0)
    } finally {
      await harness.close()
    }
  })

  it('setModel rejects loud: 0.147.0 exposes no runtime model-switch on a live thread', async () => {
    const harness = await startCodexHarness([])
    try {
      await expect(harness.provider.setModel(harness.sessionId, 'gpt-5.6-sol'))
        .rejects.toThrow(/no runtime model-switch/)
    } finally {
      await harness.close()
    }
  })
})

describe('external-session-codex persistent turns', () => {
  it('runs two prompts on one persistent thread and commits both agent messages', async () => {
    const first = 'FIRST_TURN_SENTINEL'
    const second = 'SECOND_TURN_SENTINEL'
    const harness = await startCodexHarness([
      { kind: 'complete', text: first },
      { kind: 'complete', text: second },
    ])
    try {
      await harness.start()
      await harness.waitCount('external/session-started', 1)
      await harness.provider.prompt(harness.sessionId, 'first prompt')
      await harness.waitTurns(1)
      await harness.provider.prompt(harness.sessionId, 'second prompt')
      await harness.waitTurns(2)

      const agentMessages = agentMessageTexts(harness)
      expect(agentMessages).toEqual([first, second])
      const turnEnded = harness.recorded.events
        .filter(event => event.type === 'external/turn-ended')
        .map(event => (event.data as { stopReason: string }).stopReason)
      expect(turnEnded).toEqual(['completed', 'completed'])
    } finally {
      await harness.close()
    }
  }, 60_000)

  it('streams live deltas and commits a message for one complete turn', async () => {
    const sentinel = 'STREAMED_DELTA_SENTINEL'
    const harness = await startCodexHarness([{ kind: 'complete', text: sentinel }])
    try {
      await harness.start()
      await harness.provider.prompt(harness.sessionId, 'stream this')
      await harness.waitDelta(sentinel)
      await harness.waitCount('external/message-added', 1)
      await harness.waitTurns(1)

      expect(harness.recorded.deltas.some(delta => delta.delta.includes(sentinel))).toBe(true)
      expect(agentMessageTexts(harness)).toContain(sentinel)
      expect(harness.recorded.events.some(event => event.type === 'external/turn-started')).toBe(true)
      expect(harness.recorded.events.some(event => event.type === 'external/turn-ended')).toBe(true)
    } finally {
      await harness.close()
    }
  }, 60_000)
})

describe('external-session-codex approval round-trip', () => {
  it('applies an allowed decision: the command executes', async () => {
    const harness = await startCodexHarness([
      { kind: 'advertisedFunctionCall', choices: [{ name: 'exec_command', arguments: execCommandArgs }] },
    ])
    try {
      harness.setPermissionAnswer('allowed')
      await harness.start()
      await harness.provider.prompt(harness.sessionId, 'run the fixture command')
      await harness.waitCount('external/permission-asked', 1)
      await harness.waitCount('external/permission-decided', 1)
      await harness.waitTurns(1)

      const decided = harness.recorded.events
        .filter(event => event.type === 'external/permission-decided')
        .map(event => (event.data as { outcome: string }).outcome)
      expect(decided).toContain('allowed')
      const askedIdData = harness.recorded.events
        .find(event => event.type === 'external/permission-asked')?.data as { askId: string } | undefined
      expect(askedIdData?.askId).toBeTypeOf('string')
      expect(existsSync(`${harness.workspace}/approval-side-effect`)).toBe(true)
    } finally {
      await harness.close()
    }
  }, 60_000)

  it('applies a rejected decision: the command does not execute', async () => {
    const harness = await startCodexHarness([
      { kind: 'advertisedFunctionCall', choices: [{ name: 'exec_command', arguments: execCommandArgs }] },
    ])
    try {
      harness.setPermissionAnswer('rejected')
      await harness.start()
      await harness.provider.prompt(harness.sessionId, 'run the fixture command')
      await harness.waitCount('external/permission-decided', 1)
      await harness.waitTurns(1)

      const decided = harness.recorded.events
        .filter(event => event.type === 'external/permission-decided')
        .map(event => (event.data as { outcome: string }).outcome)
      expect(decided).toContain('rejected')
      expect(existsSync(`${harness.workspace}/approval-side-effect`)).toBe(false)
    } finally {
      await harness.close()
    }
  }, 60_000)
})

describe('external-session-codex interrupt and disposal', () => {
  it('maps an interrupted turn to aborted', async () => {
    const harness = await startCodexHarness([{ kind: 'hold' }])
    try {
      await harness.start()
      await harness.provider.prompt(harness.sessionId, 'wait for interrupt')
      await harness.fixture.requestStarted
      harness.provider.interrupt(harness.sessionId)
      await harness.waitCount('external/turn-ended', 1)
      const stop = harness.recorded.events
        .find(event => event.type === 'external/turn-ended')?.data as { stopReason: string }
      expect(stop.stopReason).toBe('aborted')
    } finally {
      await harness.close()
    }
  }, 60_000)

  it('disposal runs the whole-tree ladder and records session-ended', async () => {
    const harness = await startCodexHarness([{ kind: 'complete', text: 'DISPOSE_SENTINEL' }])
    try {
      await harness.start()
      await harness.provider.prompt(harness.sessionId, 'prompt')
      await harness.waitTurns(1)
      await harness.provider.dispose(harness.sessionId)
      const ended = harness.recorded.events
        .filter(event => event.type === 'external/session-ended')
        .map(event => (event.data as { stopReason: string }).stopReason)
      expect(ended).toEqual(['completed'])
      await awaitQuiescent(harness)
    } finally {
      await harness.close()
    }
  }, 60_000)
})

describe('external-session-codex cold reattach', () => {
  it('resumes the persisted thread after the app-server process restarts', async () => {
    const first = 'REATTACH_FIRST'
    const second = 'REATTACH_SECOND'
    const harness = await startCodexHarness([
      { kind: 'complete', text: first },
      { kind: 'complete', text: second },
    ])
    try {
      await harness.start()
      await harness.provider.prompt(harness.sessionId, 'first')
      await harness.waitTurns(1)

      // Kill the app-server child mid-session; the provider must respawn and
      // `thread/resume` the persisted thread before the next turn.
      expect(harness.handles.length).toBeGreaterThan(0)
      const child = harness.handles[0]!
      child.terminate()
      await child.waitForExit()
      await child.done.catch(() => {})
      await settle()

      await harness.provider.prompt(harness.sessionId, 'second')
      await harness.waitTurns(2)

      const agentMessages = agentMessageTexts(harness)
      expect(agentMessages).toEqual([first, second])

      // The resumed thread carries the first turn's history into the second
      // model request — proof that reattach, not a fresh thread, happened.
      expect(harness.fixture.requests.length).toBeGreaterThanOrEqual(2)
      const secondRequest = harness.fixture.requests[1]!
      expect(responseInputTexts(secondRequest.body)).toContain(first)
    } finally {
      await harness.close()
    }
  }, 60_000)
})

describe('external-session-codex invariant', () => {
  it('registers the manifest name', async () => {
    const harness = await startCodexHarness([])
    try {
      await harness.ctx.plugin(InvariantRegistry)
      await harness.ctx.plugin(ExternalCodexInvariant)
      expect(() => {
        harness.ctx.invariants.register('@deepseek-ai/dsh-external-session-codex', () => {})
      }).toThrow(/already registered/)
    } finally {
      await harness.close()
    }
  })

  it('rejects a codex descriptor that does not answer models natively', async () => {
    const harness = await startCodexHarness([])
    try {
      await harness.ctx.plugin(InvariantRegistry)
      await harness.ctx.plugin(ExternalCodexInvariant)
      expect(() => {
        harness.ctx.emit('external/provider-added', {
          provider: 'codex',
          label: 'Codex',
          modelDirectory: 'config',
        })
      }).toThrow(/answer models natively/)
    } finally {
      await harness.close()
    }
  })
})
