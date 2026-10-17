#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-${WEB_URL:-http://127.0.0.1:5173}}"
BASE_URL="${BASE_URL%/}"
body="$(curl --fail --silent --show-error "$BASE_URL/")"
[[ "$body" == *"<div id=\"root\">"* ]] || { echo "Web smoke check failed: root mount missing" >&2; exit 1; }
echo "Web smoke check passed against $BASE_URL"
