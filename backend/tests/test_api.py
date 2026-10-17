from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import ask, store
from app.main import cors_config

API = "/api/v1"
DATA_ROUTES = ["/meta", "/network", "/screening", "/spf", "/corridors", "/corridors/us-84", "/vru", "/vru/summary",
               "/fatal", "/intersections", "/intersections/lankershim", "/intersections/lankershim/conflicts",
               "/intersections/lankershim/repair"]


def test_health(client: TestClient) -> None:
    r = client.get(f"{API}/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


@pytest.mark.parametrize("path", DATA_ROUTES)
def test_data_routes_cache_headers(client: TestClient, path: str) -> None:
    r = client.get(API + path)
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "public, max-age=300"
    etag = r.headers["etag"]
    again = client.get(API + path, headers={"If-None-Match": etag})
    assert again.status_code == 304 and again.headers["etag"] == etag


def test_meta(client: TestClient) -> None:
    m = client.get(f"{API}/meta").json()
    assert m["generated_at"] and m["sources"][0]["licence"]


def test_network_metric(client: TestClient) -> None:
    fc = client.get(f"{API}/network", params={"metric": "epdo"}).json()
    assert fc["type"] == "FeatureCollection" and fc["metric"] == "epdo"
    assert all(f["properties"]["value"] == f["properties"]["epdo"] for f in fc["features"])
    assert client.get(f"{API}/network", params={"metric": "bogus"}).status_code == 422


@pytest.mark.parametrize("method,field", [("frequency", "crashes_total"), ("rate", "rate_100mvmt"),
                                          ("critical_ratio", "crit_ratio"), ("epdo", "epdo"), ("eb_excess", "eb_excess")])
def test_screening_sorted(client: TestClient, method: str, field: str) -> None:
    d = client.get(f"{API}/screening", params={"method": method, "limit": 3}).json()
    assert d["field"] == field and len(d["items"]) == 3 and d["total"] == 4
    vals = [i[field] for i in d["items"]]
    assert vals == sorted(vals, reverse=True)
    assert [i["screen_rank"] for i in d["items"]] == [1, 2, 3]


def test_screening_filters_and_validation(client: TestClient) -> None:
    d = client.get(f"{API}/screening", params={"f_system": 3}).json()
    assert d["total"] == 2 and all(i["f_system"] == 3 for i in d["items"])
    for bad in ({"method": "nope"}, {"limit": 0}, {"limit": 5000}, {"f_system": 9}):
        assert client.get(f"{API}/screening", params=bad).status_code == 422


def test_spf(client: TestClient) -> None:
    s = client.get(f"{API}/spf").json()
    assert {"form", "b0", "b1", "k", "n"} <= s.keys()


def test_corridors(client: TestClient) -> None:
    rows = client.get(f"{API}/corridors").json()
    assert {r["id"] for r in rows} == {"us-84", "loop-289"} and "stations" not in rows[0]
    c = client.get(f"{API}/corridors/US-84").json()
    assert c["id"] == "us-84" and len(c["stations"]) == 3 and c["stations"][0]["speed_pm"] == 48.0
    r = client.get(f"{API}/corridors/nowhere")
    assert r.status_code == 404 and "nowhere" in r.json()["detail"]


def test_vru_filters(client: TestClient) -> None:
    assert len(client.get(f"{API}/vru").json()["features"]) == 5
    assert len(client.get(f"{API}/vru", params={"mode": "bike"}).json()["features"]) == 2
    assert len(client.get(f"{API}/vru", params={"severity": "K,A"}).json()["features"]) == 2
    assert len(client.get(f"{API}/vru", params={"year": 2021, "mode": "ped"}).json()["features"]) == 1
    assert client.get(f"{API}/vru", params={"severity": "X"}).status_code == 422
    assert client.get(f"{API}/vru", params={"mode": "car"}).status_code == 422


def test_vru_summary(client: TestClient) -> None:
    s = client.get(f"{API}/vru/summary").json()
    assert s["total"] == 5 and s["ka_total"] == 2 and s["by_severity"]["K"] == 1
    assert len(s["hour_dow"]) == 7 and len(s["hour_dow"][0]) == 24 and sum(map(sum, s["hour_dow"])) == 5
    assert s["years"] == [2019, 2023]


def test_fatal(client: TestClient) -> None:
    assert client.get(f"{API}/fatal").json()["features"][0]["properties"]["fatals"] == 1


def test_intersections_index(client: TestClient) -> None:
    rows = client.get(f"{API}/intersections").json()
    assert rows == [{"id": "lankershim", "name": rows[0]["name"], "source": "NGSIM", "hz": 10.0, "bbox": [0, 0, 100, 30],
                     "n_tracks": 2, "t_start": 0.0, "t_end": 4.9, "n_conflicts": 3}]


def test_intersection_slicing(client: TestClient) -> None:
    full = client.get(f"{API}/intersections/lankershim").json()
    assert len(full["tracks"][0]["pts"]) == 50
    d = client.get(f"{API}/intersections/lankershim", params={"t0": 1.0, "t1": 2.0, "stride": 2}).json()
    ts = [p[0] for p in d["tracks"][0]["pts"]]
    assert ts == [1.0, 1.2, 1.4, 1.6, 1.8, 2.0] and d["stride"] == 2
    assert client.get(f"{API}/intersections/lankershim", params={"t0": 99}).json()["tracks"] == []
    assert client.get(f"{API}/intersections/lankershim", params={"t0": 2, "t1": 1}).status_code == 422
    assert client.get(f"{API}/intersections/lankershim", params={"stride": 0}).status_code == 422


def test_conflict_filters(client: TestClient) -> None:
    assert len(client.get(f"{API}/intersections/lankershim/conflicts").json()) == 3
    rows = client.get(f"{API}/intersections/lankershim/conflicts", params={"type": "rear_end"}).json()
    assert [r["id"] for r in rows] == ["c1"]
    rows = client.get(f"{API}/intersections/lankershim/conflicts", params={"max_ttc": 1.5}).json()
    assert [r["id"] for r in rows] == ["c1"]
    assert client.get(f"{API}/intersections/lankershim/conflicts", params={"type": "head_on"}).status_code == 422


def test_repair(client: TestClient) -> None:
    d = client.get(f"{API}/intersections/lankershim/repair").json()
    assert d["tracks"][0]["rmse_m"] == 0.21 and d["summary"]["baseline_rmse_m_mean"] == 0.55


@pytest.mark.parametrize("path", ["/intersections/peachtree", "/intersections/peachtree/conflicts",
                                  "/intersections/peachtree/repair"])
def test_intersection_404(client: TestClient, path: str) -> None:
    r = client.get(API + path)
    assert r.status_code == 404 and "peachtree" in r.json()["detail"]


def test_missing_curated_file_404(client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    monkeypatch.setenv("CURATED_DIR", str(tmp_path))
    r = client.get(f"{API}/spf")
    assert r.status_code == 404 and "spf.json" in r.json()["detail"]


def test_store_cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    store.clear_cache()
    monkeypatch.setenv("CURATED_DIR", str(tmp_path))
    (tmp_path / "spf.json").write_text('{"b0": 1}')
    assert store.load("spf.json") == {"b0": 1}
    (tmp_path / "spf.json").write_text('{"b0": 2}')
    assert store.load("spf.json") == {"b0": 1}
    store.clear_cache()
    assert store.load("spf.json") == {"b0": 2}
    with pytest.raises(store.MissingData):
        store.load("../secret.json")
    store.clear_cache()


def test_platform_status_off_aws(client: TestClient) -> None:
    d = client.get(f"{API}/platform/status").json()
    assert d["on_aws"] is False and d["metrics"] is None and d["manifest"]["generated_at"]
    assert d["runs"] == [] and d["data_source"].startswith("local:")


def test_ask_fallback_screening(client: TestClient, no_bedrock: None) -> None:
    r = client.post(f"{API}/ask", json={"question": "Which segments rank worst by EPDO?"})
    d = r.json()
    assert r.status_code == 200 and d["fallback"] is True and d["model"] == ask.FALLBACK_MODEL
    assert d["tool_calls"][0] == {"name": "query_screening", "input": {"method": "epdo", "limit": 5}, "ok": True}
    assert "US0062" in d["answer"] and "network.geojson" in d["citations"][0] and "Limitations" in d["answer"]


@pytest.mark.parametrize("question,tool", [("How many pedestrian crashes were fatal?", "vru_count"),
                                           ("Show TTC conflicts at lankershim", "intersection_conflicts"),
                                           ("What are the SPF coefficients?", "get_spf"),
                                           ("Where does the data come from, licence?", "get_manifest"),
                                           ("Tell me about Loop 289", "get_corridor")])
def test_ask_fallback_routing(client: TestClient, no_bedrock: None, question: str, tool: str) -> None:
    d = client.post(f"{API}/ask", json={"question": question}).json()
    assert d["fallback"] and tool in [c["name"] for c in d["tool_calls"]] and all(c["ok"] for c in d["tool_calls"])
    assert d["citations"]


def test_ask_bedrock_tool_loop(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []

    class Fake:
        def converse(self, **kw: Any) -> dict[str, Any]:
            calls.append(kw)
            if len(calls) == 1:
                return {"stopReason": "tool_use", "output": {"message": {"role": "assistant", "content": [
                    {"toolUse": {"toolUseId": "t1", "name": "get_spf", "input": {}}}]}}}
            assert calls[-1]["messages"][-1]["content"][0]["toolResult"]["status"] == "success"
            return {"stopReason": "end_turn", "output": {"message": {"role": "assistant", "content": [
                {"text": "b1 = 0.82 [get_spf: spf.json]"}]}}}

    monkeypatch.setenv("BEDROCK_MODEL_ID", "m1")
    monkeypatch.setattr(ask, "_bedrock", lambda: Fake())
    d = client.post(f"{API}/ask", json={"question": "SPF slope?"}).json()
    assert d == {"answer": "b1 = 0.82 [get_spf: spf.json]", "citations": [ask.CITATION["get_spf"]],
                 "tool_calls": [{"name": "get_spf", "input": {}, "ok": True}], "model": "m1", "fallback": False}


def test_ask_validation_and_rate_limit(client: TestClient, no_bedrock: None) -> None:
    assert client.post(f"{API}/ask", json={"question": "x" * 501}).status_code == 422
    assert client.post(f"{API}/ask", json={"question": "  "}).status_code == 422
    assert client.post(f"{API}/ask", json={}).status_code == 422
    n = ask.bucket.capacity
    codes = [client.post(f"{API}/ask", json={"question": "top segments"}).status_code for _ in range(n + 1)]
    assert n == 30 and codes[:n] == [200] * n and codes[n] == 429


@pytest.mark.parametrize("question,severity", [("How many fatal or serious pedestrian crashes?", "K,A"),
                                               ("How many pedestrian fatalities?", "K")])
def test_ask_fallback_severity(question: str, severity: str) -> None:
    assert ("vru_count", {"mode": "ped", "severity": severity}) in ask._route(question)


def test_unknown_intersection_tool_error() -> None:
    d = ask.t_intersection_conflicts("nowhere")
    assert "nowhere" in d["error"] and d["available"] == store.intersection_ids()


def test_s3_missing_key_404(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from botocore.exceptions import ClientError

    class S3:
        def get_object(self, **_: object) -> None:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "gone"}}, "GetObject")

    monkeypatch.setenv("DATA_BUCKET", "b")
    monkeypatch.setattr(store, "_s3", lambda: S3())
    r = client.get(f"{API}/spf")
    assert r.status_code == 404 and "spf.json" in r.json()["detail"]


def test_cors(client: TestClient) -> None:
    exact, regex = cors_config("http://localhost:5173,https://*.vercel.app")
    assert exact == ["http://localhost:5173"] and regex
    ok = client.get(f"{API}/health", headers={"Origin": "https://roadscope-git-main.vercel.app"})
    assert ok.headers["access-control-allow-origin"] == "https://roadscope-git-main.vercel.app"
    bad = client.get(f"{API}/health", headers={"Origin": "https://evil.example.com"})
    assert "access-control-allow-origin" not in bad.headers


def test_lambda_handler_import() -> None:
    from app.lambda_handler import handler

    assert callable(handler)


def test_intersection_list_excludes_ssm_files(client: TestClient) -> None:
    ids = [i["id"] for i in client.get("/api/v1/intersections").json()]
    assert all(not i.endswith("_ssm") for i in ids)
