#!/usr/bin/env bash
set -euo pipefail

# Build a Linux-compatible bundle from macOS, publish the function, and print
# the existing Function URL. This script mutates AWS; run only intentionally.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$(mktemp -d)"
ZIP_PATH="${TMPDIR:-/tmp}/roadscope-api-lambda.zip"
trap 'rm -rf "$BUILD_DIR"' EXIT

python3 -m pip install --quiet --platform manylinux2014_x86_64 \
  --implementation cp --python-version 3.13 --only-binary=:all: \
  --target "$BUILD_DIR" -r "$ROOT/backend/requirements.txt"
cp -R "$ROOT/backend/app" "$BUILD_DIR/app"
(cd "$BUILD_DIR" && zip -qr "$ZIP_PATH" .)

aws lambda update-function-code \
  --function-name roadscope-ai-demo-api --region us-east-2 \
  --zip-file "fileb://$ZIP_PATH" --publish >/dev/null
aws lambda wait function-updated-v2 \
  --function-name roadscope-ai-demo-api --region us-east-2
aws lambda update-function-configuration \
  --function-name roadscope-ai-demo-api --region us-east-2 \
  --environment 'Variables={CORS_MODE=lambda,CORS_ORIGINS=https://roadscope-ai-demo.vercel.app}' >/dev/null
aws lambda wait function-updated-v2 \
  --function-name roadscope-ai-demo-api --region us-east-2
aws lambda get-function-url-config \
  --function-name roadscope-ai-demo-api --region us-east-2 \
  --query FunctionUrl --output text
