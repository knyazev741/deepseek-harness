#!/usr/bin/env node
/**
 * Boot an ACP stdio server from `cordis.yml`; usage is
 * `dsh-acp-demo [--config path]`, defaulting to `./cordis.yml`. Shared env
 * loading, Loader guards, snapshot config selection, and settled-tree boot live
 * in dsh-app-boot. Replay skips `.env` and selects sibling
 * `cordis.snapshot.yml` so a stray key cannot trigger a model call. EOF disposes
 * and flushes snapshot runs; the calling automation owns process lifetime. Stdout is
 * reserved for JSON-RPC, so diagnostics go only to stderr.
 * @module @knyazevai/dsh-acp-demo/bin
 */

import { parseArgs } from 'node:util'
import {
  boot,
  installFailLoud,
  loadLayeredEnv,
  resolveConfigPath,
} from '@knyazevai/dsh-app-boot'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@knyazevai/dsh-launch-environment'

const NAME = 'dsh-acp-demo'

/* v8 ignore start -- thin self-executing composition over the unit-tested
   dsh-app-boot helpers; exercised end-to-end by the snapshot suite and the
   built-bin smoke */
installFailLoud(NAME)
const environment = loadLayeredEnv(NAME)
const snapshotMode = environment.get('DSH_SNAPSHOT')?.value
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { config: { type: 'string', short: 'c' } },
  strict: true,
})
const ctx = await boot(
  NAME,
  resolveConfigPath(values.config ?? './cordis.yml', snapshotMode),
  undefined,
  (hostCtx) => { hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment) },
)
if (snapshotMode !== undefined) {
  process.stdin.on('end', () => {
    void ctx.fiber.dispose().then(() => { process.exit(0) })
  })
}
/* v8 ignore stop */
