# @knyazevai/dsh-fork-external-session

English | [中文](README.zh.md)

Provider-neutral Host registry for opt-in external-session implementations. The package contributes `ctx.externalSessions`, the merge-extensible [`ExternalSessionModeMap`](src/index.ts), and the effect-owned registration and lookup operations. It does not define a provider protocol, process runner, permission bridge, transcript event, renderer, or default provider.

## Composition

The registry is valid with no providers. A later provider package declares its mode and provider type by merging `ExternalSessionModeMap`, then mounts its own plugin and registers the implementation:

```ts
declare module '@knyazevai/dsh-fork-external-session' {
  interface ExternalSessionModeMap {
    example: ExampleProvider
  }
}

ctx.externalSessions.register('example', provider)
const resolved = ctx.externalSessions.lookup('example')
```

`register(mode, provider)` rejects a duplicate mode before replacing the existing provider and returns a disposer owned by the registering Cordis fiber. Disposing removes only that registration; a stale disposer cannot remove a later replacement. `lookup(mode)` throws when no provider is registered for the requested mode, so callers cannot silently fall back to another implementation.

## Deliberate scope

This package owns only the mode-to-provider table. A provider owns its process, wire, live-session, permission, transcript, and model contracts. A later Codex integration must be mounted as an explicit provider and Web bundle; this registry is not a default Codex dependency.

## Model Experience

### Host registry

#### What the model sees

The registry is Host-only and contributes no prompt, tool schema, message, stream, durable event, or model request. Its `register()` and `lookup()` operations affect only Host-side provider selection.

#### Token effect

Zero. Registration and lookup change only Host-side provider selection; they add no model tokens.

#### KV Cache effect

Zero. The registry assembles no provider request and changes no model-visible prefix, so it neither adds to nor invalidates model KV-cache input.

## Known Limitations and Deferred Work

- **Provider lifecycle is provider-owned** — registration disposal removes the lookup entry but does not infer how a provider releases its own resources.
- **Mode declarations are compile-time extensions** — a provider package must merge `ExternalSessionModeMap` before registering its mode; runtime names not registered in the current composition fail at lookup.
