/**
 * Unit tests for `external-session-codex`: stop-reason mapping for unknown
 * terminals, approval-decision selection, argv binding, config validation,
 * and provider registration. These need no Codex process.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ExternalSessions from '@deepseek-ai/dsh-external-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { apply } from '../src/index.ts'
import { appServerArgv } from '../src/run.ts'
import {
  mapExternalStopReason,
  offeredApprovalDecision,
} from '../src/wire.ts'

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

  it('registers the codex provider with valid config', async () => {
    const ctx = new Context()
    await ctx.plugin(ExternalSessions)
    expect(() => { apply(ctx, fullConfig()) }).not.toThrow()
    expect(ctx.externalSessions.getProvider('codex')?.provider).toBe('codex')
    expect(ctx.externalSessions.getProvider('codex')?.modelDirectory).toBe('provider')
    await ctx.fiber.dispose()
  })
})
