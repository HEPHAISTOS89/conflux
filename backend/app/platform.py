"""Platform status (curated manifest, ingest runs, CloudWatch Lambda metrics) and the on-demand ingest trigger."""
from __future__ import annotations

import datetime as dt
import json
import logging
import os
from typing import Any

from . import store

log = logging.getLogger("roadscope.platform")
METRICS = (("invocations", "Invocations", "Sum"), ("errors", "Errors", "Sum"), ("duration_p95_ms", "Duration", "p95"))
COOLDOWN_S = 30 * 60
FAILED_COOLDOWN_S = 5 * 60
LOCK_KEY = "ops/ingest-trigger.json"
STALE_RUNNING_S = 16 * 60  # Lambda timeout is 15 min: a "running" record older than this never finished


def on_aws() -> bool:
    return bool(os.environ.get("AWS_LAMBDA_FUNCTION_NAME"))


def function_names() -> dict[str, str]:
    names = {"api": os.environ.get("API_FUNCTION_NAME") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME", ""),
             "ingest": os.environ.get("INGEST_FUNCTION_NAME", "")}
    return {k: v for k, v in names.items() if v}


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(s: Any) -> dt.datetime | None:
    if not isinstance(s, str) or not s:
        return None
    try:
        t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def _s3() -> Any:
    import boto3

    return boto3.client("s3")


def lambda_metrics(days: int = 7) -> dict[str, Any]:
    import boto3

    end = _now().replace(minute=0, second=0, microsecond=0)
    start = end - dt.timedelta(days=days)
    funcs = function_names()
    queries = []
    for fkey, fname in funcs.items():
        for mkey, metric, stat in METRICS:
            queries.append({
                "Id": f"{fkey}_{mkey}".lower(),
                "Label": f"{fkey}:{mkey}",
                "MetricStat": {
                    "Metric": {"Namespace": "AWS/Lambda", "MetricName": metric,
                               "Dimensions": [{"Name": "FunctionName", "Value": fname}]},
                    "Period": 86400,
                    "Stat": stat,
                },
            })
    out: dict[str, Any] = {"window_days": days, "start": start.isoformat(), "end": end.isoformat(),
                           "functions": {k: {"name": v} for k, v in funcs.items()}}
    if not queries:
        return out
    resp = boto3.client("cloudwatch").get_metric_data(MetricDataQueries=queries, StartTime=start, EndTime=end,
                                                      ScanBy="TimestampAscending")
    for r in resp["MetricDataResults"]:
        fkey, mkey = r["Label"].split(":", 1)
        series = [{"t": t.isoformat(), "v": v} for t, v in zip(r["Timestamps"], r["Values"])]
        vals = r["Values"]
        total = max(vals) if mkey.startswith("duration") and vals else sum(vals)
        out["functions"][fkey][mkey] = {"total" if not mkey.startswith("duration") else "max_daily": total,
                                        "daily": series}
    return out


# ---------- run records ----------
_seen: dict[str, str | None] = {"latest_ok": None}


def list_runs(limit: int = 10) -> list[dict[str, Any]]:
    """Run records, newest first. On S3 the bodies are read uncached: the ingest rewrites its record in
    place when it moves from "running" to "succeeded"/"failed", and the 10-minute data cache would hide that."""
    bucket = os.environ.get("DATA_BUCKET")
    if not bucket:
        return store.list_runs(limit)
    s3 = _s3()
    objs: list[dict[str, Any]] = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=store.PREFIX + "runs/"):
        objs += page.get("Contents", [])
    objs.sort(key=lambda o: o["LastModified"], reverse=True)
    out = []
    for o in objs[:limit]:
        detail = None
        if o["Key"].endswith(".json"):
            try:
                detail = json.loads(s3.get_object(Bucket=bucket, Key=o["Key"])["Body"].read())
            except Exception as exc:  # noqa: BLE001 - one unreadable record must not hide the others
                log.warning("run record %s unreadable: %s", o["Key"], type(exc).__name__)
        lm = o["LastModified"]
        out.append({"key": o["Key"], "size": o["Size"],
                    "last_modified": lm.isoformat() if hasattr(lm, "isoformat") else str(lm), "detail": detail})
    return out


