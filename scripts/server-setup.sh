#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Speed API — server setup & install (e.g. Ubuntu/Debian on a VPS / Droplet)
#
# Usage:
#   sudo ./scripts/server-setup.sh --system     # OS packages + Node 22 (NodeSource) + pnpm
#   ./scripts/server-setup.sh --app           # Repo: pnpm install, Python venv, build api-server
#   sudo ./scripts/server-setup.sh            # --system then drops to --app (run remaining as root or normal user)
#
# After install, create an env file (see scripts/speed-api.env.example), then optionally:
#   ./scripts/server-setup.sh --print-systemd
#   sudo install -m 644 /tmp/speed-api.service /etc/systemd/system/speed-api.service
#   sudo systemctl daemon-reload && sudo systemctl enable --now speed-api.service
#
# Open firewall: sudo ufw allow 3001/tcp   (or put nginx/Caddy on 443 and proxy to 127.0.0.1:3001)
# -----------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENV="${ROOT}/artifacts/api-server/.venv"
REQ="${ROOT}/artifacts/api-server/requirements.txt"

usage() {
  cat <<'USAGE'
Speed API server setup

  sudo ./scripts/server-setup.sh --system     Debian/Ubuntu: apt deps + Node 22 (NodeSource) + pnpm
  ./scripts/server-setup.sh --app             From repo root: pnpm install, Python venv, build api-server
  sudo ./scripts/server-setup.sh              Same as --system then --app (as root; fine for a throwaway VM)

  ./scripts/server-setup.sh --print-systemd   Print a systemd unit to stdout (paths from this clone)

  For production, use a non-root user, set EnvironmentFile to a file copied from scripts/speed-api.env.example,
  and put HTTPS (Caddy/nginx) in front for iOS clients.
USAGE
  exit "${1:-1}"
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

is_debian_like() {
  [[ -f /etc/debian_version ]]
}

install_system_debian() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    git \
    ffmpeg \
    python3 \
    python3-venv \
    python3-pip \
    build-essential
}

install_node_nodesource_22() {
  echo "Installing Node.js 22.x (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
}

ensure_node_pnpm() {
  if ! have_cmd node; then
    if is_debian_like && [[ "$(id -u)" -eq 0 ]]; then
      install_node_nodesource_22
    else
      echo "ERROR: node not found. Run: sudo $0 --system"
      exit 1
    fi
  fi
  local major
  major="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "${major}" -lt 20 ]]; then
    echo "ERROR: Node 20+ required (found $(node -v))."
    if is_debian_like && [[ "$(id -u)" -eq 0 ]]; then
      install_node_nodesource_22
    else
      exit 1
    fi
  fi
  if ! have_cmd pnpm; then
    echo "Enabling pnpm via corepack…"
    corepack enable
    corepack prepare pnpm@10 --activate
  fi
}

run_system() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: --system must run as root (sudo)."
    exit 1
  fi
  if ! is_debian_like; then
    echo "ERROR: --system only supports Debian/Ubuntu (apt). On other distros, install manually:"
    echo "  git curl ffmpeg python3 python3-venv python3-pip build-essential nodejs 20+ pnpm"
    exit 1
  fi
  install_system_debian
  install_node_nodesource_22
  corepack enable
  corepack prepare pnpm@10 --activate
  echo "System packages and Node are ready."
}

run_app() {
  [[ -f "${ROOT}/pnpm-workspace.yaml" ]] || {
    echo "ERROR: pnpm-workspace.yaml not found at ${ROOT}. Clone the full monorepo."
    exit 1
  }
  [[ -f "${REQ}" ]] || {
    echo "ERROR: Missing ${REQ}"
    exit 1
  }

  ensure_node_pnpm

  echo "pnpm install (workspace)…"
  (cd "${ROOT}" && pnpm install)

  echo "Python venv for Audible auth (${VENV})…"
  if [[ ! -d "${VENV}" ]]; then
    python3 -m venv "${VENV}"
  fi
  "${VENV}/bin/pip" install -q -U pip
  "${VENV}/bin/pip" install -q -r "${REQ}"

  echo "Building @workspace/api-server…"
  (cd "${ROOT}" && pnpm --filter @workspace/api-server run build)

  echo ""
  echo "App install finished."
  echo "  • API bundle: ${ROOT}/artifacts/api-server/dist/index.mjs"
  echo "  • Python venv: ${VENV} (PATH must include ${VENV}/bin for audible_auth.py)"
  echo "  • Run (dev-style):  export PORT=3001 PATH=\"${VENV}/bin:\$PATH\" && cd \"${ROOT}\" && pnpm --filter @workspace/api-server run start"
  echo "  • Env template:    ${ROOT}/scripts/speed-api.env.example"
}

print_systemd() {
  local node_path venv_bin
  node_path="$(command -v node)"
  venv_bin="${VENV}/bin"
  cat <<EOF
[Unit]
Description=Speed Audible API
After=network.target

[Service]
Type=simple
WorkingDirectory=${ROOT}/artifacts/api-server
Environment=NODE_ENV=production
Environment=PATH=${venv_bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Uncomment after copying speed-api.env.example:
# EnvironmentFile=${ROOT}/.env.speed
ExecStart=${node_path} --enable-source-maps ${ROOT}/artifacts/api-server/dist/index.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
}

MODE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --system) MODE="system" ;;
    --app) MODE="app" ;;
    --print-systemd) print_systemd; exit 0 ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
  shift
done

if [[ -z "${MODE}" ]]; then
  if [[ "$(id -u)" -eq 0 ]]; then
    run_system
    echo ""
    echo "Running --app as root (consider a dedicated user for production)…"
    run_app
  else
    echo "Run without args from a user with sudo, or explicitly:"
    echo "  sudo $0 --system && $0 --app"
    exit 1
  fi
elif [[ "${MODE}" == "system" ]]; then
  run_system
elif [[ "${MODE}" == "app" ]]; then
  run_app
fi
