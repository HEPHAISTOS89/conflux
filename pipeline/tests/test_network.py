import json
import math
from pathlib import Path

import pytest

from roadscope_pipeline import spf as S
from roadscope_pipeline.network import douglas_peucker, route_key
from roadscope_pipeline.vru import hour, severity

CURATED = Path(__file__).resolve().parents[2] / "data" / "curated"


def test_crash_rate_hand_computed():
    # N=10, AADT=10,000, L=2 mi, Y=5: VMT = 365·5·10000·2 = 36.5e6 -> M = 0.365; R = 10/0.365
    assert S.exposure_100mvmt(10_000, 2, 5) == pytest.approx(0.365)
    assert S.crash_rate(10, 10_000, 2, 5) == pytest.approx(27.3973, rel=1e-4)


def test_critical_rate_hand_computed():
    # Ra=20, M=0.365: 20 + 1.645·sqrt(20/0.365) + 1/(0.73) = 20 + 12.1768 + 1.3699
    assert S.critical_rate(20, 0.365) == pytest.approx(33.5467, rel=1e-4)


def test_eb_hand_computed():
    # mu=2, N=6, k=0.5: w = 1/(1+1) = 0.5 -> E = 0.5·2 + 0.5·6 = 4
    assert S.eb_expected(2, 6, 0.5) == pytest.approx(4.0)
    # k→0 trusts the SPF; large k trusts the observation
    assert S.eb_expected(2, 6, 1e-9) == pytest.approx(2.0)
    assert S.eb_expected(2, 6, 1e9) == pytest.approx(6.0, rel=1e-6)


def test_epdo_and_predict():
    assert S.epdo({"K": 1, "B": 2, "O": 3}) == 542 + 22 + 3
    spf = {"b0": math.log(1e-4), "b1": 1.0}
    assert S.predict(spf, 10_000, 2) == pytest.approx(2.0)


def test_helpers():
    assert route_key("US0084-KG_01") == "US0084-KG" and route_key("SL0289-KG") == "SL0289-KG"
    assert severity("K - FATAL INJURY") == "K" and severity("N - NOT INJURED") == "O" and severity(None) is None
    assert hour("12:05 AM") == 0 and hour("4:15 PM") == 16
    line = [[-101.8, 33.5], [-101.79999, 33.50001], [-101.7, 33.5]]  # ~1.4 m kink removed at 5 m
    assert douglas_peucker(line, 5.0) == [line[0], line[-1]]


NET_KEYS = {"seg_id", "route", "name", "f_system", "lanes", "speed_limit", "aadt", "truck_pct", "len_mi",
            "crashes_total", "crash_years", "rate_100mvmt", "crit_rate", "crit_ratio", "epdo", "spf_pred",
            "eb_expected", "eb_excess", "rank"}
STATION_KEYS = {"dfo", "lanes", "speed_limit", "aadt", "truck_pct", "speed_all", "speed_am", "speed_md", "speed_pm",
                "crashes_per_mi"}


@pytest.mark.skipif(not (CURATED / "network.geojson").exists(), reason="run build_network first")
def test_output_schema():
    net = json.loads((CURATED / "network.geojson").read_text())
    assert (CURATED / "network.geojson").stat().st_size < 1.5e6
    assert len(net["features"]) == 443
    for f in net["features"]:
        assert f["geometry"]["type"] in ("LineString", "MultiLineString")
        assert NET_KEYS <= f["properties"].keys()
    ranks = sorted(f["properties"]["rank"] for f in net["features"] if f["properties"]["rank"])
    assert ranks == list(range(1, len(ranks) + 1))

    corr = json.loads((CURATED / "corridors.json").read_text())
    assert len(corr) == 7
    for c in corr:
        assert {"id", "name", "routes", "len_mi", "stations", "summary"} <= c.keys()
        assert c["stations"] and all(STATION_KEYS <= s.keys() for s in c["stations"])

    vru = json.loads((CURATED / "vru_crashes.geojson").read_text())["features"]
    assert vru and all(f["properties"]["severity"] in {"K", "A", "B", "C", "O", None} for f in vru)
    assert all(f["properties"]["mode"] in {"ped", "bike", "scooter"} for f in vru)

    fatal = json.loads((CURATED / "fatal_crashes.geojson").read_text())["features"]
    assert fatal and all({"id", "year", "month", "hour", "fatals", "route", "light", "weather"} <= f["properties"].keys() for f in fatal)
    assert {f["properties"]["year"] for f in fatal} <= set(range(2018, 2024))

    spf = json.loads((CURATED / "spf.json").read_text())
    assert {"form", "b0", "b1", "k", "n", "aic", "by_class"} <= spf.keys() and spf["k"] > 0

    man = json.loads((CURATED / "manifest.json").read_text())
    ids = {s["id"] for s in man["sources"]}
    assert {"segment_crash", "aadt", "roadway_inventory", "speed_2024", "active_transportation_crashes", "fars_2018"} <= ids
    assert all(len(s["sha256"]) == 64 for s in man["sources"] if s["id"] in ids and "sha256" in s)
