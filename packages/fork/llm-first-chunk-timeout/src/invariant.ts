/** Runtime invariant companion for the first-result LLM stream deadline. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@knyazevai/dsh-invariants'

const PACKAGE_NAME = '@knyazevai/dsh-fork-llm-first-chunk-timeout'

/** Cordis plugin name used by invariant diagnostics. */
export const name = 'fork-llm-first-chunk-timeout-invariant'

/** The invariant registry is required before this companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package writes no durable session event sequence.
 * Each wrapper owns one transient timer, the first-chunk recovery keeps only a
 * transient per-agent compaction counter, while the LLM and provider contracts
 * own request cancellation and emitted chunks, and the compaction service owns
 * any durable surface reduction.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's empty runtime invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
