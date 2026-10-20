/** Main releases advance stable versions and never reuse a staged CLI version. */
import { expect, it } from 'vitest'
import { nextMainVersion } from './next-main-version.ts'

it.each([
  ['0.2.1-rc.2', ['0.1.5'], '0.2.1'],
  ['0.2.1', ['0.1.5'], '0.2.2'],
  ['0.2.1-rc.2', ['0.2.1'], '0.2.2'],
  ['0.2.1', ['0.2.3', '0.2.2'], '0.2.4'],
  ['0.2.1', ['0.3.0-rc.1'], '0.3.0'],
  ['0.2.1-rc.2', [], '0.2.1'],
] as const)('advances %s above published %j to %s', (current, published, expected) => {
  expect(nextMainVersion(current, published)).toBe(expected)
})

it.each(['latest', 'v0.2.1', '', '0.2.1; echo bad'])('refuses an invalid source or registry version %j', (version) => {
  expect(() => nextMainVersion(version, [])).toThrow('Invalid release version')
  expect(() => nextMainVersion('0.2.1', [version])).toThrow('Invalid release version')
})
