# Plugin-First Fork Overlay Roadmap

This roadmap splits the approved [plugin-first fork overlay design](../specs/2026-08-22-plugin-first-fork-overlay-design.md) into four dependent implementation plans. Execute them in order on one isolated migration branch. Each plan ends in a reviewable, testable checkpoint; no plan may hide a failing check for the next plan.

1. [Overlay Manifest and Verification Gate](2026-08-22-overlay-manifest-gate.md) builds the manifest parser, Git diff classifier, budgets, collision checks, and fixture tests without yet making the incomplete legacy fork inventory a required repository gate.
2. [Host Capability Overlay Migration](2026-08-22-host-capability-overlay.md) merges the selected upstream baseline normally, records every legacy feature disposition, preserves required Host behavior through fork packages or bounded patches, and removes the old Codex implementation.
3. [Upstream Client and Fork Web Composition](2026-08-22-upstream-client-fork-web.md) restores the complete upstream client, adds only general workspace contribution points where necessary, mounts fork UI contributions from a fork Web bundle, and proves both default and fork Web compositions from clean artifacts.
4. [Safe Upstream Sync and Cutover](2026-08-22-safe-upstream-sync-cutover.md) activates `.fork/overlay.yaml`, replaces `-X ours`, adds resolver/reviewer reports and merge simulations, runs the real dry-run sync, and cuts the reviewed migration into `master`.

The controller assigns implementation tasks to `gpt-5.6-luna` with maximum reasoning effort, gives each worker exclusive file ownership, reviews specification compliance before code quality, and runs the final cross-plan acceptance. Workers do not edit or remove unrelated untracked files in the primary checkout.
