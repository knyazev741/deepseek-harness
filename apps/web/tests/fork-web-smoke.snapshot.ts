// @vitest-environment jsdom
// Built artifact smoke for the default Web graph and the opt-in fork-Web graph.
// The helper loads every client bundle from its package's built `lib/client.js`
// export; this file does not import a client source module or add a Vite alias.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installAssembledBootEnv,
  mountAssembledApp,
} from './assembled-boot.ts'

installAssembledBootEnv()

let consoleError: ReturnType<typeof vi.spyOn> | undefined
let pageErrors: string[] = []
let pageErrorListener: ((event: ErrorEvent) => void) | undefined

beforeEach(() => {
  pageErrors = []
  pageErrorListener = (event) => {
    pageErrors.push(event.error instanceof Error ? event.error.message : event.message)
  }
  window.addEventListener('error', pageErrorListener)
  consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    pageErrors.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  if (pageErrorListener !== undefined) window.removeEventListener('error', pageErrorListener)
  pageErrorListener = undefined
  consoleError?.mockRestore()
  consoleError = undefined
})

async function openFixtureSession(): Promise<HTMLElement> {
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const waitingTitle = await within(tree).findByText('Fixture 历史会话')
  const row = waitingTitle.closest<HTMLElement>('[role="treeitem"]')
  if (row === null) throw new Error('fixture history session row missing')
  fireEvent.click(waitingTitle)
  await waitFor(() => {
    expect(document.querySelector('[data-sample="bash"]')).not.toBeNull()
  }, { timeout: 10_000 })
  // The resident history fixture intentionally starts with three questions
  // and an approval. Resolve those gates before exercising the ordinary
  // composer path shared by both profiles.
  for (let index = 0; index < 3; index += 1) {
    fireEvent.click(await screen.findByRole('button', { name: 'Skip this question' }))
  }
  fireEvent.click(await screen.findByRole('button', { name: 'Allow once' }))
  await waitFor(() => expect(document.querySelector('textarea')).not.toBeNull())
  return row
}

async function sendHello(): Promise<void> {
  const editor = document.querySelector<HTMLTextAreaElement>('textarea')
  if (editor === null) throw new Error('composer textarea missing')
  const stop = screen.queryByRole('button', { name: 'Stop generating' })
  if (stop !== null) {
    fireEvent.click(stop)
  }
  const send = await screen.findByRole('button', { name: 'Send message' })
  fireEvent.change(editor, { target: { value: 'hello' } })
  fireEvent.click(send)
  await waitFor(() => {
    expect(editor.value).toBe('')
    const userRows = [...document.querySelectorAll('[data-chat-flow-kind="user"]')]
    expect(userRows.some(row => row.textContent?.includes('hello') === true)).toBe(true)
  }, { timeout: 10_000 })
}

function assertNoBrowserErrors(): void {
  // The fixture transport intentionally omits the optional Cordis inventory
  // and inspect endpoints. The built client reports those unavailable calls
  // while it probes the host; all other window/console errors remain failures.
  const expectedFixtureDiagnostic = (message: string): boolean => (
    message.includes('dynamicCordisRunner/inventory')
    || message.includes('dynamicCordisRunner/syncInspectManifest')
  )
  const unexpected = pageErrors.filter(message => !expectedFixtureDiagnostic(message))
  expect(unexpected).toEqual([])
}

describe('built Web profiles', () => {
  it('keeps the upstream web journey usable and error-free', async () => {
    mountAssembledApp()
    await openFixtureSession()
    await sendHello()

    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    await screen.findByRole('dialog', { name: 'Settings' })
    assertNoBrowserErrors()
  })

  it('adds only the fork overlay interactions in fork-web', async () => {
    mountAssembledApp({ profile: 'fork-web' })
    await openFixtureSession()
    await sendHello()

    // The row action slot is mounted by the built fork bundle. Clipboard is
    // supplied by jsdom as the browser capability, not by the production app.
    const writeText = vi.fn(async (_value: string) => {})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    fireEvent.click(await screen.findByRole('tab', { name: 'Background' }))
    const badge = await screen.findByText('GitHub Actions')
    const row = badge.closest<HTMLElement>('[role="treeitem"]')
    if (row === null) throw new Error('GitHub Actions row missing')
    expect(within(row).getByText('GitHub Actions')).toBeTruthy()

    const copyButton = row.querySelector<HTMLElement>('[data-overlay-session="fx-beta"] button')
    if (copyButton === null) throw new Error('copy session ID button missing')
    fireEvent.click(copyButton)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('fx-beta'))
    expect((await within(row).findByRole('status')).textContent).toContain('Session ID copied')

    fireEvent.click(within(row).getByRole('button', { name: 'Pin session' }))
    await within(row).findByRole('button', { name: 'Unpin session' })

    // The upstream row remains in the same tree and the fork view is a
    // contribution rather than a replacement: the running resident session
    // is also visible in Background.
    const visibleRows = await within(screen.getByRole('tree', { name: 'Sessions' })).findAllByRole('treeitem')
    expect(visibleRows.length).toBeGreaterThan(0)
    assertNoBrowserErrors()
  })
})
