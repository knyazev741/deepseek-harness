# Fork overlay manifest

The current integration is tracked by `.fork/features.yaml` and the upstream integration Agent Note. A complete path-ownership manifest is not shipped. The verifier below accepts an explicitly supplied manifest.

An overlay manifest is a repository-relative inventory of differences from the immutable upstream commit recorded in the manifest. Git remains the source of truth for code; this file records ownership, path coverage, verification targets, and retirement conditions.

## Command

Without arguments the verifier expects `.fork/overlay.yaml` and fails if that optional manifest is absent. Use `pnpm run verify-fork-overlay -- --manifest fixtures/overlay.yaml` for a fixture manifest. The command accepts no arguments or exactly `--manifest <repository-relative-path>`, rejects traversal and symlink components, reads verification targets without executing them, and exits `1` for invalid input or any diagnostic.

Diagnostics are sorted by code, entry id, and path. A successful check prints exactly `fork-overlay: PASS`.

## Manifest fields

The YAML root has these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | The manifest format version; the current value is `1`. |
| `upstreamCommit` | yes | The exact 40-character hexadecimal upstream commit used as the comparison parent. |
| `entries` | yes | A list of overlay entries; each changed path must be covered by exactly one entry. |

Each `entries` item has these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable unique identifier used in diagnostics and review records. |
| `kind` | yes | One of `fork-owned`, `composition`, `extension-patch`, `product-patch`, or `workflow`. |
| `paths` | yes | One or more exact-file or directory-tree coverage declarations. |
| `owner` | yes | Fork package, workflow, or other repository owner responsible for the entry. |
| `agentNote` | yes | Safe repository-relative file path to the Agent Note that records the entry's rationale and maintenance contract; absolute paths, backslashes, NUL, traversal, glob syntax, and trailing slashes are rejected. |
| `verify` | yes | Structured repository script and/or focused Vitest targets that provide evidence for the entry. |
| `retireWhen` | yes | Condition that permits removing the entry when upstream or the fork no longer needs it. |
| `budget` | patch entries only | Positive limits for files and changed lines in an `extension-patch` or `product-patch`. |
| `generatedBy` | no | Command that produces a generated path covered by the entry. |

Each `paths` item has these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `path` | yes | Repository-relative path without globs, backslashes, or `..`; tree paths end with `/`. |
| `coverage` | yes | `exact` matches one path; `tree` matches the declared directory and all descendants. |

Each `verify` item is one of these forms:

| Form | Fields | Meaning |
| --- | --- | --- |
| `script` | `kind`, `name` | `name` is a non-empty key in the repository root `package.json` `scripts` object. The command is inspected, never executed by this verifier. |
| `vitest` | `kind`, `files` | `files` is a non-empty list of repository-relative regular test files ending in `.spec.ts`, `.spec.tsx`, `.e2e.ts`, or `.test.mjs`. |

Each `budget` item has `maxFiles` and `maxChangedLines`, both positive safe integers. A rename or copy counts both old and new paths for ownership but counts its Git line totals once for the budget; binary changes count as one changed line.

The four ownership classes describe why a path differs:

- `fork-owned` is a path introduced by the fork and absent from the upstream tree; an upstream collision fails verification.
- `composition` is fork assembly that layers plugins or bundles around upstream composition and is also absent from the upstream tree.
- `extension-patch` adds a general upstream registration point while the fork behavior remains in a separate plugin; every matched diff must anchor to an old or current path present in upstream.
- `product-patch` is a narrow upstream behavior change that cannot be expressed through composition or a general extension point and must stay within its budget. A pure added path is rejected with `upstream-ownership-mismatch`, while deletion, rename, and copy records anchor through any upstream side of the diff.

`workflow` is an additional manifest kind for fork-owned workflow files. It is restricted to exact paths beneath `.github/workflows/`, and those paths must be absent from upstream; workflow exclusions must name exact files rather than the complete workflows directory.

Git reads ignore every case-insensitive `GIT_*` environment variable and sets only `GIT_OPTIONAL_LOCKS=0`, while preserving ordinary process environment variables. Revision arguments are preceded by `--end-of-options` and path-limiting `--` remains in place, so repository redirection and option-like revisions cannot change what the verifier reads.

## Minimal valid manifest

```yaml
schemaVersion: 1
upstreamCommit: 0123456789abcdef0123456789abcdef01234567
entries:
  - id: fork-example
    kind: composition
    paths:
      - path: packages/bundle/fork/index.ts
        coverage: exact
    owner: packages/bundle/fork
    agentNote: .agents/notes/implemented/architecture/fork-example.md
    verify:
      - kind: script
        name: test:fork-example
    retireWhen: upstream provides the required composition
```

Plan 4 creates `.fork/overlay.yaml` and activates the CI requirement. Before that cutover, CI may invoke the verifier only with fixture manifests; it must not require the absent top-level `.fork/overlay.yaml`.
