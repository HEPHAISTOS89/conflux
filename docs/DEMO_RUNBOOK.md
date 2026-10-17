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

Open the frontend and use the synchronized 2D/3D toggle, replay controls, vehicle selection, risk filter, pause/play, and reset. The 3D mode uses Three.js/WebGL; 2D remains the accessible low-cost alternative. By default the UI calls the public demo API and falls back to the deterministic fixture if that request fails. Set `VITE_API_BASE_URL=http://127.0.0.1:8000` to exercise the local API explicitly.

## 2. API connection behavior

Set `VITE_API_BASE_URL` only to an HTTPS API origin that exposes the documented routes in [`backend/README.md`](../backend/README.md). The frontend should retain its fixture fallback for demo resilience. The API must allow the deployed Vercel origin through CORS before enabling this variable in a production-like preview.

## 3. Vercel preview

Current static production demo: https://roadscope-ai-demo.vercel.app

This URL was verified with an HTTP 200 response on 2026-10-17. It is connected to the AWS Lambda API below and keeps a fixture fallback for resilience.
The current deployment was uploaded directly. GitHub Actions are intentionally disabled to avoid hosted-runner consumption; verification and deployment are performed explicitly.

1. Import `HEPHAISTOS89/roadscope-ai`.
2. Keep the repository root and use the committed `vercel.json` (`frontend/` root, `dist` output).
3. Deploy a preview and confirm the visual demo.
4. If testing another API environment, set `VITE_API_BASE_URL` in preview and verify the browser network requests and `/health` response.
5. Promote to production only after the preview smoke path is clean.

Example after deployment:

```bash
./scripts/smoke_web.sh https://<vercel-preview-domain>
```

## 4. AWS API promotion gate

Before creating billable resources, verify the AWS account, region (`us-east-2`), budget alert, and tags. The target shape is private S3 + ECR + ECS Fargate/ALB + CloudWatch; it is described in [`infra/README.md`](../infra/README.md). Do not put credentials in Vercel variables or the repository. Use task roles and a secret manager for runtime secrets.

Current live API (Lambda Function URL): https://6zwr3ongsqiy22oiefyn3wwtva0gunpt.lambda-url.us-east-2.on.aws/

After an API is deployed and its ALB/HTTPS origin is known:

```bash
./scripts/smoke_api.sh https://<api-domain>
```

Record the date, URL, git commit, and output as live evidence. A successful curl proves only the reachable endpoint at that moment.

## 5. Provenance gate

The bundled scenario is synthetic and NGSIM-inspired, not official observed traffic. Before replacing it with real data, record source URL, license/terms, retrieval timestamp, checksum, schema version, validation report, and transformation version. Keep raw and derived artifacts in separate private storage prefixes.
