#!/bin/zsh
# Create/load loopback-only LiveKit credentials shared by server, worker, and Brutus.
set -euo pipefail
LIVEKIT_ENV_FILE="${BRUTUS_LIVEKIT_ENV_FILE:-$HOME/.brutus/livekit.env}"
mkdir -p "${LIVEKIT_ENV_FILE:h}"
if [[ ! -s "$LIVEKIT_ENV_FILE" ]]; then
  umask 077
  _secret=$(/usr/bin/openssl rand -hex 32)
  _tmp="${LIVEKIT_ENV_FILE}.tmp.$$"
  {
    print -r -- 'export LIVEKIT_URL=ws://127.0.0.1:7880'
    print -r -- 'export LIVEKIT_API_KEY=brutuslocal'
    print -r -- "export LIVEKIT_API_SECRET=$_secret"
  } > "$_tmp"
  /bin/chmod 600 "$_tmp"
  /bin/mv -n "$_tmp" "$LIVEKIT_ENV_FILE" || /bin/rm -f "$_tmp"
  unset _secret _tmp
fi
source "$LIVEKIT_ENV_FILE"
