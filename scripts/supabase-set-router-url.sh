#!/usr/bin/env bash
set -euo pipefail

ROUTER_URL="${1:-}"

if [ -z "$ROUTER_URL" ]; then
  echo "Usage: $0 https://your-router.example.com" >&2
  exit 1
fi

DO_NOT_TRACK=1 npx supabase secrets set ROUTER_URL="$ROUTER_URL"

echo "Set Supabase secret ROUTER_URL=$ROUTER_URL"
