# Deployment readiness

This repository is deployment-ready but intentionally does **not** create or mutate cloud resources automatically.

## Local verification

```bash
# frontend
npm ci --prefix frontend
npm run build --prefix frontend

# API (Python 3.13 recommended; pydantic-core may not yet support Python 3.15)
python3.13 -m venv backend/.venv313
backend/.venv313/bin/pip install -r backend/requirements.txt
backend/.venv313/bin/python -m pytest -q
```

## Vercel

The repository root contains `vercel.json`, which points Vercel at `frontend/` and publishes `dist/`.
Set `VITE_API_BASE_URL` to the HTTPS ALB/API origin after the API is deployed. The frontend has a local deterministic fixture fallback, so a missing variable does not block the visual demo.

Recommended sequence:

1. Import `HEPHAISTOS89/roadscope-ai` in Vercel.
2. Keep the project root as repository root; `vercel.json` sets `rootDirectory` to `frontend`.
3. Add `VITE_API_BASE_URL` only after the API health endpoint is reachable.
4. Use a preview deployment to validate CORS and API responses before production.

## AWS target shape

- **S3:** private bucket with `raw/`, `validated/`, `normalized/`, `features/`, `events/` prefixes; block public access and encrypt at rest.
- **ECR:** private image repository for `backend/Dockerfile`, image scan on push.
- **ECS Fargate + ALB:** one stateless API service, `/health` target check, HTTPS listener, least-privilege task role.
- **CloudWatch:** structured application logs, ALB 5xx/latency alarms, ECS CPU/memory alarms.
- **EventBridge/Step Functions/Lambda:** later ingestion orchestration, only after data licensing/provenance is approved.
- **Cognito:** optional authentication layer for non-public workspaces; not needed for the demo.

Before creating billable resources: create an AWS Budget and alert threshold, confirm the region (`us-east-2`), and apply tags such as `Project=RoadScopeAI`, `Environment=demo`, and `Owner=HEPHAISTOS89`.

## Evidence boundary

The fixture is synthetic and explicitly labelled in the API. Local tests prove code behavior only; they do not prove AWS, Vercel, DNS, TLS, billing, production traffic, or data-license readiness.

## Live demo API (serverless path)

For the live prototype, the FastAPI app is packaged for Python 3.13 Lambda with a public Function URL. This is a low-cost short-demo path that avoids requiring a local container runtime. The active health endpoint is documented in `docs/DEMO_RUNBOOK.md`.

The ECS/Fargate CloudFormation template remains the repeatable long-running deployment shape. Do not expose the Lambda URL to sensitive data; it is intentionally public for this synthetic fixture only.

## CloudFormation demo template

`infra/cloudformation/roadscope-demo.yaml` is a reviewed, non-executing template for an intentionally bounded demo stack. It creates S3 (14-day lifecycle), ECR (five-image lifecycle), ECS/Fargate, ALB, CloudWatch logs (14-day retention), least-privilege task roles, and an optional monthly budget alert. The template is validated with `aws cloudformation validate-template`; validation does not create resources.

Before a real deployment:

1. Build and push `backend/Dockerfile` to the returned ECR repository.
2. Identify two public subnets in the selected `us-east-2` VPC.
3. Provide `BudgetEmail` and keep `MonthlyBudgetUsd` deliberately low (the budget alerts; it is not a spending cap).
4. Deploy with a change set first and inspect the resource list:

```bash
aws cloudformation create-change-set \
  --stack-name roadscope-demo \
  --change-set-name initial \
  --change-set-type CREATE \
  --template-body file://infra/cloudformation/roadscope-demo.yaml \
  --parameters ParameterKey=VpcId,UsePreviousValue=false,ParameterValue=<vpc-id> \
    ParameterKey=PublicSubnets,UsePreviousValue=false,ParameterValue=<subnet-a>,<subnet-b> \
    ParameterKey=ImageUri,UsePreviousValue=false,ParameterValue=<ecr-uri>:<tag> \
    ParameterKey=BudgetEmail,UsePreviousValue=false,ParameterValue=<alert-email> \
  --capabilities CAPABILITY_IAM \
  --region us-east-2
aws cloudformation describe-change-set --stack-name roadscope-demo --change-set-name initial --region us-east-2
```

Do not execute the change set until the user has reviewed expected costs, the public-HTTP demo limitation, and the exact resource list. Delete the stack after the demo and verify no load balancers, ECS services, ECR images, or S3 objects remain.
