# RoadScope API

FastAPI service over the curated data contract in `docs/SPEC.md`, mounted at `/api/v1` (OpenAPI at `/api/v1/docs`).

- Local: `python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/uvicorn app.main:app --reload`
- Tests: `.venv/bin/python -m pytest -q` (fixtures in `tests/fixtures/`)
- Lambda: `app.lambda_handler.handler` (Mangum); runtime deps in `requirements-lambda.txt` (boto3 comes from the Lambda runtime).

Environment: `DATA_BUCKET` (read `s3://$DATA_BUCKET/curated/`, 10-min cache; unset → local `CURATED_DIR`, default `../data/curated`),
`CORS_ORIGINS` (comma list, `*` wildcards allowed), `BEDROCK_MODEL_ID`, `API_FUNCTION_NAME`, `INGEST_FUNCTION_NAME`.
`POST /ask` uses Bedrock Converse with tool use and falls back to a deterministic, data-cited answerer when Bedrock is unavailable.
