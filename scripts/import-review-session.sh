#!/usr/bin/env bash
# Import a GitHub Actions review-session artifact into the local harness home
# so it appears in the Web UI sidebar under its CI project directory.
#
# Usage:
#   scripts/import-review-session.sh <review-session.zip>
#
# The zip is the `review-session` artifact uploaded by upstream-review.yml; it
# holds `sessions/<normalized-cwd>/<session-id>/session.jsonl*`.
set -euo pipefail

zip="${1:?usage: scripts/import-review-session.sh <review-session.zip>}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

if [ ! -f "$zip" ]; then
  echo "error: no such file: $zip" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

unzip -q "$zip" -d "$tmp"
if [ ! -d "$tmp/sessions" ]; then
  echo "error: the zip has no sessions/ directory (expected the upload-artifact of \$DSH_HOME/sessions)" >&2
  exit 1
fi

mkdir -p "$DSH_HOME/sessions"
cp -r "$tmp/sessions/." "$DSH_HOME/sessions/"

echo "imported sessions:"
find "$tmp/sessions" -name 'session.jsonl*' -print | sed 's#^#  #'
echo "done — refresh the Web UI sidebar to see them under the CI project."
