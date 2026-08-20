/**
 * Keyless real-product tests for `external-session-codex`, driving the pinned
 * `@openai/codex@0.147.0` app-server against a loopback Responses SSE fixture
 * (see responses-fixture.ts). No real API key or network is used.
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
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

  it('cancels startup before it can spawn when disposed immediately', async () => {
    const harness = await startCodexHarness([])
    try {
      const opening = harness.start()
      const openingOutcome = opening.then(() => undefined, error => error)
      const closingOutcome = harness.provider.dispose(harness.sessionId).then(
        () => undefined,
        error => error,
      )
      await expect(closingOutcome).resolves.toBeUndefined()
      await expect(openingOutcome).resolves.toMatchObject({ message: expect.stringMatching(/abort|disposed/u) })
      expect(harness.handles).toHaveLength(0)
    } finally {
      await harness.close()
    }
  })

  it('gates prompt and model operations until startup and lets disposal win', async () => {
    const harness = await startCodexHarness([{ kind: 'complete', text: 'STARTUP_GATED' }])
    try {
      const opening = harness.start()
      const prompt = Promise.resolve().then(() => harness.provider.prompt(harness.sessionId, 'queued during startup'))
      const model = harness.provider.setModel(harness.sessionId, 'gpt-5.6-sol')
      let interruptError: unknown
      try {
        harness.provider.interrupt(harness.sessionId)
      } catch (error: unknown) {
        interruptError = error
      }
      const closing = harness.provider.dispose(harness.sessionId)

      const [closingOutcome, openingOutcome, promptOutcome, modelOutcome] = await Promise.all([
        closing.then(() => undefined, error => error),
        opening.then(() => undefined, error => error),
        prompt.then(value => value, error => error),
        model.then(() => undefined, error => error),
      ])
      expect(closingOutcome).toBeUndefined()
      expect(openingOutcome).toMatchObject({ message: expect.stringMatching(/abort|disposed/u) })
      expect(promptOutcome).toMatchObject({ message: expect.stringMatching(/abort|disposed/u) })
      expect(modelOutcome).toMatchObject({ message: expect.stringMatching(/abort|disposed/u) })
      expect(interruptError).toBeUndefined()
      expect(harness.recorded.events).not.toContainEqual(expect.objectContaining({
        type: 'external/turn-started',
      }))
    } finally {
      await harness.close()
    }
  })

  it('gates immediate operations behind the completed thread startup', async () => {
    const harness = await startCodexHarness([{ kind: 'complete', text: 'STARTUP_ORDERED' }])
    try {
      const opening = harness.start()
      const prompt = Promise.resolve().then(() => harness.provider.prompt(harness.sessionId, 'after startup'))
      const model = harness.provider.setModel(harness.sessionId, 'gpt-5.6-sol')
      let interruptError: unknown
      try {
        harness.provider.interrupt(harness.sessionId)
      } catch (error: unknown) {
        interruptError = error
      }

      const [openingOutcome, modelOutcome, promptOutcome] = await Promise.all([
        opening.then(() => undefined, error => error),
        model.then(() => undefined, error => error),
        prompt.then(value => value, error => error),
      ])
      expect(openingOutcome).toBeUndefined()
      expect(modelOutcome).toBeUndefined()
      expect(promptOutcome).toMatchObject({ turnId: expect.any(String) })
      expect(interruptError).toBeUndefined()
      await harness.waitTurns(1)

      const started = harness.recorded.events.findIndex(event => event.type === 'external/session-started')
      const turnStarted = harness.recorded.events.findIndex(event => event.type === 'external/turn-started')
      expect(started).toBeGreaterThanOrEqual(0)
      expect(turnStarted).toBeGreaterThan(started)
    } finally {
      await harness.close()
    }
  }, 60_000)

  it('stores model and effort and applies them to the next turn', async () => {
    const harness = await startCodexHarness([{ kind: 'complete', text: 'MODEL_SWITCHED' }])
    try {
      await harness.start('fixture-model')
      await harness.waitCount('external/session-started', 1)
      expect(harness.recorded.events).toContainEqual({
        type: 'external/session-started',
        data: { provider: 'codex', cwd: harness.workspace, model: 'fixture-model' },
      })
      await harness.provider.setModel(harness.sessionId, 'gpt-5.6-sol', ReasoningEffortId('high'))
      await harness.provider.prompt(harness.sessionId, 'switch model')
      await harness.waitTurns(1)
      expect(harness.recorded.events)
        .toContainEqual({ type: 'external/model-switched', data: { model: 'gpt-5.6-sol' } })
      expect(harness.fixture.requests[0]?.body).toMatchObject({
        model: 'gpt-5.6-sol',
        reasoning: { effort: 'high' },
      })
    } finally {
      await harness.close()
    }
  })

  it('rejects a model outside the authoritative native catalog', async () => {
    const harness = await startCodexHarness([])
    try {
      await harness.start()
      await expect(harness.provider.setModel(
        harness.sessionId,
        'not-in-the-native-catalog',
      )).rejects.toThrow(/not listed/u)
      expect(harness.recorded.events).not.toContainEqual({
        type: 'external/model-switched',
        data: { model: 'not-in-the-native-catalog' },
      })
    } finally {
      await harness.close()
    }
  })

  it('confines a pre-session model listing under read-only policy', async () => {
    const harness = await startCodexHarness([])
    try {
      await harness.ctx.externalSessions.listModels('codex')
      expect(harness.confinedPolicies[0]).toMatchObject({ mode: 'read-only' })
      expect(harness.confinedPolicies[0]?.stateRoot).toContain(harness.codexHome)
      expect(harness.spawnSpecs[0]?.env?.CODEX_HOME).toContain(harness.codexHome)
    } finally {
      await harness.close()
    }
  })
})

describe('external-session-codex persistent turns', () => {
  it('serializes concurrent prompts across thread startup and turn dispatch', async () => {
    const harness = await startCodexHarness([
      { kind: 'complete', text: 'CONCURRENT_FIRST' },
      { kind: 'complete', text: 'CONCURRENT_SECOND' },
    ])
    try {
      await harness.start()
      const first = harness.provider.prompt(harness.sessionId, 'first concurrent prompt')
      const second = harness.provider.prompt(harness.sessionId, 'second concurrent prompt')
      await expect(Promise.all([first, second])).resolves.toHaveLength(2)
      await harness.waitTurns(2, 5_000)
      expect(harness.recorded.events.filter(event => event.type === 'external/turn-started')).toHaveLength(2)
    } finally {
      await harness.close()
    }
  }, 60_000)

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
  it('cancels a pending approval before session-ended without a late decision', async () => {
    const harness = await startCodexHarness([
      { kind: 'advertisedFunctionCall', choices: [{ name: 'exec_command', arguments: execCommandArgs }] },
    ])
    try {
      harness.holdPermission()
      await harness.start()
      await harness.provider.prompt(harness.sessionId, 'hold for disposal')
      await harness.waitCount('external/permission-asked', 1)
      await harness.provider.dispose(harness.sessionId)
      harness.releasePermission('allowed')
      await settle()

      const endedIndex = harness.recorded.events.findIndex(event => event.type === 'external/session-ended')
      const lateDecisionIndex = harness.recorded.events.findIndex(event => event.type === 'external/permission-decided')
      expect(endedIndex).toBeGreaterThanOrEqual(0)
      expect(lateDecisionIndex).toBe(-1)
    } finally {
      await harness.close()
    }
  }, 60_000)

  it('cancels a pending approval when the child dies before a respawn', async () => {
    const harness = await startCodexHarness([
      { kind: 'advertisedFunctionCall', choices: [{ name: 'exec_command', arguments: execCommandArgs }] },
      { kind: 'complete', text: 'RESPAWN_AFTER_APPROVAL_DEATH' },
    ])
    try {
      harness.holdPermission()
      await harness.start()
      await harness.provider.prompt(harness.sessionId, 'hold for child death')
      await harness.waitCount('external/permission-asked', 1)
      const child = harness.handles.at(-1)!
      child.terminate()
      await child.waitForExit()
      await child.done.catch(() => {})
      await harness.waitCount('external/turn-ended', 1)

      await harness.provider.prompt(harness.sessionId, 'respawn after child death')
      await harness.waitTurns(2)
      harness.releasePermission('allowed')
      await settle()

      expect(harness.recorded.events).not.toContainEqual(expect.objectContaining({
        type: 'external/permission-decided',
      }))
      expect(harness.recorded.events
        .filter(event => event.type === 'external/turn-ended')
        .map(event => (event.data as { stopReason: string }).stopReason))
        .toEqual(['error', 'completed'])
    } finally {
      await harness.close()
    }
  }, 60_000)

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

describe('external-session-codex child respawn', () => {
  it('settles a turn when the app-server dies before completion and accepts the next prompt', async () => {
    const harness = await startCodexHarness([
      { kind: 'hold' },
      { kind: 'complete', text: 'AFTER_PROCESS_DEATH' },
    ])
    try {
      await harness.start()
      await harness.provider.prompt(harness.sessionId, 'first')
      await harness.fixture.requestStarted
      expect(harness.handles.length).toBeGreaterThan(0)
      const child = harness.handles.at(-1)!
      child.terminate()
      await child.waitForExit()
      await child.done.catch(() => {})

      await expect(Promise.race([
        harness.provider.prompt(harness.sessionId, 'second'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('second prompt timed out')), 5_000)),
      ])).resolves.toMatchObject({ turnId: expect.any(String) })
      await harness.waitTurns(2, 10_000)
      expect(harness.recorded.events
        .filter(event => event.type === 'external/turn-ended')
        .map(event => (event.data as { stopReason: string }).stopReason))
        .toEqual(['error', 'completed'])
      expect(agentMessageTexts(harness)).toContain('AFTER_PROCESS_DEATH')
    } finally {
      await harness.close()
    }
  }, 60_000)

  it('resumes the in-memory thread after the app-server child restarts', async () => {
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

      // Kill the app-server child mid-session; this provider instance must
      // respawn and `thread/resume` its in-memory thread before the next turn.
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
