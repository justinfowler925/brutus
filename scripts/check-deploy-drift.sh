#!/usr/bin/env bash
set -uo pipefail

APP=${1:?app checkout required}
TARGET=${2:?target ref required}
MODE=${3:-}

[ -z "$(git -C "$APP" ls-files --others --exclude-standard)" ] || exit 1

DIRTY=$(git -C "$APP" diff --name-only; git -C "$APP" diff --cached --name-only)
for path in $(printf '%s\n' "$DIRTY" | sort -u); do
  git -C "$APP" diff --quiet "$TARGET" -- "$path" || exit 1
done

# Staging content already proven byte-identical to TARGET lets git switch an
# older checkout without discarding or stashing anything. Once HEAD becomes
# TARGET, the index is naturally clean.
[ "$MODE" != "--prepare" ] || git -C "$APP" add -u
