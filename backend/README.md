# RoadScope API

Run locally: `uvicorn app.main:app --reload --port 8000` from `backend/`.
API docs: `/docs`. The demo fixture is clearly labelled synthetic and exposes scenario, trajectory, summary, and risk-event contracts.

## Data and provenance

The bundled `ngsim-i80-demo` scenario is a deterministic **synthetic fixture inspired by the FHWA NGSIM schema**. It is not a copy of an official dataset and must not be presented as observed traffic. Every response exposes `provenance` and the root metadata endpoint exposes `data_mode=synthetic_fixture`. A production ingestion job should retain source URL/license, retrieval timestamp, checksum, schema version, and validation report before promoting data to `validated/` or `features/` storage.

## API contract

- `GET /health` — container/load-balancer health.
- `GET /` — service metadata and data mode.
- `GET /api/v1/scenarios` — typed scenario cards.
- `GET /api/v1/scenarios/{id}` — full vehicles and trajectories.
- `GET /api/v1/scenarios/{id}/summary` — aggregate risk and quality metrics.
- `GET /api/v1/scenarios/{id}/events?severity=...` — filtered risk events.
- `GET /api/v1/scenarios/{id}/vehicles?stride=1..10` — trajectory payload with optional sampling.
- `GET /api/v1/scenarios/{id}/frame?t=...` — synchronized vehicle positions and active events.
