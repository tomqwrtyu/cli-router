#!/usr/bin/env bash
set -euo pipefail

PROJECT_REF="${1:-sjpsrpohzcgxkruzrsex}"
ISSUER="supabase-edge:${PROJECT_REF}"
AUDIENCE="cli-router"
PRIVATE_JWK_PATH="secrets/router-private-jwk.json"

if [ ! -f "$PRIVATE_JWK_PATH" ]; then
  echo "Missing $PRIVATE_JWK_PATH. Run npm run init-env first." >&2
  exit 1
fi

PRIVATE_JWK="$(tr -d '\n' < "$PRIVATE_JWK_PATH")"

DO_NOT_TRACK=1 npx supabase link --project-ref "$PROJECT_REF"

DO_NOT_TRACK=1 npx supabase secrets set \
  ROUTER_JWT_PRIVATE_JWK="$PRIVATE_JWK" \
  ROUTER_JWT_ISSUER="$ISSUER" \
  ROUTER_JWT_AUDIENCE="$AUDIENCE"

echo "Supabase project linked: $PROJECT_REF"
echo "Supabase Edge Function secrets set:"
echo "- ROUTER_JWT_PRIVATE_JWK"
echo "- ROUTER_JWT_ISSUER=$ISSUER"
echo "- ROUTER_JWT_AUDIENCE=$AUDIENCE"
