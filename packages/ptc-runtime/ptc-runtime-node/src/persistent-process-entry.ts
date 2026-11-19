/** Private built entry for retained Node evaluations. */
import { openInheritedControlChannel } from '@knyazevai/dsh-subprocess/control'
import { runPersistentMain } from './persistent-process.ts'

void runPersistentMain(openInheritedControlChannel(), Number(process.argv[2]), process)
