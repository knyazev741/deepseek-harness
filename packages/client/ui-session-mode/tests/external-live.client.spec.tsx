// @vitest-environment jsdom
/** External live seat: partial Markdown is visible while a turn streams and disappears on commit. */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ExternalLiveSeat, ExternalMessageRow } from '../src/client/transcript/external-nodes.tsx'

afterEach(cleanup)

describe('external live seat', () => {
  it('renders the current partial as Markdown and removes the seat when it is committed', () => {
    let live: { turnId: string; text: string } | null = { turnId: 'turn-1', text: '**partial**' }
    const source = {
      getSnapshot: () => ({ externalLive: live }),
      subscribe: () => () => {},
    }
    const useSession = (selector: (snapshot: { externalLive: typeof live }) => unknown) => selector(source.getSnapshot())
    const view = render(<ExternalLiveSeat useSession={useSession as never} t={key => key} />)

    const seat = screen.getByTestId('external-live-seat')
    expect(seat.getAttribute('role')).toBe('status')
    expect(seat.getAttribute('aria-live')).toBe('polite')
    expect(screen.getByText('partial')).toBeTruthy()

    live = null
    view.rerender(<ExternalLiveSeat useSession={useSession as never} t={key => key} />)
    expect(screen.queryByTestId('external-live-seat')).toBeNull()
  })

  it('keeps committed agent Markdown presentation continuous with the live seat', () => {
    render(<ExternalMessageRow node={{
      kind: 'external-message',
      data: { role: 'agent', text: '**bold** [docs](https://example.com/docs)' },
    } as never} />)

    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getByRole('link', { name: 'docs' }).getAttribute('href')).toBe('https://example.com/docs')
  })

  it('keeps committed user text literal', () => {
    render(<ExternalMessageRow node={{
      kind: 'external-message',
      data: { role: 'user', text: '**literal** [docs](https://example.com/docs)' },
    } as never} />)

    expect(screen.getByText('**literal** [docs](https://example.com/docs)')).toBeTruthy()
  })
})
