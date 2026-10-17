# RoadScope deployment runbook

The target is AWS account 287785301961 in region `us-east-2`. All commands are run from the repository root unless a step says otherwise.

## 1. Prerequisites

- AWS CLI v2, authenticated to the account (`aws sts get-caller-identity`).
- Node 20+ and AWS CDK v2 (`npm i -g aws-cdk`); CDK bootstrapped once with `cdk bootstrap aws://287785301961/us-east-2`.
- Python 3.13 (Lambda runtime; wheels are built for `manylinux2014_aarch64`).
- Curated data present in `data/curated/` (see the pipeline commands in README section 6).
- Account-level budget `roadscope-transtech-cap` ($40/month) already exists. Do not deploy without it.

## 2. Package the Lambdas

```bash
./scripts/package_lambdas.sh        # writes build/api.zip and build/ingest.zip
```

numpy and pandas for the ingest function come from the AWSSDKPandas managed layer and are not bundled.

## 3. Deploy the stack

```bash
cd infra/cdk
python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt
cdk diff
cdk deploy                          # default edge: API Gateway HTTP API (works on unverified accounts)
cdk deploy -c edge=cloudfront       # alternative: CloudFront + OAC on the Function URL (needs account verification)
```

The stack outputs are `BucketName`, `ApiBaseUrl`, `ApiFunctionName`, `IngestFunctionName`, `WorkerInstanceId` and `DashboardUrl`.

## 4. Publish data and the worker job

```bash
./scripts/publish_data.sh           # data/curated -> s3://$BUCKET/curated/, job bundle -> jobs/pipeline.tar.gz
```

`BUCKET` defaults to the `BucketName` output. Set it explicitly to override.

## 5. Run the ingest once

```bash
aws lambda invoke --region us-east-2 --function-name roadscope-ingest /dev/stdout
```

After this manual run, EventBridge triggers the ingest weekly (Monday 08:00 UTC). Failures land in the SQS DLQ and raise the `roadscope-ingest-errors` and `roadscope-ingest-dlq` alarms.

## 6. Run the EC2 batch worker

```bash
ID=$(aws cloudformation describe-stacks --region us-east-2 --stack-name RoadScopeStack \
  --query "Stacks[0].Outputs[?OutputKey=='WorkerInstanceId'].OutputValue" --output text)
aws ec2 start-instances --region us-east-2 --instance-ids "$ID"
```

On every boot the worker pulls `jobs/pipeline.tar.gz`, rebuilds the NGSIM trajectories, conflicts and repair outputs, syncs them to `curated/intersections/` and writes `curated/runs/<ts>.json`. It then shuts itself down. Instance-initiated shutdown is set to "stop", so only the EBS volume is billed while it is idle. EventBridge Scheduler also starts it monthly (`cron(0 9 1 * ? *)`). Check that it has stopped with `aws ec2 describe-instances --instance-ids "$ID" --query 'Reservations[0].Instances[0].State.Name'`.

## 7. Verify

```bash
API=https://tkk01bgzfb.execute-api.us-east-2.amazonaws.com
curl -s $API/api/v1/health
curl -s "$API/api/v1/docs" -o /dev/null -w '%{http_code}\n'
curl -s https://conflux-safety.vercel.app/api/v1/health    # through the Vercel rewrite
```

Check that the deployed data match the current screening definition (ped/bike crashes 2021-2023, Y = 3, 114 on-system crashes, site-type SPFs):

```bash
curl -s $API/api/v1/meta | jq '.metrics | {segment_crash_outcome, segment_crash_period, segment_crash_years, segment_crashes_total, spf_site_types_fitted}'
curl -s $API/api/v1/spf  | jq '{outcome, crash_period, crash_years, fitted: [.site_types | to_entries[] | select(.value.fitted) | .key]}'
curl -s $API/api/v1/intersections/peachtree-10th/ssm | jq '.rules.detection, .counts'   # TTC <= 1.5 s, PET <= 5.0 s; 119 conflicts, 17 overlap
```

Then open the CloudWatch dashboard `RoadScope` and confirm that the `roadscope-api-errors` alarm is in the OK state.

## 8. Vercel project

- Root directory: `frontend`. The framework (Vite), build command, output directory (`dist`) and install command are all set in `frontend/vercel.json`.
- Rewrites in `frontend/vercel.json`: `/api/:path*` goes to the API Gateway endpoint, and every other non-asset path goes to `/index.html` (SPA routing). Assets get an immutable one-year cache.
- If the API endpoint changes (for example after switching to `edge=cloudfront`), update the rewrite destination and `CORS_ORIGINS` in the stack, then redeploy both.
- Production URL: https://conflux-safety.vercel.app

## 9. Teardown

```bash
cd infra/cdk && cdk destroy
```

The S3 bucket has `RemovalPolicy.RETAIN` and survives the teardown. Deleting it is irreversible, so empty and delete it manually only once you are sure. Log groups are destroyed with the stack.

## 10. Cost controls

- The total allowance is $100 in AWS credits. Budget `roadscope-transtech-cap` alerts at $40/month (account level).
- Compute is serverless-first. The EC2 t4g.small runs only during a job and stops itself afterwards.
- The HTTP API stage is throttled to 20 rps (burst 40).
- `/ask` has a per-client token bucket (10 requests/minute) plus a global daily cap of 400 questions per warm container. Bedrock calls go to Claude Haiku 4.5 through the inference profile.
- Logs are kept for two weeks.
