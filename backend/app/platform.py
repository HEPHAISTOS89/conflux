"""Platform status: curated manifest, recent ingest runs, and CloudWatch Lambda metrics when on AWS."""
from __future__ import annotations

import datetime as dt
import logging
import os
from typing import Any

from . import store

log = logging.getLogger("roadscope.platform")
METRICS = (("invocations", "Invocations", "Sum"), ("errors", "Errors", "Sum"), ("duration_p95_ms", "Duration", "p95"))


def on_aws() -> bool:
    return bool(os.environ.get("AWS_LAMBDA_FUNCTION_NAME"))


def function_names() -> dict[str, str]:
    names = {"api": os.environ.get("API_FUNCTION_NAME") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME", ""),
             "ingest": os.environ.get("INGEST_FUNCTION_NAME", "")}
    return {k: v for k, v in names.items() if v}


def lambda_metrics(days: int = 7) -> dict[str, Any]:
    import boto3

    end = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
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


def status() -> dict[str, Any]:
    errors: list[str] = []
    manifest: dict[str, Any] | None = None
    runs: list[dict[str, Any]] = []
    try:
        manifest = store.load("manifest.json")
    except store.MissingData:
        errors.append("manifest.json not found in curated store")
    try:
        runs = store.list_runs()
    except Exception as exc:  # noqa: BLE001 - surfaced to the client as a status message
        log.warning("runs listing failed: %s: %s", type(exc).__name__, exc)
        errors.append(f"runs listing failed: {type(exc).__name__}")
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
