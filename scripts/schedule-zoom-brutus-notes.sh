#!/usr/bin/env bash
# Feed Justin Zoom action items into Brutus Notes. Laptop only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export SF_SKIP_NEW_VERSION_CHECK=1
export SF_USE_GENERIC_UNIX_KEYCHAIN=true
export SFDX_USE_GENERIC_UNIX_KEYCHAIN=true
export SF_TARGET_ORG="${SF_TARGET_ORG:-prod-admin}"
export BRUTUS_URL="${BRUTUS_URL:-http://127.0.0.1:8768}"
SINCE="${ZOOM_BRUTUS_SINCE_DAYS:-14}"

# Quiet exit when Brutus UI is down — launchd should not spam.
if ! curl -sf --max-time 2 "$BRUTUS_URL/api/todos" >/dev/null; then
  echo "skip: Brutus down at $BRUTUS_URL"
  exit 0
fi

# Soft-fail SF auth flakes (Mac keychain vs launchd) so the agent stays loaded.
set +e
python3 "$ROOT/scripts/feed_zoom_to_brutus_notes.py" \
  --org "$SF_TARGET_ORG" \
  --since-days "$SINCE" \
  --brutus-url "$BRUTUS_URL" \
  --execute
rc=$?
set -e
if [[ $rc -ne 0 ]]; then
  echo "warn: zoom→brutus feed exited $rc (will retry next interval)"
  exit 0
fi
exit 0