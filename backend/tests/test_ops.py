"""On-demand ingest trigger: AWS-only, body-less, cooldown and duplicate protection, honest failures."""
from __future__ import annotations

import datetime as dt
import io
import json
from typing import Any

import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient

from app import platform, store
from app.routers import ops

API = "/api/v1"


class FakeS3:
    def __init__(self, runs: dict[str, dict[str, Any]] | None = None) -> None:
        self.objs: dict[str, tuple[bytes, str]] = {}
        self.n = 0
        self.mtime: dict[str, dt.datetime] = {}
        for k, v in (runs or {}).items():
            self._set(f"curated/runs/{k}.json", json.dumps(v).encode())

    def _set(self, key: str, body: bytes) -> None:
        self.n += 1
        self.objs[key] = (body, f'"e{self.n}"')
        self.mtime[key] = dt.datetime(2026, 10, 17, tzinfo=dt.timezone.utc) + dt.timedelta(seconds=self.n)

    def get_object(self, Bucket: str, Key: str) -> dict[str, Any]:
        if Key not in self.objs:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "x"}}, "GetObject")
        body, etag = self.objs[Key]
        return {"Body": io.BytesIO(body), "ETag": etag}

    def put_object(self, Bucket: str, Key: str, Body: bytes, ContentType: str = "", IfMatch: str | None = None,
                   IfNoneMatch: str | None = None) -> dict[str, Any]:
        cur = self.objs.get(Key)
        if (IfNoneMatch == "*" and cur) or (IfMatch and (not cur or cur[1] != IfMatch)):
            raise ClientError({"Error": {"Code": "PreconditionFailed", "Message": "x"}}, "PutObject")
        self._set(Key, Body)
        return {}

    def get_paginator(self, _: str) -> Any:
        objs, mtime = self.objs, self.mtime

        class P:
            def paginate(self, Bucket: str, Prefix: str) -> list[dict[str, Any]]:
                return [{"Contents": [{"Key": k, "Size": len(v[0]), "LastModified": mtime[k]}
                                      for k, v in objs.items() if k.startswith(Prefix)]}]
        return P()


class FakeLambda:
    def __init__(self, status: int = 202, fail: bool = False) -> None:
        self.calls: list[dict[str, Any]] = []
        self.status, self.fail = status, fail

    def invoke(self, **kw: Any) -> dict[str, Any]:
        if self.fail:
            raise ClientError({"Error": {"Code": "AccessDeniedException", "Message": "no"}}, "Invoke")
        self.calls.append(kw)
        return {"StatusCode": self.status}


def iso(minutes_ago: float) -> str:
    return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture()
def aws(monkeypatch: pytest.MonkeyPatch) -> Any:
    def setup(runs: dict[str, dict[str, Any]] | None = None, lam: FakeLambda | None = None) -> tuple[FakeS3, FakeLambda]:
        s3, lm = FakeS3(runs), lam or FakeLambda()
        monkeypatch.setenv("AWS_LAMBDA_FUNCTION_NAME", "roadscope-api")
        monkeypatch.setenv("DATA_BUCKET", "b")
        monkeypatch.setenv("INGEST_FUNCTION_NAME", "roadscope-ingest")
        monkeypatch.setattr(platform, "_s3", lambda: s3)
        import boto3

        monkeypatch.setattr(boto3, "client", lambda name, **_: lm if name == "lambda" else s3)
        ops.trigger_bucket._state.clear()
        return s3, lm
    return setup


def test_ingest_local_is_aws_only(client: TestClient) -> None:
    r = client.post(f"{API}/ops/ingest")
    assert r.status_code == 503 and r.json()["detail"]["code"] == "aws_only"
    s = client.get(f"{API}/ops/ingest").json()
    assert s["available"] is False and s["code"] == "aws_only"


def test_ingest_rejects_body(client: TestClient) -> None:
    r = client.post(f"{API}/ops/ingest", json={"force": True})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "body_not_accepted"


def test_ingest_starts_async_and_then_cools_down(client: TestClient, aws: Any) -> None:
    s3, lm = aws({"old": {"job": "ingest", "status": "succeeded", "finished_at": iso(90)}})
    assert client.get(f"{API}/ops/ingest").json()["available"] is True
    r = client.post(f"{API}/ops/ingest")
    assert r.status_code == 202, r.text
    d = r.json()
    assert d["status"] == "accepted" and d["invocation"] == "Event"
    (call,) = lm.calls
    assert call["FunctionName"] == "roadscope-ingest" and call["InvocationType"] == "Event"
    assert json.loads(call["Payload"])["trigger"] == "manual"
    assert json.loads(s3.objs[platform.LOCK_KEY][0])["state"] == "accepted"
    # second click: refused with Retry-After, nothing invoked
    r2 = client.post(f"{API}/ops/ingest")
    assert r2.status_code == 429 and 1700 < int(r2.headers["Retry-After"]) <= 1800
    assert r2.json()["detail"]["code"] == "cooldown" and len(lm.calls) == 1
    st = client.get(f"{API}/ops/ingest").json()
    assert st["available"] is False and st["code"] == "cooldown" and st["next_allowed_at"]


