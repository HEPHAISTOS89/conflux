"""POST /ask — analyst question answering."""
from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from .. import ask
from ..models import AskRequest, AskResponse

router = APIRouter()


DAILY_CAP = 400  # global ceiling per warm container: bounds Bedrock spend whatever the client identity
_day = {"date": "", "count": 0}


def client_ip(request: Request) -> str:
    # Left-most X-Forwarded-For entries are client-supplied and spoofable; the right-most one is
    # appended by the last trusted proxy (CloudFront), so key the bucket on it.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[-1].strip()
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
        raise HTTPException(429, "rate limit: 10 questions per minute per client", headers={"Retry-After": "6"})
    if not _within_daily_cap():
        raise HTTPException(429, "daily question budget reached; try again tomorrow")
    return AskResponse(**await run_in_threadpool(ask.answer, question))
