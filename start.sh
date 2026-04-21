#!/usr/bin/env bash
set -e

# Root of repo (directory containing this script)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${ROOT}/artifacts/api-server/.venv"
REQ="${ROOT}/artifacts/api-server/requirements.txt"

# api-server runs audible_auth.py via `python3`; use a venv so `import audible` works (PEP 668–safe).
if [[ ! -d "${VENV}" ]]; then
  echo "Creating Python venv for Audible auth at ${VENV}..."
  python3 -m venv "${VENV}"
fi
echo "Installing Python deps (audible)..."
"${VENV}/bin/pip" install -q -r "${REQ}"
export PATH="${VENV}/bin:${PATH}"

# Load local env overrides for dev runs (e.g., Audible/CDM settings).
ENV_LOCAL="${ROOT}/.env.local"
if [[ -f "${ENV_LOCAL}" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${ENV_LOCAL}"
  set +a
fi

# ffmpeg is required for converting downloaded audio.
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERROR: ffmpeg not found in PATH."
  echo "Install it, then rerun ./start.sh"
  echo ""
  echo "macOS (Homebrew):"
  echo "  brew install ffmpeg"
  exit 1
fi

# Kill background jobs on exit
trap 'kill $(jobs -p) 2>/dev/null' EXIT

echo "Starting API server on :3001..."
PORT=3001 LOG_LEVEL=debug pnpm --filter @workspace/api-server run dev &

echo "Starting player UI on :3010..."
PORT=3010 pnpm --filter @workspace/player run dev &

echo ""
echo "  Player: http://localhost:3010"
echo ""

wait
