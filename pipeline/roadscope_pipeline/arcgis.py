"""Minimal ArcGIS FeatureServer client: paginated query, outSR=4326, retries, raw cache."""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import requests

from .sources import LAYERS, LUBBOCK_ENVELOPE, TXDOT_LICENCE, layer_url, now_iso

PAGE = 2000


def _get(url: str, params: dict, retries: int = 4) -> dict:
    for attempt in range(retries):
        try:
            r = requests.get(url, params=params, timeout=60)
            r.raise_for_status()
            data = r.json()
            if "error" in data:
                raise RuntimeError(data["error"])
            return data
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
    raise AssertionError("unreachable")


def query_all(url: str, where: str = "1=1", envelope=None, out_fields: str = "*", geometry: bool = True) -> list[dict]:
    params = {
        "where": where, "outFields": out_fields, "outSR": 4326, "f": "json",
        "returnGeometry": str(geometry).lower(), "resultRecordCount": PAGE,
    }
    if envelope:
        params.update(geometry=",".join(map(str, envelope)), geometryType="esriGeometryEnvelope",
                      inSR=4326, spatialRel="esriSpatialRelIntersects")
    feats: list[dict] = []
    while True:
        data = _get(f"{url}/query", {**params, "resultOffset": len(feats)})
        page = data.get("features", [])
        feats.extend(page)
        if not page or not (data.get("exceededTransferLimit") or len(page) == PAGE):
            return feats


def fetch_layer(key: str, raw_dir: Path, refresh: bool = False) -> tuple[list[dict], dict]:
    """Return (features, manifest source entry); caches raw JSON in raw_dir."""
    cfg = LAYERS[key]
    raw_dir = Path(raw_dir)
    cache = raw_dir / f"{key}.json"
    url = layer_url(key)
    if cache.exists() and not refresh:
        blob = cache.read_bytes()
        payload = json.loads(blob)
    else:
        feats = query_all(url, cfg["where"], LUBBOCK_ENVELOPE if cfg["envelope"] else None)
        payload = {"url": url, "where": cfg["where"], "fetched_at": now_iso(), "features": feats}
        blob = json.dumps(payload).encode()
        raw_dir.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(blob)
    entry = {
        "id": key, "url": url, "licence": TXDOT_LICENCE, "records": len(payload["features"]),
        "fetched_at": payload["fetched_at"], "sha256": hashlib.sha256(blob).hexdigest(),
    }
    return payload["features"], entry
