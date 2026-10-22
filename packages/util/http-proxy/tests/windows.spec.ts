import { expect, it } from 'vitest'
import { readWindowsProxy } from '../src/system.ts'

it.skipIf(process.platform !== 'win32')('reads current-user Windows settings through the shipped PowerShell reader', async () => {
  const policy = await readWindowsProxy({ get: () => undefined }, 10000)
  expect(['none', 'system']).toContain(policy.source)
})
