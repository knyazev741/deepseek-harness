#!/usr/bin/env node
/** Private entry owned by the Python single-file runtime packaging. */
import { fileURLToPath } from 'node:url'

const selectorName = 'DSH_SUBPROCESS_RUNNER'
const selection = process.env[selectorName]
const aclRunner = process.platform === 'win32'
  ? fileURLToPath(import.meta.resolve('@knyazevai/dsh-sandbox-windows-acl/runner'))
  : undefined

if (aclRunner !== undefined && process.argv[2] === aclRunner) {
  process.argv.splice(1, 1)
  await import('@knyazevai/dsh-sandbox-windows-acl/runner')
} else if (process.env.DSH_PTC_RUNTIME_NODE === '1') {
  Reflect.deleteProperty(process.env, 'DSH_PTC_RUNTIME_NODE')
  await import('@knyazevai/dsh-ptc-runtime-node/process')
} else if (selection === undefined) {
  const { runCli } = await import('@knyazevai/dsh/lib/bin.js')
  await runCli()
} else {
  Reflect.deleteProperty(process.env, selectorName)
  const { runSelectedSubprocessRunner } = await import('@knyazevai/dsh-subprocess-local/runner')
  await runSelectedSubprocessRunner(selection)
}
