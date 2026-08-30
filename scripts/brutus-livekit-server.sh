#!/bin/zsh
set -euo pipefail
source "${BRUTUS_APP_DIR:-$HOME/.brutus/app}/scripts/brutus-livekit-env.sh"

# Never put the key pair in argv: process arguments are visible to every local
# process inspector. LiveKit reads the same credentials from a mode-0600 file.
LIVEKIT_KEY_FILE="${BRUTUS_LIVEKIT_KEY_FILE:-$HOME/.brutus/livekit.keys}"
mkdir -p "${LIVEKIT_KEY_FILE:h}"
umask 077
_key_tmp="${LIVEKIT_KEY_FILE}.tmp.$$"
trap '/bin/rm -f "$_key_tmp"' EXIT
print -r -- "${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}" > "$_key_tmp"
/bin/chmod 600 "$_key_tmp"
/bin/mv -f "$_key_tmp" "$LIVEKIT_KEY_FILE"
trap - EXIT
unset LIVEKIT_API_KEY LIVEKIT_API_SECRET

exec /opt/homebrew/bin/livekit-server \
  --bind 127.0.0.1 \
  --node-ip 127.0.0.1 \
  --udp-port 7882 \
  --rtc.tcp_port 0 \
  --key-file "$LIVEKIT_KEY_FILE"
