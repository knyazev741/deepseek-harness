# Fork feature inventory

`.fork/features.yaml` records legacy behaviors while the fork adopts the upstream Host and client architecture. It is an inventory of observable behavior and acceptance evidence; it is not a runtime manifest and does not activate a package or bundle.

## Fields

The YAML root has `schemaVersion` and `features`. The current schema version is `1`. Each feature record has these fields:

- `id` is the stable feature identifier. The inventory requires the closed set of known identifiers.
- `sourceCommits` lists the exact legacy commit prefixes or commit range that supplied the behavior.
- `requiredBehavior` is one sentence describing what a user or caller can observe.
- `evidence` lists exact repository-relative test files. Entries do not use globs or traversal, and the inventory parser validates their paths without requiring the files to exist yet.
- `disposition` is one of `preserved`, `adapted`, `upstreamed`, `retired`, or `deferred`.
- `replacement` records the current fork-owned or upstream replacement. It is required when a feature is `retired` or `deferred`.

## Lifecycle

Required non-Codex behavior is currently `adapted` while upstream equivalence and fork-owned replacements are assessed. The repository replaces `adapted` only with focused acceptance evidence: a preserved or adapted implementation retains its behavior, an upstreamed record names the equivalent upstream package and test, and a retired record explains why no replacement is needed. Evidence names the focused tests that observe the behavior; compilation alone does not change a disposition.

`external-session-codex` is `deferred`. Codex process and wire handling, permission bridging, transcript UI, and default-bundle registration remain absent during this migration. A later opt-in Codex provider and Web bundle may use the provider-neutral external-session interfaces without adding Codex runtime behavior to the migration baseline.