def test_ingest_cooldown_from_recent_run_record(client: TestClient, aws: Any) -> None:
    _, lm = aws({"r": {"job": "ingest", "status": "succeeded", "finished_at": iso(10)}})
    r = client.post(f"{API}/ops/ingest")
    assert r.status_code == 429 and 1100 < int(r.headers["Retry-After"]) <= 1200 and lm.calls == []


def test_ingest_cooldown_ignores_other_jobs(client: TestClient, aws: Any) -> None:
    aws({"t": {"job": "trajectories", "status": "succeeded", "finished_at": iso(2)}})
    assert client.post(f"{API}/ops/ingest").status_code == 202


def test_ingest_lost_race_is_refused(client: TestClient, aws: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    s3, lm = aws()
    real = platform._read_lock
    # both requests read "no lock"; the second conditional write must fail
    monkeypatch.setattr(platform, "_read_lock", lambda s, b: (None, None))
    assert client.post(f"{API}/ops/ingest").status_code == 202
    r = client.post(f"{API}/ops/ingest")
    assert r.status_code == 429 and len(lm.calls) == 1
    monkeypatch.setattr(platform, "_read_lock", real)


def test_ingest_invoke_failure_releases_lock(client: TestClient, aws: Any) -> None:
    s3, _ = aws(lam=FakeLambda(fail=True))
    r = client.post(f"{API}/ops/ingest")
    assert r.status_code == 502
    assert r.json()["detail"]["code"] == "invoke_failed"
    assert json.loads(s3.objs[platform.LOCK_KEY][0])["state"] == "invoke_failed"
    assert client.get(f"{API}/ops/ingest").json()["available"] is True


def test_ingest_rate_limited(client: TestClient, aws: Any) -> None:
    aws({"r": {"job": "ingest", "status": "succeeded", "finished_at": iso(5)}})
    codes = [client.post(f"{API}/ops/ingest").json()["detail"]["code"] for _ in range(4)]
    assert codes == ["cooldown"] * 3 + ["rate_limited"]


def test_status_reads_run_records_uncached_and_refreshes_data(client: TestClient, aws: Any) -> None:
    s3, _ = aws({"a": {"job": "ingest", "status": "running", "started_at": iso(1)}})
    store.clear_cache()
    platform._seen["latest_ok"] = None
    d = client.get(f"{API}/platform/status")
    assert d.headers["cache-control"] == "no-store"
    assert d.json()["runs"][0]["detail"]["status"] == "running"
    s3._set("curated/runs/a.json", json.dumps({"job": "ingest", "status": "succeeded", "finished_at": iso(0)}).encode())
    assert client.get(f"{API}/platform/status").json()["runs"][0]["detail"]["status"] == "succeeded"
    store._cache["file:spf.json"] = (1e18, {"stale": True})
    s3._set("curated/runs/b.json", json.dumps({"job": "ingest", "status": "succeeded", "finished_at": iso(0)}).encode())
    client.get(f"{API}/platform/status")
    assert "file:spf.json" not in store._cache


def test_cooldown_math() -> None:
    now = dt.datetime(2026, 10, 17, 12, tzinfo=dt.timezone.utc)
    runs = [{"detail": {"job": "ingest", "status": "succeeded", "finished_at": "2026-10-17T11:50:00Z"}}]
    wait, nxt = platform.cooldown(None, runs, now)
    assert wait == 20 * 60 and nxt == dt.datetime(2026, 10, 17, 12, 20, tzinfo=dt.timezone.utc)
    assert platform.cooldown({"state": "invoke_failed", "requested_at": "2026-10-17T11:59:00Z"}, [], now) == (0, None)
    assert platform.cooldown({"state": "accepted", "requested_at": "2026-10-17T11:59:00Z"}, [], now)[0] == 29 * 60
    old_fail = [{"detail": {"job": "ingest", "status": "failed", "finished_at": "2026-10-17T11:50:00Z"}}]
    assert platform.cooldown(None, old_fail, now) == (0, dt.datetime(2026, 10, 17, 11, 55, tzinfo=dt.timezone.utc))


def test_cooldown_after_failure_is_short_and_supersedes_lock() -> None:
    now = dt.datetime(2026, 10, 17, 12, tzinfo=dt.timezone.utc)
    lock = {"state": "accepted", "requested_at": "2026-10-17T11:50:00Z"}
    failed = [{"detail": {"job": "ingest", "status": "failed", "trigger": "manual", "requested_at": "2026-10-17T11:50:00Z",
                          "started_at": "2026-10-17T11:50:01Z", "finished_at": "2026-10-17T11:58:00Z"}}]
    assert platform.cooldown(lock, failed, now)[0] == 3 * 60
    running = [{"detail": {"job": "ingest", "status": "running", "requested_at": "2026-10-17T11:50:00Z", "started_at": "2026-10-17T11:50:01Z"}}]
    assert platform.cooldown(lock, running, now)[0] == 20 * 60 + 1
