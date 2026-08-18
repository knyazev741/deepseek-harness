/**
 * Host-side permission bridge for external agent sessions. This function
 * plugin wires `ctx.externalSessions`' per-session
 * {@link ExternalBridgeContext.requestPermission} to the human through the
 * `ctx.userQuestions` channel: each {@link ExternalPermissionAsk} becomes one
 * question whose options are the ask's offered choices, and the human's
 * selection resolves to an {@link ExternalPermissionDecision}. It is the host
 * responsibility that turns the Service Definition's default fail-closed
 * `PERMISSION_UNWIRED` throw into a real human decision.
 *
 * Fail-closed taxonomy: selecting the first ask option resolves `allowed`,
 * the second `rejected`, and any other selection — or a dismissed/aborted
 * question, or the bounded `timeoutMs` elapsing with no answer — resolves
 * `cancelled`. With no user-questions provider registered the ask cannot be
 * answered, so the request rejects loud rather than guessing.
 *
 * @module @deepseek-ai/dsh-external-permission
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ExternalSessionError } from '@deepseek-ai/dsh-external-session'
import type {
  ExternalPermissionAsk,
  ExternalPermissionDecision,
} from '@deepseek-ai/dsh-external-session'
import { MAX_TIMER_DELAY_MS, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'external-permission'
/** The registry being wired and the human-question channel it maps onto. */
export const inject = ['externalSessions', 'userQuestions']

/** Default wall-clock budget for one permission ask; documented as the shipped default. */
const DEFAULT_TIMEOUT_MS = 300_000

/**
 * The code this plugin owns, used as the {@link deadline} classification code
 * for a permission ask that elapsed without a human answer. Scoping
 * {@link timeoutOf} to it keeps a nested outer deadline from being misread as
 * this plugin's own timeout.
 */
const PERMISSION_TIMEOUT = 'EXTERNAL_PERMISSION_TIMEOUT'

/**
 * Error code for an ask that cannot reach a human: the user-questions channel
 * has no registered provider, so no decision can be made and the request fails
 * closed.
 */
const PERMISSION_UNANSWERED = 'PERMISSION_UNANSWERED'

/** Configuration for the external permission bridge. */
export interface Config {
  /**
   * Bounded wall-clock budget for one permission ask before it resolves
   * `cancelled` (default 300000). Must be a positive safe integer no greater
   * than {@link MAX_TIMER_DELAY_MS}; misconfiguration fails loud at load.
   */
  timeoutMs?: number
}

/** Runtime configuration schema for the external permission bridge. */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
})

/**
 * Register the permission channel. Installing the plugin replaces the
 * external-session default fail-closed `PERMISSION_UNWIRED` throw for the
 * lifetime of this fibre; disposing the fibre (HMR) restores that default.
 */
export function apply(ctx: Context, config: Config): void {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `external-permission: timeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }

  ctx.externalSessions.registerPermissionChannel(async (_sessionId, ask) => {
    const question: AskUserQuestionItem = {
      id: ask.askId,
      question: ask.title,
      options: ask.options.map(label => ({ label })),
    }
    using d = deadline(undefined, timeoutMs, PERMISSION_TIMEOUT)
    const decisionPromise: Promise<ExternalPermissionDecision> = ctx.userQuestions.ask({ questions: [question], signal: d.signal })
      .then(answer => resolveDecision(answer, ask))
      .catch((error: unknown) => {
        // The bounded wait elapsed first: fail closed to 'cancelled' whether
        // the provider observed the abort or not.
        if (timeoutOf(d.signal, PERMISSION_TIMEOUT) !== undefined) {
          return 'cancelled'
        }
        // No human answerer exists, so no decision can be made; fail closed
        // loud instead of guessing.
        if (error instanceof UserQuestionError && error.code === 'NO_PROVIDER') {
          throw new ExternalSessionError(
            'no user-questions provider to answer external permission request',
            PERMISSION_UNANSWERED,
            { cause: error },
          )
        }
        throw error
      })
    // Bound the wait even if the user-questions provider ignores the abort
    // signal: when the deadline fires, the race resolves 'cancelled'.
    const timeoutPromise = resolveOnAbort(d.signal, 'cancelled')
    const decision = await Promise.race<ExternalPermissionDecision>([decisionPromise, timeoutPromise])
    // The deadline may win the race; swallow a late settle from the abandoned
    // ask so it is never an unhandled rejection.
    void decisionPromise.catch(() => {})
    return decision
  })
}

/**
 * Map the human's structured answer onto a permission decision. The ask's
 * first option means `allowed`, the second `rejected`; an empty selection (a
 * dismissed question), a later option, or an unknown label all mean
 * `cancelled`.
 */
function resolveDecision(answer: AskUserQuestionAnswer, ask: ExternalPermissionAsk): ExternalPermissionDecision {
  const selected = answer.answers[0]?.selected[0]
  if (selected === undefined) return 'cancelled'
  const index = ask.options.indexOf(selected)
  if (index === 0) return 'allowed'
  if (index === 1) return 'rejected'
  return 'cancelled'
}

/** A promise that settles with `onAbort` when `signal` aborts (or settled already). */
function resolveOnAbort(signal: AbortSignal, onAbort: ExternalPermissionDecision): Promise<ExternalPermissionDecision> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(onAbort)
      return
    }
    signal.addEventListener('abort', () => { resolve(onAbort) }, { once: true })
  })
}
