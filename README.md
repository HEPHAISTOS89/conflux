# RoadScope AI

RoadScope AI is an evidence-first road-safety intelligence prototype: synchronized trajectory analytics, risk-event detection, and a clean 2D/3D replay workspace.

## Prototype scope

- **Web:** React + TypeScript + Vite, with an interactive replay surface and analytical dashboard.
- **API:** FastAPI + Pydantic, deterministic demo trajectory data, risk events, and health checks.
- **Data contract:** provenance-labelled demo data; observed/simulated values are kept explicit.
- **Deployment-ready:** Docker and AWS/Vercel configuration are prepared separately from live cloud mutations.

## Local quick start

```bash
# web
cd apps/web && npm install && npm run dev

# api
cd services/api && python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt && uvicorn app.main:app --reload --port 8000
```

See each app's README for commands and verification details. No production or AWS proof is claimed by local tests.
