#!/usr/bin/env bash
# Build build/api.zip and build/ingest.zip for Python 3.13 arm64 Lambdas.
# numpy/pandas come from the AWSSDKPandas managed layer (not bundled here).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=build; PY=${PYTHON:-python3.13}
PIP=("$PY" -m pip install -q --platform manylinux2014_aarch64 --implementation cp
     --python-version 3.13 --only-binary=:all: --upgrade)
rm -rf "$OUT"/api "$OUT"/ingest "$OUT"/*.zip; mkdir -p "$OUT"/api "$OUT"/ingest

REQ=backend/requirements-lambda.txt
if [[ ! -f $REQ ]]; then  # fallback: runtime deps only
  REQ=$OUT/api-req.txt; grep -Ei '^(fastapi|pydantic|mangum)' backend/requirements.txt > "$REQ"
fi
"${PIP[@]}" -r "$REQ" --target "$OUT/api"
cp -R backend/app "$OUT/api/app"

"${PIP[@]}" requests --target "$OUT/ingest"
cp -R pipeline/roadscope_pipeline "$OUT/ingest/roadscope_pipeline"

for f in api ingest; do
  find "$OUT/$f" -name __pycache__ -prune -exec rm -rf {} +
  (cd "$OUT/$f" && zip -qr9 "../$f.zip" .)
  echo "$f.zip $(du -h "$OUT/$f.zip" | cut -f1) zipped, $(du -sh "$OUT/$f" | cut -f1) unzipped"
done
