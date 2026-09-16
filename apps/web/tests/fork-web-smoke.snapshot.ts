// @vitest-environment jsdom
// Built artifact smoke for the default Web graph and the opt-in fork-Web graph.
// The helper loads every client bundle from its package's built `lib/client.js`
// export; this file does not import a client source module or add a Vite alias.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  installAssembledBootEnv,
  mountAssembledApp,
} from './assembled-boot.ts'

installAssembledBootEnv()

let consoleError: MockInstance<(...args: unknown[]) => void> | undefined
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
  await waitFor(() =>{  expect(document.querySelector('[data-composer-input][contenteditable="true"]')).not.toBeNull() })
  return row
}

async function sendHello(): Promise<void> {
  const tree = screen.getByRole('tree', { name: 'Sessions' })
  const start = tree.querySelector<HTMLButtonElement>('button[aria-label="New session in fixture"]')
  if (start === null) throw new Error('fixture new-session action missing')
  fireEvent.click(start)
  const editor = await waitFor(() => {
    const surface = document.querySelector<HTMLElement>('[data-composer-input][data-placeholder="Describe what you want to build, / commands, @ files or sessions"]')
    if (surface === null) throw new Error('fresh composer missing')
    return surface
  })
  if (editor === null) throw new Error('composer textarea missing')
  const stop = screen.queryByRole('button', { name: 'Stop generating' })
  if (stop !== null) {
    fireEvent.click(stop)
  }
  fireEvent.paste(editor, { clipboardData: { items: [], getData: () => 'hello' } })
  await waitFor(() =>{  expect(editor.textContent).toBe('hello') })
  const send = await screen.findByRole('button', { name: 'Send message' })
  fireEvent.click(send)
  await waitFor(() => {
    expect(editor.textContent).toBe('')
    const userRows = [...document.querySelectorAll('[data-chat-flow-kind="user"]')]
    expect(userRows.some(row =>  row.textContent?.includes('hello'))).toBe(true)
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

    // The fork overlay no longer contributes a Background view while that
    // feature is not ready; the built-in Workspaces view is the only one.
    expect(screen.queryByRole('tab', { name: 'Background' })).toBeNull()

    // The GitHub Actions badge mounts in the Workspaces view on the resident
    // fx-beta row; the fork copy action lives in that row's menu (the flat
    // Background view that once exposed it is gone). The row menu is a
    // hover-revealed anchor, so reach the fork action through raw DOM queries
    // rather than accessible-role queries that hide it.
    const badge = await screen.findByText('GitHub Actions')
    const row = badge.closest<HTMLElement>('[role="treeitem"]')
    if (row === null) throw new Error('GitHub Actions row missing')

    const anchor = row.querySelector<HTMLElement>('button[aria-label^="Session actions for"]')
    if (anchor === null) throw new Error('row menu anchor missing')
    fireEvent.click(anchor)
    const copyButton = await waitFor(() => {
      const span = document.querySelector<HTMLElement>('[data-overlay-session="fx-beta"]')
      const button = span?.querySelector<HTMLElement>('button')
      if (button === null || button === undefined) throw new Error('fork copy action not mounted in menu')
      return button
    })
    fireEvent.click(copyButton)
    await waitFor(() =>{  expect(writeText).toHaveBeenCalledWith('fx-beta') })

    // The upstream row remains in the same tree and the fork overlay is a
    // contribution rather than a replacement: the resident session list still
    // renders rows in the single built-in Workspaces view.
    const visibleRows = await within(screen.getByRole('tree', { name: 'Sessions' })).findAllByRole('treeitem')
    expect(visibleRows.length).toBeGreaterThan(0)
    assertNoBrowserErrors()
  })
})