def _refresh_if_new_ingest(runs: list[dict[str, Any]]) -> None:
    """A newly finished ingest rewrote curated/: drop this container's data cache so every endpoint serves it."""
    ok = next((r["key"] for r in runs if (r.get("detail") or {}).get("job") == "ingest"
               and (r.get("detail") or {}).get("status") == "succeeded"), None)
    if ok and _seen["latest_ok"] not in (None, ok):
        store.clear_cache()
    _seen["latest_ok"] = ok


def status() -> dict[str, Any]:
    errors: list[str] = []
    manifest: dict[str, Any] | None = None
    runs: list[dict[str, Any]] = []
    try:
        runs = list_runs()
        _refresh_if_new_ingest(runs)
    except Exception as exc:  # noqa: BLE001 - surfaced to the client as a status message
        log.warning("runs listing failed: %s: %s", type(exc).__name__, exc)
        errors.append(f"runs listing failed: {type(exc).__name__}")
    try:
        manifest = store.load("manifest.json")
    except store.MissingData:
        errors.append("manifest.json not found in curated store")
    metrics = None
    if on_aws():
        try:
            metrics = lambda_metrics()
        except Exception as exc:  # noqa: BLE001 - only the exception type is public; full text goes to logs
            log.warning("CloudWatch metrics failed: %s: %s", type(exc).__name__, exc)
            errors.append(f"CloudWatch metrics unavailable: {type(exc).__name__}")
    return {"on_aws": on_aws(), "data_source": data_source(), "manifest": manifest, "runs": runs,
            "metrics": metrics, "errors": errors}


def data_source() -> str:
    bucket = os.environ.get("DATA_BUCKET")
    return f"s3://{bucket}/{store.PREFIX}" if bucket else f"local:{store.curated_dir()}"


# ---------- on-demand ingest ----------
class TriggerError(Exception):
    """Refusal with an HTTP status, a machine code and a public message."""

    def __init__(self, status: int, code: str, message: str, retry_after: int | None = None, **extra: Any) -> None:
        super().__init__(message)
        self.status, self.code, self.message, self.retry_after, self.extra = status, code, message, retry_after, extra

    def body(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, **({"retry_after_s": self.retry_after} if self.retry_after else {}),
                **self.extra}


def trigger_config() -> tuple[str, str] | None:
    """(bucket, ingest function name) when this process can start a real ingest, else None."""
    bucket, fn = os.environ.get("DATA_BUCKET"), os.environ.get("INGEST_FUNCTION_NAME")
    return (bucket, fn) if on_aws() and bucket and fn else None


def _read_lock(s3: Any, bucket: str) -> tuple[dict[str, Any] | None, str | None]:
    from botocore.exceptions import ClientError

    try:
        obj = s3.get_object(Bucket=bucket, Key=LOCK_KEY)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404", "AccessDenied"):
            return None, None
        raise
    try:
        return json.loads(obj["Body"].read()), obj.get("ETag")
    except ValueError:
        return None, obj.get("ETag")


def _next_allowed(lock: dict[str, Any] | None, runs: list[dict[str, Any]], now: dt.datetime) -> dt.datetime | None:
    """When the next manual run may start: 30 min after an accepted trigger or a running/succeeded ingest,
    5 min after a failed one (long enough for Lambda's own async retries at +1 and +3 min)."""
    ends: list[dt.datetime] = []
    soon = now + dt.timedelta(minutes=1)
    ingest = [r.get("detail") or {} for r in runs if (r.get("detail") or {}).get("job") == "ingest"]
    if lock and lock.get("state") == "accepted" and (t := _parse(lock.get("requested_at"))):
        if not any(d.get("requested_at") == lock.get("requested_at") for d in ingest):  # its run has not reported yet
            ends.append(t + dt.timedelta(seconds=COOLDOWN_S))
    for d in ingest:
        times = [t for k in ("started_at", "finished_at") if (t := _parse(d.get(k))) and t <= soon]
        if not times:
            continue
        if d.get("status") == "failed":
            ends.append(max(times) + dt.timedelta(seconds=FAILED_COOLDOWN_S))
        else:
            ends.append(max(times) + dt.timedelta(seconds=COOLDOWN_S))
    return max(ends) if ends else None


def cooldown(lock: dict[str, Any] | None, runs: list[dict[str, Any]], now: dt.datetime) -> tuple[int, dt.datetime | None]:
    """Seconds until the next manual run is allowed (0 = allowed now), and when."""
    nxt = _next_allowed(lock, runs, now)
    if nxt is None:
        return 0, None
    return max(0, int((nxt - now).total_seconds() + 0.999)), nxt


