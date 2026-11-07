#!/usr/bin/env bash
# Starts everything for the BPM app on macOS/Linux in one terminal:
#   1. FastAPI backend   2. Whoop -> laptop live HR relay   3. Expo (scan the QR with your iPhone)
# Backend and relay output is prefixed [api] / [hr]; Expo runs in the foreground so the QR code shows.
#
# Usage (from the repo root):
#   ./dev.sh              # everything
#   ./dev.sh --no-whoop   # skip the live HR relay (use "Simulated" HR in the app)
#   ./dev.sh --tunnel     # Expo tunnel mode, for Wi-Fi that blocks phone <-> laptop traffic
#   ./dev.sh --ngrok your-name.ngrok-free.app
#                         # public https backend via ngrok: enables "Connect Whoop" in the app
#                         # and works without being on the same Wi-Fi (or set BPM_NGROK_DOMAIN)
# Ctrl+C stops all three.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
MOBILE="$ROOT/mobile"
PY="$BACKEND/.venv/bin/python"

WHOOP=1
EXPO_ARGS=()
NGROK_DOMAIN="${BPM_NGROK_DOMAIN:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-whoop) WHOOP=0 ;;
    --tunnel) EXPO_ARGS+=(--tunnel) ;;
    --ngrok) NGROK_DOMAIN="${2:?--ngrok needs a domain}"; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

# ---- First-run setup (skipped when already done) ----
if [ ! -x "$PY" ]; then
  echo "Creating backend virtualenv and installing packages..."
  python3 -m venv "$BACKEND/.venv"
  "$PY" -m pip install -q -r "$BACKEND/requirements.txt" -r "$BACKEND/requirements-ble.txt"
fi
if [ ! -f "$BACKEND/.env" ]; then
  cp "$BACKEND/.env.example" "$BACKEND/.env"
  echo "Created backend/.env from .env.example. Add WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET for real Whoop data."
fi
[ -d "$MOBILE/node_modules" ] || (cd "$MOBILE" && npm install)

PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

# ---- 0. Optional public URL (ngrok) ----
if [ -n "$NGROK_DOMAIN" ]; then
  command -v ngrok >/dev/null || { echo "ngrok not found: brew install ngrok, then ngrok config add-authtoken <token>"; exit 1; }
  PUBLIC_URL="https://$NGROK_DOMAIN"
  # Environment variables override backend/.env and mobile/.env.
  export WHOOP_REDIRECT_URI="$PUBLIC_URL/whoop/callback"
  export EXPO_PUBLIC_API_URL="$PUBLIC_URL"
  ngrok http 8000 --url="$NGROK_DOMAIN" --log=stdout --log-level=warn 2>&1 | sed -u 's/^/[ngrok] /' &
  PIDS+=($!)
  echo "Public backend: $PUBLIC_URL  (WHOOP redirect URL must be $PUBLIC_URL/whoop/callback)"
fi

# ---- 1. Backend ----
(cd "$BACKEND" && "$PY" -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 2>&1 | sed -u 's/^/[api] /') &
PIDS+=($!)

# ---- 2. Whoop live HR relay (waits for the backend first) ----
if [ "$WHOOP" = 1 ]; then
  echo "Whoop app -> Device Settings -> Heart Rate Broadcast -> Start, then keep the band near this laptop."
  (
    cd "$BACKEND"
    until curl -s -o /dev/null http://localhost:8000/health; do sleep 1; done
    "$PY" scripts/whoop_live_hr.py 2>&1 | sed -u 's/^/[hr] /'
  ) &
  PIDS+=($!)
fi

if [ -n "$NGROK_DOMAIN" ]; then
  echo "Connect Whoop from the app's 'Whoop account' card (first visit may show an ngrok warning page: tap Visit Site)."
else
  echo "Whoop account: open http://localhost:8000/whoop/login on this laptop, or use --ngrok to connect from the app."
fi

# ---- 3. Expo (foreground) ----
cd "$MOBILE" && npx expo start "${EXPO_ARGS[@]+"${EXPO_ARGS[@]}"}"
