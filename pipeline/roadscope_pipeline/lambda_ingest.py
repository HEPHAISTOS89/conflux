"""Weekly ingest Lambda: refresh ArcGIS layers -> raw/ + curated/ in s3://$DATA_BUCKET.

Runs with requests + numpy + pandas only (no scipy/statsmodels): the NB SPFs are not refit here.
The site-type models (``site_types[*].model``), the pooled site-type ``fallback`` and the pooled
(b0, b1, k) are read from the existing curated/spf.json in S3 and applied to the refreshed data;
EB, critical rates, goodness-of-fit and CURE data are recomputed. A spf.json that predates the
site-type SPFs makes the run fail loudly (run build_network on the batch worker first). FARS
(annual release) and the SPF refit run in build_network on the batch worker.
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

from .build_network import build
from .sources import LAYERS

CURATED = ["network.geojson", "corridors.json", "vru_crashes.geojson", "spf.json", "manifest.json"]
TYPES = {".json": "application/json", ".geojson": "application/geo+json"}


def log(event, **kw):
    print(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event, **kw}))


def _gate(prev: dict, new: dict, metrics: dict):
    """Refuse to publish a refresh that lost half of any ArcGIS layer or of the screened segments."""
    old = {s["id"]: s.get("records") for s in prev.get("sources", [])}
    cur = {s["id"]: s.get("records") for s in new.get("sources", [])}
    bad = [f"{k} records {cur.get(k)} < 50% of {old[k]}" for k in LAYERS
           if old.get(k) and (cur.get(k) or 0) < 0.5 * old[k]]
    p, n = prev.get("metrics", {}).get("segments_screened"), metrics.get("segments_screened")
    if p and (n or 0) < 0.5 * p:
        bad.append(f"segments_screened {n} < 50% of {p}")
    if bad:
        raise RuntimeError("sanity gate failed: " + "; ".join(bad))


def handler(event, ctx):
    bucket = os.environ["DATA_BUCKET"]
    s3 = boto3.client("s3")
    t0 = time.time()
    try:
        return _run(bucket, s3, ctx, t0)
    except Exception as e:
        run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        s3.put_object(Bucket=bucket, Key=f"curated/runs/{run_id}.json", ContentType="application/json",
                      Body=json.dumps({"run_id": run_id, "job": "ingest", "status": "failed",
                                       "error": type(e).__name__,
                                       "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                       "seconds": round(time.time() - t0, 1)}).encode())
        log("ingest_failed", error=type(e).__name__, message=str(e)[:500])
        raise


def _run(bucket, s3, ctx, t0):
    with tempfile.TemporaryDirectory() as tmp:
        raw, out = Path(tmp, "raw"), Path(tmp, "curated")
        out.mkdir(parents=True)
        spf = json.loads(s3.get_object(Bucket=bucket, Key="curated/spf.json")["Body"].read())
        try:  # merge into the live manifest so trajectory sources are kept
            s3.download_file(bucket, "curated/manifest.json", str(out / "manifest.json"))
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") not in ("NoSuchKey", "404"):
                raise
        mpath = out / "manifest.json"
        prev = json.loads(mpath.read_text()) if mpath.exists() else {}
        log("ingest_start", bucket=bucket, spf_b0=spf["b0"], spf_b1=spf["b1"], spf_k=spf["k"],
            site_types=sorted(t for t, v in spf.get("site_types", {}).items() if v.get("fitted")))
        metrics = build(out, raw, refresh=True, fars=False, spf_existing=spf)
        _gate(prev, json.loads(mpath.read_text()), metrics)
        if ctx.get_remaining_time_in_millis() < 60_000:
            raise TimeoutError(f"{ctx.get_remaining_time_in_millis()} ms left before upload; aborting")
        for p in raw.glob("*.json"):
            s3.upload_file(str(p), bucket, f"raw/{p.name}", ExtraArgs={"ContentType": "application/json"})
        for name in CURATED:  # manifest.json is last: readers only see it once the data it lists is in place
            s3.upload_file(str(out / name), bucket, f"curated/{name}",
                           ExtraArgs={"ContentType": TYPES[Path(name).suffix]})
    secs = round(time.time() - t0, 1)
    run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    flat = {k: v for k, v in metrics.items() if not isinstance(v, dict)}
    s3.put_object(Bucket=bucket, Key=f"curated/runs/{run_id}.json", ContentType="application/json",
                  Body=json.dumps({"run_id": run_id, "job": "ingest", "status": "succeeded",
                                   "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                   "seconds": secs, **flat}, default=str).encode())
    log("ingest_done", seconds=round(time.time() - t0, 1), **{k: v for k, v in metrics.items() if not isinstance(v, dict)})
    return {"ok": True, **metrics}
