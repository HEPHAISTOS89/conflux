# RoadScope CDK (Python) — `RoadScopeStack`, us-east-2

```bash
scripts/package_lambdas.sh                      # build/api.zip, build/ingest.zip (arm64 wheels)
cd infra/cdk && python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt
npx aws-cdk@2 synth && npx aws-cdk@2 diff && npx aws-cdk@2 deploy
```

Resources: versioned SSE-S3 bucket (raw/ noncurrent versions expire after 30 d) ·
`roadscope-api` Lambda (Function URL, `AWS_IAM` auth) reachable only through CloudFront with
Origin Access Control · `roadscope-ingest` Lambda (AWSSDKPandas managed layer, DLQ, 2 async
retries, EventBridge Mon 08:00 UTC) · EC2 t4g.small worker (no SSH, no inbound, IMDSv2,
12 GB encrypted gp3, SSM) · CloudWatch dashboard `RoadScope`, 3 alarms, 14-day JSON logs.

CloudFront: `/api/v1/*` GET cached 300 s keyed on every query string; `/api/v1/ask` (POST) and
`/api/v1/platform/status` not cached. With OAC on a Lambda URL, **POST clients must send
`x-amz-content-sha256`** (hex SHA-256 of the body) or SigV4 signing fails.

Worker lifecycle: CloudFormation launches it once (first boot runs the job, then
`shutdown -h` → stopped, because shutdown behaviour = stop). EventBridge Scheduler
`roadscope-worker-monthly` (1st, 09:00 UTC) starts it via `aws-sdk:ec2:startInstances`; each
boot runs `roadscope-job.service` (`scripts/ec2_batch_job.sh`) and powers off again. Upload
the job as `s3://<bucket>/jobs/pipeline.tar.gz` before deploying, or the first run records
`status: failed` in `curated/runs/`. Manual run: `aws ec2 start-instances --instance-ids <id>`.

Heavy SPF fitting (statsmodels/scipy) runs on the worker, not in Lambda: the pandas layer plus
scipy+statsmodels exceeds the 250 MB unzipped Lambda limit.
