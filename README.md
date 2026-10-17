# RoadScope AI

RoadScope AI is an evidence-first road-safety intelligence prototype: synchronized trajectory analytics, risk-event detection, and a clean 2D trajectory replay workspace.

## Prototype scope

- **Web:** React + Vite with an interactive replay surface, dashboard, playback, filters, and responsive macOS-inspired visual system.
- **API:** FastAPI + Pydantic with deterministic demo trajectories, risk events, summaries, and health checks.
- **Data contract:** provenance-labelled synthetic fixture; observed and simulated values are kept explicit.
- **Deployment-ready:** Vercel configuration, Docker API image, AWS target architecture, local verification commands, and environment template.

## Local quick start

```bash
# frontend
npm ci --prefix frontend
npm run dev --prefix frontend

# API (Python 3.13 recommended)
python3.13 -m venv backend/.venv313
backend/.venv313/bin/pip install -r backend/requirements.txt
backend/.venv313/bin/uvicorn app.main:app --reload --port 8000 --app-dir backend
```

The frontend targets the public demo API by default and switches to its deterministic local fixture when that API is unreachable. Override `VITE_API_BASE_URL` for another environment. See [`infra/README.md`](infra/README.md) for AWS architecture and evidence boundaries.

## Live demo

Static frontend demo: https://roadscope-ai-demo.vercel.app

Live API health endpoint: https://6zwr3ongsqiy22oiefyn3wwtva0gunpt.lambda-url.us-east-2.on.aws/health

The live page is connected to the AWS Lambda Function URL and retains the deterministic fixture fallback if the API is unreachable.

GitHub Actions are intentionally disabled to avoid consuming hosted runner minutes. Run `npm run build --prefix frontend` and `backend/.venv-test/bin/pytest -q backend/tests` locally before deployment.
