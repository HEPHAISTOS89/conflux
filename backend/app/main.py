"""RoadScope API — FastAPI app serving curated Lubbock safety data under /api/v1."""
from __future__ import annotations

import json
import logging
import os
import re
import sys
import time
from typing import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from .routers import ask, data, intersections, ops

DEFAULT_ORIGINS = "http://localhost:5173,https://*.vercel.app"


def _setup_logging() -> logging.Logger:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(message)s"))
    root = logging.getLogger("roadscope")
    root.handlers[:] = [handler]
    root.setLevel(logging.INFO)
    root.propagate = False
    return root.getChild("http")


def cors_config(raw: str) -> tuple[list[str], str | None]:
    """Split configured origins into exact matches and a regex for '*' wildcards."""
    exact, patterns = [], []
    for o in (s.strip().rstrip("/") for s in raw.split(",")):
        if not o:
            continue
        if "*" in o:
            patterns.append(re.escape(o).replace(r"\*", r"[A-Za-z0-9-]+"))
        else:
            exact.append(o)
    return exact, ("^(" + "|".join(patterns) + ")$") if patterns else None


log = _setup_logging()
app = FastAPI(title="RoadScope API", version=ops.VERSION, docs_url="/api/v1/docs", openapi_url="/api/v1/openapi.json")
_origins, _regex = cors_config(os.environ.get("CORS_ORIGINS", DEFAULT_ORIGINS))
# The regional network GeoJSON is ~3 MB; API Gateway does not compress, so gzip here (Mangum base64-encodes it).
app.add_middleware(GZipMiddleware, minimum_size=2048)
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_origin_regex=_regex,
                   allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["*"], expose_headers=["ETag"], max_age=600)


@app.middleware("http")
async def access_log(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    start = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        log.info(json.dumps({"method": request.method, "path": request.url.path, "status": status,
                             "ms": round((time.perf_counter() - start) * 1000, 1)}))


for r in (ops.router, data.router, intersections.router, ask.router):
    app.include_router(r, prefix="/api/v1")
