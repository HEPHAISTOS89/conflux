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
from .trajectory import site as site_mod

SITE_FILES = ("site.json", "tracks.csv", "tracks.json")

CURATED = ["network.geojson", "corridors.json", "vru_crashes.geojson", "spf.json", "counties.geojson", "manifest.json"]
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


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _put_run(s3, bucket, run_id, record):
    s3.put_object(Bucket=bucket, Key=f"curated/runs/{run_id}.json", ContentType="application/json",
                  Body=json.dumps({"run_id": run_id, "job": "ingest", **record}, default=str).encode())


def site_drop(event) -> tuple[str, str] | None:
    """(bucket, site_id) when the event is an EventBridge 'Object Created' for sites/<site_id>/tracks.*, else None."""
    if not isinstance(event, dict) or event.get("source") != "aws.s3" or event.get("detail-type") != "Object Created":
        return None
    d = event.get("detail") or {}
    key = str((d.get("object") or {}).get("key", ""))
    parts = key.split("/")
    if len(parts) != 3 or parts[0] != "sites" or parts[2] not in ("tracks.csv", "tracks.json"):
        return None
    return str((d.get("bucket") or {}).get("name", "")), parts[1]


def handler(event, ctx):
    """One run record per invocation, written at start ("running") and rewritten in place when it ends.
    Two jobs share the function: the weekly ArcGIS refresh (schedule or manual trigger) and the site
    trajectory drop (EventBridge S3 event for sites/<site_id>/tracks.csv|json)."""
    bucket = os.environ["DATA_BUCKET"]
    s3 = boto3.client("s3")
    t0 = time.time()
    event = event if isinstance(event, dict) else {}
    drop = site_drop(event)
    if drop:
        if drop[0] and drop[0] != bucket:
            raise ValueError(f"site drop event for bucket {drop[0]!r}, expected {bucket!r}")
        return site_handler(bucket, s3, ctx, t0, drop[1])
    manual = event.get("trigger") == "manual"
    meta = {"trigger": "manual" if manual else "schedule", "started_at": _now(),
            **({"requested_at": event.get("requested_at")} if manual and event.get("requested_at") else {}),
            "request_id": getattr(ctx, "aws_request_id", None)}
    run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    _put_run(s3, bucket, run_id, {"status": "running", **meta})
    try:
        return _run(bucket, s3, ctx, t0, run_id, meta)
    except Exception as e:
        _put_run(s3, bucket, run_id, {"status": "failed", **meta, "error": type(e).__name__,
                                      "finished_at": _now(),
                                      "seconds": round(time.time() - t0, 1)})
        log("ingest_failed", error=type(e).__name__, message=str(e)[:500])
        raise


def _run(bucket, s3, ctx, t0, run_id, meta):
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
        published = json.loads((out / "manifest.json").read_text())
    secs = round(time.time() - t0, 1)
    pub = [x for x in published.get("sources", []) if not str(x.get("id", "")).startswith("ngsim")]
    flat = {k: v for k, v in metrics.items() if not isinstance(v, dict)}
    _put_run(s3, bucket, run_id, {**flat, "status": "succeeded", **meta, "finished_at": _now(), "seconds": secs,
                                  "records": sum(int(x.get("records") or 0) for x in pub), "sources": len(pub),
                                  "manifest_generated_at": published.get("generated_at")})
    log("ingest_done", seconds=round(time.time() - t0, 1), **{k: v for k, v in metrics.items() if not isinstance(v, dict)})
    return {"ok": True, **metrics}


# ---------------------------------------------------------------- site trajectory drop

def _put_site_run(s3, bucket, run_id, record):
    s3.put_object(Bucket=bucket, Key=f"curated/runs/{run_id}.json", ContentType="application/json",
                  Body=json.dumps({"run_id": run_id, "job": "site", **record}, default=str).encode())


def site_handler(bucket, s3, ctx, t0, site_id):
    """sites/<site_id>/{site.json, tracks.csv|json} -> converter + SSM -> curated/intersections/<site_id>*.json,
    index.json and manifest.json (uploaded last). Failures are logged as site_ingest_failed (CloudWatch
    metric filter -> roadscope-site-ingest-failed alarm) and re-raised so Lambda retries and the DLQ apply."""
    run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"-{site_id}"
    meta = {"trigger": "s3_drop", "site": site_id, "started_at": _now(), "request_id": getattr(ctx, "aws_request_id", None)}
    _put_site_run(s3, bucket, run_id, {"status": "running", **meta})
    try:
        res = _site_run(bucket, s3, ctx, site_id)
    except Exception as e:
        _put_site_run(s3, bucket, run_id, {"status": "failed", **meta, "error": type(e).__name__, "message": str(e)[:500],
                                           "finished_at": _now(), "seconds": round(time.time() - t0, 1)})
        log("site_ingest_failed", site=site_id, error=type(e).__name__, message=str(e)[:500])
        raise
    secs = round(time.time() - t0, 1)
    _put_site_run(s3, bucket, run_id, {"status": "succeeded", **meta, "finished_at": _now(), "seconds": secs,
                                       "records": res["records"], "tracks": res["tracks"], "conflicts": res["conflicts"],
                                       "by_type": res["by_type"]})
    log("site_ingest_done", site=site_id, seconds=secs, tracks=res["tracks"], conflicts=res["conflicts"])
    return {"ok": True, "site": site_id, **{k: v for k, v in res.items() if k != "written"}}


def _download_optional(s3, bucket, key, dest: Path) -> bool:
    try:
        s3.download_file(bucket, key, str(dest))
        return True
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            return False
        raise


def _site_run(bucket, s3, ctx, site_id):
    if not site_mod.ID_RE.fullmatch(site_id):
        raise site_mod.SiteError(f"site id {site_id!r} must match {site_mod.ID_RE.pattern}")
    with tempfile.TemporaryDirectory() as tmp:
        folder, out = Path(tmp, "site"), Path(tmp, "curated")
        folder.mkdir(); (out / "intersections").mkdir(parents=True)
        got = [n for n in SITE_FILES if _download_optional(s3, bucket, f"sites/{site_id}/{n}", folder / n)]
        if "site.json" not in got:
            raise site_mod.SiteError(f"sites/{site_id}/site.json missing: upload site.json before tracks.csv")
        if not any(n.startswith("tracks.") for n in got):
            raise site_mod.SiteError(f"sites/{site_id}/tracks.csv|tracks.json missing")
        # merge into the live index and manifest so the other sites and sources are kept
        _download_optional(s3, bucket, "curated/intersections/index.json", out / "intersections" / "index.json")
        _download_optional(s3, bucket, "curated/manifest.json", out / "manifest.json")
        log("site_ingest_start", site=site_id, files=got)
        site = site_mod.read_site(folder)
        if site["id"] != site_id:
            raise site_mod.SiteError(f"site.json id {site['id']!r} != prefix {site_id!r}")
        res = site_mod.convert_folder(folder, out, repair=False)
        if ctx.get_remaining_time_in_millis() < 30_000:
            raise TimeoutError(f"{ctx.get_remaining_time_in_millis()} ms left before upload; aborting")
        for name in (f"{site_id}.json", f"{site_id}_conflicts.json", f"{site_id}_ssm.json"):
            s3.upload_file(str(out / "intersections" / name), bucket, f"curated/intersections/{name}",
                           ExtraArgs={"ContentType": "application/json"})
        for name in ("intersections/index.json", "manifest.json"):   # last: readers see the site only once its files exist
            s3.upload_file(str(out / name), bucket, f"curated/{name}", ExtraArgs={"ContentType": "application/json"})
    return res
