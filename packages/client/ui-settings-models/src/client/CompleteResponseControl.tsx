/** Provider-scoped buffered-response opt-in for Chat Completions endpoints. */
import type { ReactNode } from 'react'
import { Checkbox } from '@knyazevai/dsh-client-ui-primitives'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/**
 * Render the response-mode checkbox and its effect on incremental display.
 * @param props - current mode, edit callback, disabled state, and localized copy.
 * @returns the labeled opt-in and explanation.
 */
export function CompleteResponseControl(props: {
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
  t: (key: ModelsKey) => string
}): ReactNode {
  return <div className={styles['field']}>
    <Checkbox checked={props.checked} disabled={props.disabled} onChange={props.onChange}
      label={props.t('completeResponses')} className={styles['completeResponseToggle']} />
    <p className={styles['advancedHint']}>{props.t('completeResponsesHint')}</p>
  </div>
}
