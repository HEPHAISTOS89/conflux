# RoadScope AI demo runbook

This runbook separates **local code proof** from **live deployment proof**. A green local check does not establish that Vercel, AWS, DNS, TLS, billing, or production data are configured.

## 1. Local demo (recommended first)

Terminal A, API:

```bash
python3.13 -m venv backend/.venv313
backend/.venv313/bin/pip install -r backend/requirements.txt
backend/.venv313/bin/uvicorn app.main:app --reload --port 8000 --app-dir backend
```

Terminal B, frontend:

```bash
npm ci --prefix frontend
npm run dev --prefix frontend -- --host 127.0.0.1
```

Terminal C, smoke checks:

```bash
./scripts/smoke_api.sh http://127.0.0.1:8000
./scripts/smoke_web.sh http://127.0.0.1:5173
```

Open the frontend and use the replay controls, vehicle selection, risk filter, pause/play, and reset. With no `VITE_API_BASE_URL`, the UI uses the deterministic fixture and remains demonstrable offline.

## 2. API connection behavior

Set `VITE_API_BASE_URL` only to an HTTPS API origin that exposes the documented routes in [`backend/README.md`](../backend/README.md). The frontend should retain its fixture fallback for demo resilience. The API must allow the deployed Vercel origin through CORS before enabling this variable in a production-like preview.

## 3. Vercel preview

1. Import `HEPHAISTOS89/roadscope-ai`.
2. Keep the repository root and use the committed `vercel.json` (`frontend/` root, `dist` output).
3. Deploy a preview with `VITE_API_BASE_URL` unset first; confirm the visual demo.
4. After an HTTPS API exists, set `VITE_API_BASE_URL` in preview only and verify the browser network requests and `/health` response.
5. Promote to production only after the preview smoke path is clean.

Example after deployment:

```bash
./scripts/smoke_web.sh https://<vercel-preview-domain>
```

## 4. AWS API promotion gate

Before creating billable resources, verify the AWS account, region (`us-east-2`), budget alert, and tags. The target shape is private S3 + ECR + ECS Fargate/ALB + CloudWatch; it is described in [`infra/README.md`](../infra/README.md). Do not put credentials in Vercel variables or the repository. Use task roles and a secret manager for runtime secrets.

After an API is deployed and its ALB/HTTPS origin is known:

```bash
./scripts/smoke_api.sh https://<api-domain>
```

Record the date, URL, git commit, and output as live evidence. A successful curl proves only the reachable endpoint at that moment.

## 5. Provenance gate

The bundled scenario is synthetic and NGSIM-inspired, not official observed traffic. Before replacing it with real data, record source URL, license/terms, retrieval timestamp, checksum, schema version, validation report, and transformation version. Keep raw and derived artifacts in separate private storage prefixes.
