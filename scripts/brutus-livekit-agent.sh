#!/bin/zsh
set -euo pipefail
BRUTUS_APP_DIR="${BRUTUS_APP_DIR:-$HOME/.brutus/app}"
source "$BRUTUS_APP_DIR/scripts/brutus-livekit-env.sh"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export BRUTUS_STATE_DIR="${BRUTUS_STATE_DIR:-$HOME/.brutus/state}"
CREDENTIAL_RUN="${CREDENTIAL_RUN:-$HOME/fowler-brain/scripts/credential-run}"
cd "$BRUTUS_APP_DIR"
exec "$BRUTUS_APP_DIR/scripts/run-with-credential-backoff.sh" \
  brutus-core -- "$BRUTUS_APP_DIR/.venv/bin/python" -m brutus.livekit_agent start
