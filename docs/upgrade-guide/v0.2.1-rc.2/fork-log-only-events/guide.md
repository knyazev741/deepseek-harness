---
kind: upgrade-guide
description: The fork-specific LogIntent API is removed from Session.append.
---

# Fork log-only event writes

English | [中文](guide.zh.md)

## Change

The fork-specific `LogIntent` type and the `{ ignorable: true }` option on `Session.append` are removed. The shipped GitHub Actions source plugin writes `plugin:fork/session-source` through the plugin-record writer and reads both that record and the historical `fork/session-source` event. Existing Session logs remain readable without rewriting their markers.

## Migration

1. Remove `LogIntent` imports and the ignorable argument from custom `Session.append` calls. Ordinary declared Session events use `Session.append`, and readers must know their event types.
2. Use the shipped [`fork-session-source` plugin](../../../../packages/fork/session-source/README.md) for GitHub Actions source metadata. Do not manually append its marker.
3. Rebuild custom plugins and open an existing marked Session to confirm its GitHub Actions source remains visible.
