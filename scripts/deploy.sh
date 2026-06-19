#!/usr/bin/env bash
set -euo pipefail

ROUTER_URL="${1:-${ROUTER_URL:-}}"

npm run check

./scripts/deploy-edge-function.sh "$ROUTER_URL"
./scripts/install-systemd.sh

echo "Deployment finished."
