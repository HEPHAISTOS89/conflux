#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-${API_BASE_URL:-http://127.0.0.1:8000}}"
BASE_URL="${BASE_URL%/}"

check() {
  local path="$1"
  local expected="$2"
  local body
  body="$(curl --fail --silent --show-error "$BASE_URL$path")"
  printf '%s %s\n' "$path" "$body" | head -c 500
  printf '\n'
  if [[ "$body" != *"$expected"* ]]; then
    echo "Smoke check failed: $path did not contain $expected" >&2
    exit 1
  fi
}

check "/health" '"status":"ok"'
check "/" '"data_mode":"synthetic_fixture"'
check "/api/v1/scenarios" 'ngsim-i80-demo'
check "/api/v1/scenarios/ngsim-i80-demo/summary" 'risk_index'
check "/api/v1/scenarios/ngsim-i80-demo/events?severity=critical" 'near_miss'

echo "API smoke checks passed against $BASE_URL"
