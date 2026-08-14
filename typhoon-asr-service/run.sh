#!/usr/bin/env bash
# Start the local Typhoon ASR service (bound to localhost only — the Next.js
# app talks to it over 127.0.0.1, it is never exposed to the network).
cd "$(dirname "$0")" || exit 1
export TYPHOON_DEVICE="${TYPHOON_DEVICE:-cpu}"
# Keep CPU threads modest so ASR doesn't starve the web app.
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-4}"
exec ./venv/bin/uvicorn app:app --host 127.0.0.1 --port "${TYPHOON_PORT:-8020}"