def ingest_state() -> dict[str, Any]:
    """What the Run ingest control may do right now. Never claims availability it cannot deliver."""
    cfg = trigger_config()
    if not cfg:
        msg = ("On-demand ingest is not configured on this deployment yet (IAM grant pending); the weekly EventBridge run is unaffected."
               if on_aws() else "Ingest runs on AWS Lambda. This server is not running on AWS, so nothing can be started here.")
        return {"available": False, "code": "aws_only", "cooldown_s": COOLDOWN_S,
                "message": msg,
                "retry_after_s": 0, "next_allowed_at": None, "last_trigger": None}
    bucket, _ = cfg
    lock, _ = _read_lock(_s3(), bucket)
    wait, nxt = cooldown(lock, list_runs(), _now())
    return {"available": wait == 0, "code": "ready" if wait == 0 else "cooldown", "cooldown_s": COOLDOWN_S,
            "message": "Ready" if wait == 0 else "An ingest ran recently; one manual run per 30 minutes.",
            "retry_after_s": wait, "next_allowed_at": _iso(nxt) if nxt and wait else None,
            "last_trigger": {k: lock.get(k) for k in ("requested_at", "state")} if lock else None}


def _put_lock(s3: Any, bucket: str, body: dict[str, Any], etag: str | None) -> None:
    """Conditional write so two concurrent clicks cannot both start a run (S3 conditional writes)."""
    from botocore.exceptions import ClientError, ParamValidationError

    kw: dict[str, Any] = {"Bucket": bucket, "Key": LOCK_KEY, "ContentType": "application/json",
                          "Body": json.dumps(body).encode()}
    cond = {"IfMatch": etag} if etag else {"IfNoneMatch": "*"}
    try:
        s3.put_object(**kw, **cond)
    except ParamValidationError:  # older botocore without conditional writes: last writer wins
        s3.put_object(**kw)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in ("PreconditionFailed", "ConditionalRequestConflict"):
            raise TriggerError(429, "cooldown", "Another ingest was started a moment ago.", retry_after=COOLDOWN_S) from exc
        raise


def start_ingest() -> dict[str, Any]:
    """Invoke the ingest Lambda asynchronously (InvocationType=Event) after the cooldown check."""
    cfg = trigger_config()
    if not cfg:
        raise TriggerError(503, "aws_only", "On-demand ingest is not configured on this deployment yet; nothing was started."
                           if on_aws() else "Ingest runs on AWS Lambda. This server is not running on AWS, so nothing was started.")
    bucket, fn = cfg
    s3 = _s3()
    now = _now()
    lock, etag = _read_lock(s3, bucket)
    wait, nxt = cooldown(lock, list_runs(), now)
    if wait > 0:
        raise TriggerError(429, "cooldown", "An ingest ran recently; one manual run per 30 minutes.", retry_after=wait,
                           next_allowed_at=_iso(nxt) if nxt else None)
    requested_at = _iso(now)
    _put_lock(s3, bucket, {"requested_at": requested_at, "state": "accepted", "function": fn}, etag)
    import boto3

    payload = {"source": "roadscope.platform", "trigger": "manual", "requested_at": requested_at}
    try:
        resp = boto3.client("lambda").invoke(FunctionName=fn, InvocationType="Event", Payload=json.dumps(payload).encode())
        code = resp.get("StatusCode")
        if code != 202:
            raise RuntimeError(f"Lambda returned status {code}")
    except Exception as exc:  # noqa: BLE001 - release the cooldown so the user can retry; type only is public
        log.warning("ingest invoke failed: %s: %s", type(exc).__name__, exc)
        try:
            s3.put_object(Bucket=bucket, Key=LOCK_KEY, ContentType="application/json",
                          Body=json.dumps({"requested_at": requested_at, "state": "invoke_failed",
                                           "error": type(exc).__name__}).encode())
        except Exception:  # noqa: BLE001
            log.warning("could not release ingest lock")
        raise TriggerError(502, "invoke_failed", f"AWS Lambda refused the invocation ({type(exc).__name__}).") from exc
    log.info(json.dumps({"event": "ingest_triggered", "function": fn, "requested_at": requested_at}))
    return {"status": "accepted", "function": fn, "requested_at": requested_at, "invocation": "Event",
            "cooldown_s": COOLDOWN_S, "next_allowed_at": _iso(now + dt.timedelta(seconds=COOLDOWN_S)),
            "poll": "/api/v1/platform/status", "timeout_s": 180}
