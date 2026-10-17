"""Curated-data access: S3 (DATA_BUCKET/curated/) with a 10-minute in-memory cache, else local files."""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

TTL_SECONDS = 600
PREFIX = "curated/"
_DEFAULT_DIR = Path(__file__).resolve().parents[2] / "data" / "curated"


class MissingData(LookupError):
    """Raised when a curated file does not exist."""


_cache: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()


def _bucket() -> str | None:
    return os.environ.get("DATA_BUCKET") or None


def curated_dir() -> Path:
    return Path(os.environ.get("CURATED_DIR", str(_DEFAULT_DIR)))


def _s3() -> Any:
    import boto3

    return boto3.client("s3")


def clear_cache() -> None:
    with _lock:
        _cache.clear()


def _cached(key: str, loader: Any) -> Any:
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < TTL_SECONDS:
            return hit[1]
    value = loader()
    with _lock:
        _cache[key] = (now, value)
    return value


def load(name: str) -> Any:
    """Load a curated JSON/GeoJSON file by its relative name, e.g. 'spf.json'."""
    if ".." in Path(name).parts:
        raise MissingData(name)

    def loader() -> Any:
        bucket = _bucket()
        if bucket:
            client = _s3()
            try:
                body = client.get_object(Bucket=bucket, Key=PREFIX + name)["Body"].read()
            except client.exceptions.NoSuchKey as exc:
                raise MissingData(name) from exc
            return json.loads(body)
        path = curated_dir() / name
        if not path.is_file():
            raise MissingData(name)
        return json.loads(path.read_text(encoding="utf-8"))

    return _cached("file:" + name, loader)


def list_names(subdir: str) -> list[str]:
    """Relative file names under a curated sub-directory (e.g. 'intersections')."""

    def loader() -> list[str]:
        bucket = _bucket()
        if bucket:
            names: list[str] = []
            pages = _s3().get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=f"{PREFIX}{subdir}/")
            for page in pages:
                names += [o["Key"][len(PREFIX):] for o in page.get("Contents", [])]
            return sorted(names)
        root = curated_dir() / subdir
        if not root.is_dir():
            return []
        return sorted(f"{subdir}/{p.name}" for p in root.iterdir() if p.is_file())

    return _cached("list:" + subdir, loader)


def list_runs(limit: int = 10) -> list[dict[str, Any]]:
    """Most recent ingest-run objects under curated/runs/ (newest first)."""
    bucket = _bucket()
    if bucket:
        objs: list[dict[str, Any]] = []
        for page in _s3().get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=PREFIX + "runs/"):
            objs += page.get("Contents", [])
        objs.sort(key=lambda o: o["LastModified"], reverse=True)
        out = []
        for o in objs[:limit]:
            name = o["Key"][len(PREFIX):]
            try:
                detail = load(name) if name.endswith(".json") else None
            except (MissingData, ValueError):
                detail = None
            out.append({"key": o["Key"], "size": o["Size"], "last_modified": o["LastModified"].isoformat(), "detail": detail})
        return out
    root = curated_dir() / "runs"
    if not root.is_dir():
        return []
    files = sorted((p for p in root.iterdir() if p.is_file()), key=lambda p: p.stat().st_mtime, reverse=True)
    out = []
    for p in files[:limit]:
        try:
            detail = json.loads(p.read_text(encoding="utf-8")) if p.suffix == ".json" else None
        except ValueError:
            detail = None
        out.append({"key": f"{PREFIX}runs/{p.name}", "size": p.stat().st_size,
                    "last_modified": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(p.stat().st_mtime)), "detail": detail})
    return out


def intersection_ids() -> list[str]:
    ids = []
    for name in list_names("intersections"):
        stem = Path(name).name
        if stem.endswith(".json") and stem != "index.json" and not stem.endswith(("_conflicts.json", "_repair.json", "_ssm.json")):
            ids.append(stem[: -len(".json")])
    return ids
