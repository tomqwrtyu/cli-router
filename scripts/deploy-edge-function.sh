#!/usr/bin/env bash
set -euo pipefail

FUNCTION_NAME="${FUNCTION_NAME:-cli-router}"
ROUTER_URL="${1:-${ROUTER_URL:-}}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-}"

if [ -n "$ROUTER_URL" ]; then
  DO_NOT_TRACK=1 npx supabase secrets set ROUTER_URL="$ROUTER_URL"
else
  echo "ROUTER_URL was not provided. Edge Function deployment can proceed, but runtime calls will fail until ROUTER_URL is set." >&2
  echo "Set it later with: ./scripts/supabase-set-router-url.sh https://your-router.example.com" >&2
fi

if [ -n "$ALLOWED_ORIGINS" ]; then
  DO_NOT_TRACK=1 npx supabase secrets set ALLOWED_ORIGINS="$ALLOWED_ORIGINS"
fi

DO_NOT_TRACK=1 npx supabase functions deploy "$FUNCTION_NAME"

echo "Deployed Supabase Edge Function: $FUNCTION_NAME"
