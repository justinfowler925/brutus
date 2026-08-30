#!/usr/bin/env bash
# Identity-lock a photograph. Face movement at any stage is a failed run.
#
# Lane A  — this photograph, change the world:
#   ./scripts/photo-lock.sh edit PHOTO --prompt "navy suit, office" --out OUT.png --face-box x,y,w,h
# Lane B  — this person, new photograph:
#   ./scripts/photo-lock.sh generate --master FACE.png --lora LORA --prompt "..." --out OUT.png
# Verify  — prove the inner face bytes did not move:
#   ./scripts/photo-lock.sh verify ORIGINAL RESULT --face-box x,y,w,h
#
# Fill runs on the Studio. This laptop cannot see HuggingFace or Anam
# (HTTP 000), and mflux is not installed here. Pass --studio on edit unless
# you already have an inpainted file (--edited) or you are on the Studio.
set -euo pipefail

ATLAS="${ATLAS4_ROOT:-$HOME/Projects/atlas4}"
if [ ! -d "$ATLAS/atlas/photo_lock" ]; then
  echo "atlas4 photo_lock not at $ATLAS — set ATLAS4_ROOT" >&2
  exit 2
fi

export PYTHONPATH="$ATLAS${PYTHONPATH:+:$PYTHONPATH}"
PY="${ATLAS}/.venv/bin/python"
if [ ! -x "$PY" ]; then
  PY="python3"
fi

CMD="${1:-}"
shift || true

# Laptop default: edit without --edited/--dry-run needs the Studio fill binary.
extra=()
if [ "$CMD" = "edit" ]; then
  has_studio=0
  has_edited=0
  has_dry=0
  for a in "$@"; do
    case "$a" in
      --studio) has_studio=1 ;;
      --edited) has_edited=1 ;;
      --dry-run) has_dry=1 ;;
    esac
  done
  if [ "$has_studio" -eq 0 ] && [ "$has_edited" -eq 0 ] && [ "$has_dry" -eq 0 ]; then
    extra+=(--studio)
  fi
fi

exec "$PY" -m atlas.photo_lock "$CMD" "$@" "${extra[@]+"${extra[@]}"}"
