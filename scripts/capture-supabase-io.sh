#!/usr/bin/env bash
set -uo pipefail

label="${1:-manual}"
if [[ ! "$label" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "Invalid observation label" >&2
  exit 2
fi

project_dir="${SUPABASE_PROJECT_DIR:-/root/cli-router}"
output_root="${ROUTER_IO_OBSERVATION_DIR:-/var/lib/cli-router/io-observations}"
supabase_cli="${SUPABASE_CLI:-/root/cli-router/node_modules/.bin/supabase}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
output_dir="${output_root}/${stamp}-${label}"

mkdir -p "$output_dir"
printf 'captured_at=%s\nlabel=%s\n' "$(date -u --iso-8601=seconds)" "$label" \
  > "${output_dir}/metadata.txt"

status=0
for report in db-stats calls traffic-profile table-stats vacuum-stats; do
  if ! HOME=/tmp DO_NOT_TRACK=1 "$supabase_cli" inspect db "$report" \
    --linked --workdir "$project_dir" \
    > "${output_dir}/${report}.json" \
    2> "${output_dir}/${report}.stderr"; then
    status=1
  fi
done

printf '%s\n' "$output_dir"
exit "$status"
