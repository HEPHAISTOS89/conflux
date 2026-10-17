import io
import json
from pathlib import Path

import pytest

from roadscope_pipeline import lambda_ingest as L

SPF = {"b0": 0, "b1": 0, "k": 1, "site_types": {}}
LAYER_IDS = list(L.LAYERS)


class FakeS3:
    def __init__(self, prev):
        self.prev, self.uploads, self.puts = prev, [], {}

    def get_object(self, Bucket, Key):
        return {"Body": io.BytesIO(json.dumps(SPF).encode())}

    def download_file(self, bucket, key, path):
        Path(path).write_text(json.dumps(self.prev))

    def upload_file(self, path, bucket, key, ExtraArgs=None):
        self.uploads.append(key)

    def put_object(self, Bucket, Key, Body, ContentType=None):
        self.puts[Key] = json.loads(Body)


class Ctx:
    def get_remaining_time_in_millis(self):
        return 600_000


def manifest(records, screened):
    return {"sources": [{"id": k, "records": records} for k in LAYER_IDS], "metrics": {"segments_screened": screened}}


def run(monkeypatch, tmp_path, prev, records, screened):
    s3 = FakeS3(prev)
    monkeypatch.setenv("DATA_BUCKET", "b")
    monkeypatch.setattr(L.boto3, "client", lambda name: s3)

    def fake_build(out, raw, **kw):
        for n in L.CURATED:
            (out / n).write_text("{}")
        (out / "manifest.json").write_text(json.dumps(manifest(records, screened)))
        return {"segments_screened": screened}

    monkeypatch.setattr(L, "build", fake_build)
    return s3


def test_handler_uploads_manifest_last(monkeypatch, tmp_path):
    s3 = run(monkeypatch, tmp_path, manifest(100, 400), 90, 390)
    L.handler({}, Ctx())
    assert s3.uploads[-1] == "curated/manifest.json"
    assert [v["status"] for v in s3.puts.values()] == ["succeeded"]


def test_handler_sanity_gate_records_failure_and_skips_upload(monkeypatch, tmp_path):
    s3 = run(monkeypatch, tmp_path, manifest(100, 400), 40, 390)
    with pytest.raises(RuntimeError, match="sanity gate"):
        L.handler({}, Ctx())
    assert s3.uploads == []
    (rec,) = s3.puts.values()
    assert rec["status"] == "failed" and rec["error"] == "RuntimeError"
