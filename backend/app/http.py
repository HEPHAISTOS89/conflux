"""Response helpers: validated JSON with ETag and public cache headers."""
from __future__ import annotations

import functools
import hashlib
from typing import Any

from fastapi import HTTPException, Request, Response
from pydantic import BaseModel, TypeAdapter

from . import store

CACHE_CONTROL = "public, max-age=300"


@functools.lru_cache(maxsize=None)
def _adapter(model: Any) -> TypeAdapter[Any]:
    return TypeAdapter(model)


def cached(request: Request, model: Any, data: Any) -> Response:
    """Validate `data` against `model`, serialise once, and honour If-None-Match."""
    adapter = _adapter(model)
    body = adapter.dump_json(adapter.validate_python(data), exclude_none=False)
    etag = '"' + hashlib.sha256(body).hexdigest()[:32] + '"'
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=body, media_type="application/json", headers=headers)


def load_or_404(fn: Any, *args: Any, what: str) -> Any:
    try:
        return fn(*args)
    except store.MissingData as exc:
        raise HTTPException(status_code=404, detail=f"{what} not found (curated file '{exc.args[0]}' is missing)") from exc


__all__ = ["cached", "load_or_404", "BaseModel"]
