/** The npm smoke cannot inherit a prepared installation or publish credentials. */
import { expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { redactSmokeOutput, smokeEnvironment } from './smoke-web-install.ts'

it('isolates npm and DSH state and excludes inherited Node hooks and credentials', () => {
  const root = join(tmpdir(), 'fresh-consumer')
  const env = smokeEnvironment(root, 1536, 'https://registry.npmjs.org')
  expect(env.HOME).toBe(root)
  expect(env.DSH_HOME).toBe(join(root, '.dsh'))
  expect(env.npm_config_cache).toBe(join(root, '.npm'))
  expect(env.npm_config_userconfig).toBe(join(root, '.npmrc'))
  expect(env.NODE_OPTIONS).toBe('--max-old-space-size=1536')
  for (const key of ['NODE_PATH', 'NODE_AUTH_TOKEN', 'NPM_TOKEN', 'DEEPSEEK_API_KEY', 'SSH_AUTH_SOCK', 'npm_config_legacy_peer_deps']) {
    expect(env[key]).toBeUndefined()
  }
})

it('redacts one-use browser credentials from startup evidence', () => {
  expect(redactSmokeOutput('http://127.0.0.1:1234/?auth=secret&other=kept#token=another\nready')).toBe('http://127.0.0.1:1234/?auth=<redacted>&other=kept#token=<redacted>\nready')
})
