# Agent Note: Fork Host overlay ownership and bounded runtime seams

Status: implemented

English | [中文](2026-08-22-fork-host-overlay.zh.md)

## Problem

The fork adds Host-only provenance, workspace navigation state, and first-result timing policy while the core session and model-visible surface remain shared with upstream. These facts need durable ownership, replay-safe admission, and fiber-ordered teardown without becoming session-header fields, prompt context, or API Proxy methods.

## Decision

The fork Host overlay owns three opt-in packages. `@knyazevai/dsh-fork-session-source` observes authoritative session creation, appends one `fork/session-source` event with `{ source: 'github-actions' }`, and registers the nullable `forkSessionSource` projection. The event uses the core `LogIntent` seam with `{ ignorable: true }`, so a reader without this optional vocabulary can skip deployment metadata while retaining the session; surface events cannot request this marker.

`@knyazevai/dsh-fork-workspace-session-state` owns the ordered global pin list in the `fork-workspace-session-state` Settings namespace and exposes only the generated `forkWorkspaceSessionState` Remote with `list` and `setPinned`. The persisted value contains only `pins.sessionIds`; the Settings descriptor revision is the sole CAS authority. A serialized operation queue reads the current descriptor before stale checks, requires current workspace membership only for adding a pin, permits removal of a persisted pin after archival or Workspace deletion, and drains before its nested Settings registration withdraws.

The core session seam remains bounded: `LogIntent` stamps an ignorable envelope only for log-only event types, while `SurfaceIntent` remains mandatory for surface placement and cannot request `ignorable`. Neither state fork package contributes model context, prompt content, or API Proxy methods, and ordinary profiles do not mount them.

`@knyazevai/dsh-fork-llm-first-chunk-timeout` registers the `llm/stream` waterfall and bounds only the first downstream iterator result, defaulting to 120000 ms. When the timer wins it yields one retryable `TIMEOUT` terminal chunk and initiates best-effort iterator closure; caller abort remains authoritative, and the wrapper becomes a transparent pass-through after the first result. Its transient timer and iterator state are disposed without awaiting a provider read that may remain blocked. It does not impose an inter-chunk or transport timeout and ordinary profiles do not mount it.

## Verification

The session-source tests cover the event marker, projection, and effect-owned withdrawal. Workspace service, invariant, and Loader composition tests cover persistence, revision CAS, admission, ordered mutation, exact Remote methods, and teardown; the delayed-persist lifecycle test proves the namespace remains available until queued work settles. The first-chunk timeout tests cover first-result identity, timeout and late rejection containment, caller abort, early return, disposal, configuration, Loader composition, and the invariant companion. The generated Remote is verified by the declared built-artifact lane rather than by runtime-loading generated files from source-plane tests.

## Alternatives considered

**Core session header fields.** A header field would make deployment provenance part of the shared core format and would not provide optional-reader behavior. The log-only event keeps the fork vocabulary isolated and replayable.

**Settings-only provenance.** Settings is mutable Host configuration, not append-only session history. A session-created event preserves the fact at its authoritative lifecycle point and feeds the projection.

**Model-visible pin context or API Proxy methods.** Workspace pins are Host navigation state, not model input or an upstream request capability. The generated Remote keeps the feature opt-in and leaves those shared surfaces unchanged.

**Unrevisioned or concurrent pin writes.** Direct writes can overwrite a competing update and lose order. The Settings revision and serialized queue make stale admission and write conflicts explicit.

**Provider-owned first-read timeout.** A provider or core change could abort the transport directly, but the current frozen request and zero-argument waterfall continuation provide no derived signal injection point. The opt-in waterfall wrapper preserves upstream ownership and still bounds the agent-facing first result while documenting that a blocked provider read may outlive disposal.

## Consequences

Fork Host overlays remain independently composable and removable, while the core session format and model request remain unchanged. Unknown source events are safely skippable only because their producer supplies the explicit marker; any future fork event that affects reconstruction must use a required event or a separately reviewed core seam. Existing pins remain durable when workspace membership changes, so membership is an admission rule rather than a cleanup invariant.

The first-result timing policy is independently removable and opt-in, with no effect on inter-chunk timing or provider transport cancellation. A deployment that needs guaranteed transport cancellation must extend the provider-owned request contract rather than infer it from this wrapper.
