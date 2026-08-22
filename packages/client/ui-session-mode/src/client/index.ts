/**
 * Web new-session mode picker: the "模式" seat choosing between the native DSH
 * agent loop and registered external console agents (Codex, …), plus the
 * per-mode model seat.
 *
 * The picker reads the host's `session.externalModes` catalog and stages the
 * next session's driver mode + initial model. Creation carries them directly
 * through `sessions.create` — unlike the agent-preset chip, whose choice folds
 * into an already-created blank session, the mode must reach creation itself
 * because the host decides there whether to build a native Agent or hand the
 * bare session to the external bridge driver.
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModePickerInjected } from './ModePicker.tsx'
import { ModePicker } from './ModePicker.tsx'
import { ModeSeatController } from './seat-store.ts'
import { en, zh, type ModeSeatKey } from './locales.ts'
import { registerExternalTranscriptNodes, registerExternalTranscriptRenderers } from './transcript/register.ts'
// Type-only: pulls the ui-slots LocaleNamespaceMap merge for this picker's copy.
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The new-session mode picker's copy. */
    sessionMode: ModeSeatKey
  }
}

export type { ModePickerInjected, ModePickerProps } from './ModePicker.tsx'
export type { ModeSeatState, ModeFailure, ModeModel, ModeOption } from './seat-store.ts'
export { NATIVE_MODE, ModeSeatController } from './seat-store.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'sessions', 'workspaces', 'remote']

/**
 * Mount the new-session mode picker on the hero screen.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle

  ctx.effect(() => ctx.locale.register('sessionMode', { zh, en }), 'ui-session-mode: picker dictionaries')

  // The external-session transcript rows need ui-conversation's node
  // machinery; wait for its `conversationEvents` service and the chat-node
  // declaration before registering, so the two plugins compose in any order.
  ctx.inject(['conversationEvents', 'conversation'], (scope: ClientContext) => {
    registerExternalTranscriptNodes(scope)
    registerExternalTranscriptRenderers(scope)
  })

  // Register the hero seat. Binding inside the conversation scope mirrors the
  // agent-preset seat: the session flow lives there, and the staged choice
  // belongs to the flow rather than to any one session.
  ctx.inject(['slots', 'conversation', 'sessions', 'workspaces'], (scope: ClientContext) => {
    const controller = new ModeSeatController(api, async (mode, model) => {
      // Creation carries the staged mode; the model applies as the initial
      // model for an external mode. Target the current/recent workspace so the
      // hero flow lands where the workspace picker would. The ISessions face
      // does not expose creation, so this rides the connection api directly
      // and the next list refresh (below) folds the new row in.
      const sessionsState = scope.sessions.list.getSnapshot()
      const current = sessionsState.current
      const workspaceId = current === undefined
        ? undefined
        : scope.workspaces.list.getSnapshot().items
          .find(item => item.sessionIds.includes(current))?.workspaceId
        ?? scope.workspaces.list.getSnapshot().recentWorkspaceId
      const response = await api.sessions.create({
        ...(workspaceId === undefined ? {} : { workspaceId }),
        mode,
        ...(model === undefined ? {} : { model }),
      })
      if (!response.result.ok) {
        throw new Error(response.result.error.message)
      }
    })

    const injected = (): ModePickerInjected => ({
      hooks: { modeSeat: controller.store },
      load: () => controller.load(),
      select: (mode: string) => controller.select(mode),
      selectModel: (model: string) => controller.selectModel(model),
      create: () => controller.create(),
    })

    scope.effect(() => {
      const seat = scope.slots.register({
        name: 'conversation.hero.sessionMode',
        locale: 'sessionMode',
        inject: injected,
      }, ModePicker)
      return () => { seat() }
    }, 'ui-session-mode: hero seat')
  })
}
