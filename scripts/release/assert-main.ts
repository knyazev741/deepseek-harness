/** Source verification before building, publishing, and promoting main releases. */
import { capture, isEntry } from './process.ts'

/**
 * Require a clean checkout of the current remote main, including a detached CI checkout.
 * @returns the full source commit verified against origin/main.
 */
export function assertMainSource(): string {
  if (capture('git', ['status', '--porcelain=v1', '--untracked-files=normal']) !== '') {
    throw new Error('Publication requires a clean source checkout')
  }
  const branch = capture('git', ['branch', '--show-current'])
  if (branch !== '' && branch !== 'main') throw new Error(`Publication requires main, got ${branch}`)
  const head = capture('git', ['rev-parse', 'HEAD'])
  const remote = capture('git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/u)[0]
  if (!/^[0-9a-f]{40}$/u.test(head) || head !== remote) {
    throw new Error(`Remote main moved: checkout ${head}, remote ${String(remote)}; release the current main instead`)
  }
  return head
}

if (isEntry(import.meta.url)) console.log(assertMainSource())
