# Agent Note: Workspace list contribution points

Status: implemented

English | [中文](2026-08-23-workspace-list-contributions.zh.md)

## Problem

The client Workspace browser needs generic package-owned extension points for filter tabs, session ordering, and session-row rendering. The browser also owns persisted account ordering, so a view projection must not become the state input: using a filtered snapshot for the stateful tree or flat list can rewrite persisted order with only the visible session ids and discard excluded sessions.

## Decision

`WorkspaceContributionsRuntime` owns two sorted registries exposed through `ctx.workspaceContributions`: `registerView` supplies a filter tab and `registerPolicy` supplies an ordered comparator. Every registration is created through a Cordis effect and returns an idempotent disposer; duplicate ids and the built-in `workspace.default` view id fail loudly. The service publishes immutable snapshots for the browser hooks, and callback exceptions propagate to the render or registration caller.

`WorkspaceBrowser` always gives `SessionTree` and `FlatList` the full upstream session snapshot for persistence effects and drag commits. Their render derivations receive the active filtered snapshot. Policy comparison builds contexts only for valid candidates in that projection, while stale or excluded ids remain in their upstream order account and are ignored by rendering. The browser owns the fallback `workspace.default` tab, and contributed tab keys remain separate from it.

The generic row slots are the render contribution points: `workspace.session-row.badges`, `workspace.session-row.status`, and `workspace.session-row.actions`. The browser renders action-slot output inside its existing session menu through the neutral `Menu.extra` and `MenuItemButton` primitives; the action owner receives a `closeMenu` callback, while the browser retains Rename, Fork, and Archive ownership. The status slot fills the left cell only when no built-in pending, activity, descendant-activity, or completion status is visible, so a contribution never adds a second indicator beside a browser-owned status. A policy may also implement optional `promote(context)`; promoted ids render once in a synthetic, expanded section above all Workspace groups, while the ordinary groups omit those ids. This generic seam does not define fork, pin, source, unread, or background policy.

## Alternatives considered

**Pass the filtered snapshot into every list component.** Rejected because persistence and drag effects would treat a view projection as the complete account and remove hidden sessions from stored order.

**Let each contributor replace the default view.** Rejected because the browser needs one stable fallback when a contributed tab is removed or its active predicate no longer exists; `workspace.default` is therefore reserved and browser-owned.

**Catch contributor callback failures and omit the contribution.** Rejected because silent omission hides plugin misconfiguration; predicate and comparator failures remain observable at the earliest render that evaluates them.

## Consequences

Contributors can add a filter, ordering policy, left-cell status, or action without importing browser state or duplicating session traversal. A promotion policy supplies only membership; the browser owns the synthetic section, deduplication, and removal from the source Workspace rows. Registration lifetime follows the contributing Cordis fiber, and the published snapshots update when that fiber is disposed. The full state snapshot and filtered render projection are deliberately separate, so hidden sessions retain their account order while visible candidates can be reordered.

## Maintenance and retirement

Maintainers must preserve effect/disposer registration, the reserved `workspace.default` id, and the distinction between full state input and filtered render input when changing the browser. Any new model-visible or fork-related behavior belongs to its own extension contract and is not added to these generic points. Retire this seam only after supported consumers and compositions are removed; remove the service, hooks, tests, README pair, and this note together, and do not recycle the reserved id without updating the shipped decision.

## Verification

Focused tests cover registry disposal and reserved-id rejection, zero-contributor DOM and order preservation, runtime-backed policy ordering, comparator failure propagation, and a contributor fiber composed through the applied client plugin. Package tests also retain the existing tree, flat-list, and row-slot coverage.
