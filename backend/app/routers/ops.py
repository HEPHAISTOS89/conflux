"""Health, platform status and the on-demand ingest trigger."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from .. import platform
from ..ask import TokenBucket
from ..models import Health, PlatformStatus
from .ask import client_ip

router = APIRouter()
VERSION = "1.0.0"
NO_STORE = {"Cache-Control": "no-store"}
trigger_bucket = TokenBucket(capacity=3, per_seconds=60.0)


@router.get("/health", response_model=Health)
def health() -> Health:
    return Health(status="ok", version=VERSION, data_source=platform.data_source())


@router.get("/platform/status", response_model=PlatformStatus)
def platform_status() -> JSONResponse:
    return JSONResponse(PlatformStatus(**platform.status()).model_dump(), headers=NO_STORE)


def _refusal(e: platform.TriggerError) -> JSONResponse:
    headers = dict(NO_STORE)
    if e.retry_after:
        headers["Retry-After"] = str(e.retry_after)
    return JSONResponse({"detail": e.body()}, status_code=e.status, headers=headers)


@router.get("/ops/ingest")
async def ingest_state() -> JSONResponse:
    """Whether a manual ingest can be started now (AWS only, 30-minute cooldown)."""
    try:
        return JSONResponse(await run_in_threadpool(platform.ingest_state), headers=NO_STORE)
    except Exception as exc:  # noqa: BLE001 - S3 unreachable: say so rather than guess
        return _refusal(platform.TriggerError(503, "state_unavailable", f"Could not read the ingest state ({type(exc).__name__})."))


@router.post("/ops/ingest", status_code=202)
async def start_ingest(request: Request) -> Any:
    """Start the ingest Lambda asynchronously. Takes no body; the cooldown is enforced server-side."""
    if (await request.body()).strip():
        return _refusal(platform.TriggerError(400, "body_not_accepted", "This endpoint takes no request body."))
    if not trigger_bucket.allow(client_ip(request)):
        return _refusal(platform.TriggerError(429, "rate_limited", "Too many requests from this client.", retry_after=20))
    try:
        return JSONResponse(await run_in_threadpool(platform.start_ingest), status_code=202, headers=NO_STORE)
    except platform.TriggerError as e:
        return _refusal(e)
