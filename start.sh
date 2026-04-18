#!/usr/bin/env bash
set -e

# Kill background jobs on exit
trap 'kill $(jobs -p) 2>/dev/null' EXIT

echo "Starting API server on :3001..."
PORT=3001 pnpm --filter @workspace/api-server run dev &

echo "Starting player UI on :3010..."
PORT=3010 pnpm --filter @workspace/player run dev &

echo ""
echo "  Player: http://localhost:3010"
echo ""

wait
