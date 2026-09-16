import { describe, expect, it } from 'vitest'
import { isBaselinePackageName } from './publish-npm-baseline.ts'

describe('npm baseline package scopes', () => {
  it('accepts DSH packages only under the fork scope', () => {
    expect(isBaselinePackageName('@knyazevai/dsh-tool', 'harness')).toBe(true)
    expect(isBaselinePackageName('@deepseek-ai' + '/dsh-tool', 'harness')).toBe(false)
    expect(isBaselinePackageName('@knyazevai/dsh-root', 'harness')).toBe(false)
  })

  it('accepts vendored packages under the preserved DeepSeek scope', () => {
    expect(isBaselinePackageName('@deepseek-ai/cordis', 'vendor')).toBe(true)
    expect(isBaselinePackageName('@knyazevai/dsh-cordis', 'vendor')).toBe(false)
  })
})
