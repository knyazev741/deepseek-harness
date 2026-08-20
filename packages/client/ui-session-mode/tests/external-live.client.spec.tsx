// @vitest-environment jsdom
/** External live seat: partial Markdown is visible while a turn streams and disappears on commit. */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ExternalLiveSeat } from '../src/client/transcript/external-nodes.tsx'

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

    expect(screen.getByTestId('external-live-seat')).toBeTruthy()
    expect(screen.getByText('partial')).toBeTruthy()

    live = null
    view.rerender(<ExternalLiveSeat useSession={useSession as never} t={key => key} />)
    expect(screen.queryByTestId('external-live-seat')).toBeNull()
  })
})
