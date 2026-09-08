# @knyazevai/dsh-fork-session-source

English | [中文](README.zh.md)

Function plugin that records whether a session was created while a configured environment variable equals the exact string `true`. The default variable is `GITHUB_ACTIONS`; the feature is opt-in to the deployment environment and is not part of the ordinary session header.

## Composition

```yaml
- id: fork-session-source
  name: '@knyazevai/dsh-fork-session-source'
  config:
    enabledWhenEnv: GITHUB_ACTIONS
```

The plugin requires `sessions` and registers its projection only when `sessionProjections` is present. Loading the event producer without the projection registry still preserves the durable marker. Unloading the plugin removes both its creation listener and the `forkSessionSource` projection registration.

## Durable event and projection

When enabled, authoritative `session/created` appends one log-only `fork/session-source` event with `{ source: 'github-actions' }` and an `ignorable: true` envelope marker. The marker is written synchronously with session creation and never changes `SessionHeader.origin`. A session created from an existing log is inspected before appending, so replay and repeated publication do not add another marker.

The `forkSessionSource` projection starts at `null`, folds the latest valid marker as `'github-actions'`, and returns the same state reference for unrelated events. Its strict JSON-safe schema rejects malformed durable payloads during replay. The wire value is the same nullable value: `null` means the marker is absent or the source plugin was disabled for that session; an omitted projection key means the projection plugin is not composed.

The `ignorable` marker lets a reader that does not load this optional plugin skip the unknown log event while retaining the rest of the session. The companion invariant checks the literal payload, log-only envelope, and at-most-one-marker relation for existing sessions and future appends.

## Model Experience

None, as this plugin records deployment metadata and a client-facing projection without registering model context.

#### KV Cache effect

None; no provider request or model-visible prefix changes.

## Known Limitations and Deferred Work

- The marker records only the configured process environment at authoritative session creation; it does not prove a workflow identity, repository, ref, actor, or runner.
- The source value is currently a single fixed literal. Additional sources require a reviewed event and projection extension rather than silently widening this package's durable payload.
