#!/bin/zsh
# Open the standalone laptop Brutus UI (:8768).
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

ROOT="${BRUTUS_ROOT:-$HOME/Projects/brutus}"
BRUTUS_PORT="${BRUTUS_SERVE_PORT:-8768}"
URL="http://127.0.0.1:${BRUTUS_PORT}/"
LABEL="com.clearspeed.brutus"
# Ensure Brutus laptop serve is up
if ! lsof -iTCP:"$BRUTUS_PORT" -sTCP:LISTEN -n -P 2>/dev/null | grep -q ":${BRUTUS_PORT} "; then
  launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  for _ in {1..20}; do
    lsof -iTCP:"$BRUTUS_PORT" -sTCP:LISTEN -n -P 2>/dev/null | grep -q ":${BRUTUS_PORT} " && break
    sleep 0.5
  done
fi

if ! curl -s -o /dev/null --connect-timeout 3 "$URL"; then
  echo "Brutus not up on ${URL}. Try: cd ${ROOT} && source .venv/bin/activate && brutus serve" >&2
  echo "Logs: ~/.cursor/logs/brutus-serve.err.log" >&2
  exit 1
fi

echo "Brutus (laptop): $URL"
open "$URL" 2>/dev/null || true
