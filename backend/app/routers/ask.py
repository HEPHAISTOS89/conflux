"""POST /ask — analyst question answering."""
from __future__ import annotations

import os
import time

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from .. import ask
from ..models import AskRequest, AskResponse

router = APIRouter()


# Both limits live in memory, so they are per warm Lambda container, not global. The real Bedrock
# spend ceiling is account Lambda concurrency (10) x DAILY_CAP Bedrock attempts per day.
DAILY_CAP = 400  # Bedrock attempts per container per day; beyond it answers use the deterministic fallback
_day = {"date": "", "count": 0}


def client_ip(request: Request) -> str:
    # Key on the caller address API Gateway observed (requestContext.http.sourceIp): it cannot be
    # set by the client, unlike X-Forwarded-For. Behind the Vercel proxy this groups visitors by
    # Vercel egress IP (all proxied visitors share a few), hence the 30/min bucket. Never trust
    # X-Forwarded-For / x-vercel-* here: the execute-api URL is public, so those are spoofable.
    event = request.scope.get("aws.event") or {}
    src = ((event.get("requestContext") or {}).get("http") or {}).get("sourceIp")
    if src:
        return src
    return request.client.host if request.client else "unknown"


def _within_daily_cap() -> bool:
    today = time.strftime("%Y-%m-%d", time.gmtime())
    if _day["date"] != today:
        _day.update(date=today, count=0)
    _day["count"] += 1
    return _day["count"] <= DAILY_CAP


@router.post("/ask", response_model=AskResponse)
async def post_ask(body: AskRequest, request: Request) -> AskResponse:
    question = body.question.strip()
    if not question:
        raise HTTPException(422, "question must not be empty")
    if len(question) > ask.MAX_QUESTION_CHARS:
        raise HTTPException(422, f"question exceeds {ask.MAX_QUESTION_CHARS} characters")
    if not ask.bucket.allow(client_ip(request)):
        raise HTTPException(429, f"rate limit: {ask.bucket.capacity} questions per minute per client",
                            headers={"Retry-After": "2"})
    use_bedrock = bool(os.environ.get("BEDROCK_MODEL_ID")) and _within_daily_cap()
    return AskResponse(**await run_in_threadpool(ask.answer if use_bedrock else ask.ask_fallback, question))
