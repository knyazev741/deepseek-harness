/** Command identity and localized input spelling over the effective Host catalog. */
import type { CommandDescriptor } from '@knyazevai/dsh-commands/types'
import type { TranslateNS } from '@knyazevai/dsh-client-locale/client'
import { builtinCommandName } from '@knyazevai/dsh-commands/builtin'

/**
 * Select the input spelling for a menu-picked command.
 * @param descriptor - effective Host descriptor.
 * @param t - command-namespace translator.
 * @returns localized spelling for a known definition, otherwise its registered name.
 */
export function claimToken(descriptor: CommandDescriptor, t: TranslateNS<'command'>): string {
  const name = builtinCommandName(descriptor)
  return name === undefined ? descriptor.name : t(`token.${name}`)
}
