"""POST /ask — analyst question answering."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from .. import ask
from ..models import AskRequest, AskResponse

router = APIRouter()


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@router.post("/ask", response_model=AskResponse)
async def post_ask(body: AskRequest, request: Request) -> AskResponse:
    question = body.question.strip()
    if not question:
        raise HTTPException(422, "question must not be empty")
    if len(question) > ask.MAX_QUESTION_CHARS:
        raise HTTPException(422, f"question exceeds {ask.MAX_QUESTION_CHARS} characters")
    if not ask.bucket.allow(client_ip(request)):
        raise HTTPException(429, "rate limit: 10 questions per minute per client", headers={"Retry-After": "6"})
    return AskResponse(**await run_in_threadpool(ask.answer, question))
