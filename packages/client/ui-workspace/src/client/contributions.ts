/* eslint-disable @stylistic/max-len */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { HostObservable } from '@knyazevai/dsh-client-ui-slots'
import type { WorkspaceContributions, WorkspaceListPolicy, WorkspaceListView } from './contract/contributions.ts'

type Contribution = WorkspaceListView | WorkspaceListPolicy

/** Cordis service owning generic Workspace list contributions. */
export class WorkspaceContributionsRuntime extends Service implements WorkspaceContributions {
  private readonly viewEntries = new Map<string, WorkspaceListView>()
  private readonly policyEntries = new Map<string, WorkspaceListPolicy>()
  private viewSnapshot: readonly WorkspaceListView[] = []
  private policySnapshot: readonly WorkspaceListPolicy[] = []
  private readonly listeners = new Set<() => void>()
  readonly views: HostObservable<readonly WorkspaceListView[]>
  readonly policies: HostObservable<readonly WorkspaceListPolicy[]>

  constructor(ctx: Context) {
    super(ctx, 'workspaceContributions'); this.views = this.source(() => this.viewSnapshot); this.policies = this.source(() => this.policySnapshot)
  }

  registerView(view: WorkspaceListView): () => void { if (view.id === 'workspace.default') throw new Error('workspace contribution "workspace.default" is reserved'); return this.register(this.viewEntries, view, () => { this.viewSnapshot = this.sorted(this.viewEntries) }) }

  registerPolicy(policy: WorkspaceListPolicy): () => void { return this.register(this.policyEntries, policy, () => { this.policySnapshot = this.sorted(this.policyEntries) }) }

  private source<T>(read: () => readonly T[]): HostObservable<readonly T[]> {
    return { getSnapshot: read, subscribe: (listener) => {
      this.listeners.add(listener); return () => { this.listeners.delete(listener) }
    } }
  }

  private sorted<T extends Contribution>(entries: ReadonlyMap<string, T>): readonly T[] { return [...entries.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)) }

  private register<T extends Contribution>(entries: Map<string, T>, value: T, refresh: () => void): () => void {
    if (entries.has(value.id)) throw new Error(`workspace contribution "${value.id}" is already registered`)
    const dispose = this.ctx.effect(() => {
      entries.set(value.id, value); refresh(); for (const listener of this.listeners) listener()
      return () => { if (entries.get(value.id) !== value) return; entries.delete(value.id); refresh(); for (const listener of this.listeners) listener() }
    }, `workspaceContributions: ${value.id}`)
    return () => { void dispose() }
  }
}
