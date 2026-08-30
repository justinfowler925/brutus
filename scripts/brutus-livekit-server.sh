#!/bin/zsh
set -euo pipefail
source "${BRUTUS_APP_DIR:-$HOME/.brutus/app}/scripts/brutus-livekit-env.sh"
exec /opt/homebrew/bin/livekit-server \
  --bind 127.0.0.1 \
  --node-ip 127.0.0.1 \
  --udp-port 7882 \
  --keys "$LIVEKIT_API_KEY: $LIVEKIT_API_SECRET"
