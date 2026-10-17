#!/usr/bin/env bash
# Sync data/curated/ -> s3://$BUCKET/curated/ and upload the EC2 worker job bundle.
# BUCKET defaults to the RoadScopeStack BucketName output.
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=${AWS_REGION:-us-east-2}
BUCKET=${BUCKET:-$(aws cloudformation describe-stacks --region "$REGION" --stack-name RoadScopeStack \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)}
aws s3 sync data/curated/ "s3://$BUCKET/curated/" --region "$REGION" --exclude '*' \
  --include '*.json' --content-type application/json
aws s3 sync data/curated/ "s3://$BUCKET/curated/" --region "$REGION" --exclude '*' \
  --include '*.geojson' --content-type application/geo+json
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cp -R pipeline/roadscope_pipeline "$T/"; find "$T" -name __pycache__ -prune -exec rm -rf {} +
grep -Ei '^(requests|numpy|pandas|scipy)==' pipeline/requirements.txt > "$T/requirements.txt"
tar czf "$T/pipeline.tar.gz" -C "$T" roadscope_pipeline requirements.txt
aws s3 cp "$T/pipeline.tar.gz" "s3://$BUCKET/jobs/pipeline.tar.gz" --region "$REGION"
echo "published to s3://$BUCKET"
