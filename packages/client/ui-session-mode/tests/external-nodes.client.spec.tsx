// @vitest-environment jsdom
/**
 * The external transcript chat rows render their frozen node payloads: the
 * message row shows committed role + text, the tool row its phase and title,
 * and the permission card shows the ask's options and its outcome once
 * decided. The rows are presentation-only, so these specs drive the props
 * directly with a node payload.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ExternalCompactionRow,
  ExternalMessageRow,
  ExternalModelRow,
  ExternalPermissionRow,
  ExternalToolRow,
} from '../src/client/transcript/external-nodes.tsx'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

afterEach(cleanup)

/** Build the minimal runtime share each row reads: the frozen node. */
function rowProps(node: { kind: string; data: unknown }): ChatNodeViewProps {
  return { node } as unknown as ChatNodeViewProps
}

describe('external message row', () => {
  it('shows committed user and agent text', () => {
    render(<ExternalMessageRow {...rowProps({ kind: 'external-message', data: { role: 'agent', text: 'hello' } })} />)
    expect(screen.getByText('hello')).toBeTruthy()
    expect(screen.getByText('智能体')).toBeTruthy()
  })
})

describe('external tool row', () => {
  it('shows the activity phase, title, and optional detail', () => {
    render(<ExternalToolRow {...rowProps({ kind: 'external-tool', data: { kind: 'result', title: 'bash', detail: 'ok' } })} />)
    expect(screen.getByText('bash')).toBeTruthy()
    expect(screen.getByText('ok')).toBeTruthy()
  })
})

describe('external permission row', () => {
  it('shows the ask options while awaiting a decision', () => {
    render(<ExternalPermissionRow {...rowProps({
      kind: 'external-permission',
      data: { askId: 'a1', title: 'Run?', options: ['Yes', 'No'] },
    })} />)
    expect(screen.getByText('Run?')).toBeTruthy()
    expect(screen.getByText('Yes')).toBeTruthy()
    expect(screen.getByText('No')).toBeTruthy()
    expect(screen.getByText('等待决策…')).toBeTruthy()
  })

  it('shows the recorded outcome once decided', () => {
    render(<ExternalPermissionRow {...rowProps({
      kind: 'external-permission',
      data: { askId: 'a1', title: 'Run?', options: ['Yes', 'No'], outcome: 'rejected' },
    })} />)
    expect(screen.getByText('拒绝')).toBeTruthy()
    expect(screen.queryByText('等待决策…')).toBeNull()
  })
})

describe('external compaction and model rows', () => {
  it('shows the compaction notice', () => {
    render(<ExternalCompactionRow {...rowProps({ kind: 'external-compaction', data: { notice: 'summarized' } })} />)
    expect(screen.getByText('summarized')).toBeTruthy()
  })

  it('shows the switched model', () => {
    render(<ExternalModelRow {...rowProps({ kind: 'external-model', data: { model: 'gpt-5' } })} />)
    expect(screen.getByText('gpt-5')).toBeTruthy()
  })
})

describe('external message row role branch', () => {
  it('shows the user role', () => {
    render(<ExternalMessageRow {...rowProps({ kind: 'external-message', data: { role: 'user', text: 'hi' } })} />)
    expect(screen.getByText('你')).toBeTruthy()
  })
})

describe('external tool row without detail', () => {
  it('omits the detail line', () => {
    render(<ExternalToolRow {...rowProps({ kind: 'external-tool', data: { kind: 'call', title: 'ls' } })} />)
    expect(screen.getByText('ls')).toBeTruthy()
    expect(screen.queryByText('ok')).toBeNull()
  })
})

describe('external permission outcome copy', () => {
  it('renders allowed and cancelled outcomes', () => {
    const { unmount } = render(<ExternalPermissionRow {...rowProps({
      kind: 'external-permission', data: { askId: 'a', title: 't', options: [], outcome: 'allowed' },
    })} />)
    expect(screen.getByText('允许')).toBeTruthy()
    unmount()
    render(<ExternalPermissionRow {...rowProps({
      kind: 'external-permission', data: { askId: 'a', title: 't', options: [], outcome: 'cancelled' },
    })} />)
    expect(screen.getByText('已取消')).toBeTruthy()
  })
})
