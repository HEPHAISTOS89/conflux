import json
import math
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from roadscope_pipeline import spf as S
from roadscope_pipeline.counties import CountyIndex, county_summary
from roadscope_pipeline.network import douglas_peucker, route_key
from roadscope_pipeline.sources import COUNTIES, COUNTY_BY_NBR, COUNTY_NBR_BY_FIPS, LAYERS
from roadscope_pipeline.vru import hour, severity

CURATED = Path(__file__).resolve().parents[2] / "data" / "curated"
RAW = CURATED.parent / "raw"


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


def test_predict_forms_and_no_epdo():
    assert not hasattr(S, "epdo") and not hasattr(S, "EPDO_WEIGHTS")  # unsourced weights removed
    spf = {"b0": math.log(1e-4), "b1": 1.0}
    assert S.predict(spf, 10_000, 2) == pytest.approx(2.0)
    # site-type form: exp(-9 + 1·ln 10000 + 0.1·4)·1.5
    model = {"coef": {"const": -9.0, "ln_aadt": 1.0, "lanes": 0.1}}
    want = math.exp(-9.0) * 10_000 * math.exp(0.4) * 1.5
    assert S.predict(model, 10_000, 1.5, lanes=4) == pytest.approx(want)
    assert S.predict_seg(model, {"aadt": 10_000, "len_mi": 1.5, "lanes": 4}) == pytest.approx(want)
    assert S.predict_seg(model, {"aadt": 10_000, "len_mi": 1.5, "lanes": None}) is None


def test_eb_hsm_segment_k_convention():
    # k = 0.5 per mile on a 0.5-mi segment -> k_seg = 1.0; mu=2, N=6: w = 1/3, E = 2/3 + 4 = 4.667
    assert S.k_segment(0.5, 0.5) == pytest.approx(1.0)
    assert S.eb_expected(2, 6, S.k_segment(0.5, 0.5)) == pytest.approx(2 / 3 + 4)


def test_gof_hand_computed():
    # y=(0,2), mu=(1,1), alpha=(0.5,0.5): var = 1.5 each; chi2 = (1+1)/1.5; MAD = 1
    g = S.gof([0, 2], [1, 1], [0.5, 0.5], n_params=1)
    assert g["mad"] == pytest.approx(1.0) and g["pearson_chi2"] == pytest.approx(4 / 3) and g["df"] == 1


def test_cure_bounds_hauer_bamfo():
    # ordered by x (10, 20, 30, 40) the residuals y-mu are e = (1, 2, -1, 2): cum = (1, 3, 2, 4),
    # sigma^2(i) = (1, 5, 6, 10), 2·sigma* = 2·sqrt(sigma^2·(1 - sigma^2/10)) = (1.897, 3.162, 3.098, 0)
    c = S.cure(x=[40, 10, 30, 20], y=[2, 1, 0, 4], mu=[0, 0, 1, 2])
    e = [1, 2, -1, 2]
    cum = [1, 3, 2, 4]
    s2 = [1, 5, 6, 10]
    for p, cu, v in zip(c["points"], cum, s2):
        assert p[1] == pytest.approx(cu, abs=1e-3)
        assert p[2] == pytest.approx(2 * math.sqrt(v * (1 - v / 10)), abs=1e-3)
    assert [p[0] for p in c["points"]] == [10, 20, 30, 40] and sum(e) == cum[-1]
    assert c["points"][-1][2] == 0  # bound closes at the end of the walk
    assert c["pct_outside"] == pytest.approx(25.0)  # last point: |4| > 0


def test_nb_mle_matches_statsmodels_and_recovers_k():
    sm = pytest.importorskip("statsmodels.api")
    rng = np.random.default_rng(7)
    n = 3000
    aadt = rng.uniform(2_000, 40_000, n)
    L = np.ones(n)
    mu = np.exp(-8.0 + 0.8 * np.log(aadt)) * 3  # 3 years
    k = 0.6
    y = rng.negative_binomial(1 / k, 1 / (1 + k * mu))
    fit = S.fit_nb(y, np.log(aadt)[:, None], ["ln_aadt"], L, 3)
    ref = sm.NegativeBinomial(y, sm.add_constant(np.log(aadt)), offset=np.log(L) + math.log(3),
                              loglike_method="nb2").fit(disp=0)
    assert fit["coef"]["const"] == pytest.approx(ref.params[0], abs=1e-3)
    assert fit["coef"]["ln_aadt"] == pytest.approx(ref.params[1], abs=1e-4)
    assert fit["k"] == pytest.approx(ref.params[2], rel=1e-3)
    assert fit["se"]["ln_aadt"] == pytest.approx(ref.bse[1], rel=2e-2)
    assert fit["k"] == pytest.approx(k, rel=0.2) and fit["aic"] == pytest.approx(ref.aic, abs=0.05)


def test_screen_applies_stored_spf_without_scipy(tmp_path):
    """The ingest Lambda path: apply curated/spf.json with scipy/statsmodels unavailable."""
    if not (CURATED / "spf.json").exists() or not (RAW / "segment_crash.json").exists():
        pytest.skip("run build_network first")
    code = f"""
import sys, json
class Block:
    def find_spec(self, name, path, target=None):
        if name.split('.')[0] in ('scipy', 'statsmodels'):
            raise ImportError(name)
sys.meta_path.insert(0, Block())
from roadscope_pipeline.build_network import build
build({str(tmp_path)!r}, {str(RAW)!r}, fars=False, spf_existing=json.load(open({str(CURATED / 'spf.json')!r})))
"""
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
    subprocess.run([sys.executable, "-c", code], check=True, env=env)
    a = json.loads((CURATED / "network.geojson").read_text())["features"]
    b = json.loads((tmp_path / "network.geojson").read_text())["features"]
    assert [f["properties"] for f in a] == [f["properties"] for f in b]


def test_helpers():
    assert route_key("US0084-KG_01") == "US0084-KG" and route_key("SL0289-KG") == "SL0289-KG"
    assert severity("K - FATAL INJURY") == "K" and severity("N - NOT INJURED") == "O" and severity(None) is None
    assert hour("12:05 AM") == 0 and hour("4:15 PM") == 16
    assert hour("12:05 AM", "1 - DAYLIGHT") == 12 and hour("12:05 AM", "2 - DARK, NOT LIGHTED") == 0
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
    man = json.loads((CURATED / "manifest.json").read_text())
    assert (CURATED / "network.geojson").stat().st_size < 3.5e6  # ~4,100 regional segments; served gzipped
    assert len(net["features"]) == man["metrics"]["segments"] >= 4000
    for f in net["features"]:
        assert f["geometry"]["type"] in ("LineString", "MultiLineString")
        assert NET_KEYS | {"county", "county_id"} <= f["properties"].keys()
        assert f["properties"]["county"] in COUNTY_BY_NBR.values()
    # every SPAG county holds segments; Lubbock has the most and the corridors stay Lubbock profiles
    by_county = {c["name"]: c for c in man["metrics"]["by_county"]}
    assert set(by_county) == {n for n, *_ in COUNTIES} and all(c["segments"] > 50 for c in by_county.values())
    assert max(by_county.values(), key=lambda c: c["segments"])["name"] == "Lubbock"
    assert sum(c["segments"] for c in by_county.values()) == len(net["features"])
    counties = json.loads((CURATED / "counties.geojson").read_text())["features"]
    assert len(counties) == 15 and all(f["geometry"]["type"] == "Polygon" and "segments_screened" in f["properties"] for f in counties)
    ranks = sorted(f["properties"]["rank"] for f in net["features"] if f["properties"]["rank"])
    assert ranks == list(range(1, len(ranks) + 1))

    corr = json.loads((CURATED / "corridors.json").read_text())
    assert len(corr) == 7
    for c in corr:
        assert {"id", "name", "routes", "len_mi", "stations", "summary"} <= c.keys()
        assert c["stations"] and all(STATION_KEYS <= s.keys() for s in c["stations"])

    vru = json.loads((CURATED / "vru_crashes.geojson").read_text())["features"]
    assert vru and all(f["properties"]["severity"] in {"K", "A", "B", "C", "O", None} for f in vru)
    assert all(f["properties"]["county_nbr"] in COUNTY_BY_NBR for f in vru)
    assert sum(c["vru_crashes"] for c in by_county.values()) == len(vru)
    assert all(f["properties"]["mode"] in {"ped", "bike", "scooter"} for f in vru)

    fatal = json.loads((CURATED / "fatal_crashes.geojson").read_text())["features"]
    assert fatal and all({"id", "year", "month", "hour", "fatals", "route", "light", "weather"} <= f["properties"].keys() for f in fatal)
    assert {f["properties"]["year"] for f in fatal} <= set(range(2018, 2024))

    props = [f["properties"] for f in net["features"]]
    assert all(p["epdo"] is None for p in props)
    for p in props:  # output rounding: rates 1 dp, ratios / SPF / EB 2 dp
        for key, nd in (("rate_100mvmt", 1), ("crit_rate", 1), ("crit_ratio", 2), ("spf_pred", 2),
                        ("eb_expected", 2), ("eb_excess", 2)):
            if p[key] is not None:
                assert round(p[key], nd) == p[key]

    spf = json.loads((CURATED / "spf.json").read_text())
    assert {"form", "b0", "b1", "k", "n", "aic", "by_class"} <= spf.keys() and spf["k"] > 0
    assert {"site_types", "fallback", "pooled_gof", "system_gof", "diagnostics", "crash_period", "crash_years"} <= spf.keys()
    assert {"crash_field", "aadt", "join", "overdispersion"} <= spf["diagnostics"].keys()
    for t, v in spf["site_types"].items():
        assert {"segments", "crashes", "fitted", "gof", "cure", "model_used"} <= v.keys()
        assert {"mad", "chi2_df"} <= v["gof"].keys() and len(v["cure"]["points"]) == v["segments"]
        if v["fitted"]:
            assert {"coef", "se", "k", "n", "aic", "spec"} <= v["model"].keys()

    ids = {s["id"] for s in man["sources"]}
    assert {"counties", "segment_crash", "aadt", "roadway_inventory", "speed_2024", "active_transportation_crashes", "fars_2018"} <= ids
    assert all(len(s["sha256"]) == 64 for s in man["sources"] if s["id"] in ids and "sha256" in s)


def test_stored_spf_missing_covariate_leaves_segment_unscored():
    from roadscope_pipeline.network import screen
    model = {"coef": {"const": -6.0, "ln_aadt": 0.5, "speed": 0.01}, "k": 0.5, "n_params": 4,
             "k_convention": "per mile (k_seg = k/L)"}
    fitted = {"b0": -6.0, "b1": 0.5, "k": 0.5, "se_b0": 0.1, "se_b1": 0.1, "n": 2, "crashes": 3, "aic": 1.0,
              "loglik": -1.0, "site_types": {}, "fallback": model}

    def seg(i, speed):
        return {"seg_id": i, "aadt": 10_000, "site_type": "Urban minor arterial", "fc_group": "Minor arterial",
                "len_mi": 1.0, "crashes_total": 2, "crash_years": 3, "crashes_per_yr": 2 / 3, "speed_limit": speed,
                "satp_crash_score": 0}

    segs = [seg(1, 45), seg(2, None)]
    out = screen(segs, fitted=fitted)
    assert segs[0]["rank"] == 1 and segs[0]["spf_pred"] is not None
    assert segs[1]["rank"] is None and segs[1]["spf_pred"] is None
    assert [p["seg_id"] for p in out["points"]] == [1]


@pytest.mark.skipif(not (CURATED / "corridors.json").exists(), reason="run build_network first")
def test_corridor_figures_agree_with_segments():
    """Corridor per-year figures come from the integer 3-year counts, not sums of rounded segment rates,
    and every station's crash density equals that of the segment containing it."""
    segs = {f["properties"]["seg_id"]: f["properties"] for f in json.loads((CURATED / "network.geojson").read_text())["features"]}
    for c in json.loads((CURATED / "corridors.json").read_text()):
        assert c["county_id"] == "lubbock"  # corridor sheets are Lubbock County profiles
        cs = [p for p in segs.values() if p["route"] in c["routes"] and p["county_id"] == c["county_id"]]
        s, Y = c["summary"], c["summary"]["crash_years"]
        n = sum(p["crashes_total"] for p in cs)
        assert s["crashes_total"] == n and s["crashes_ka"] == sum(p["crashes_ka"] for p in cs)
        assert s["crashes_per_yr"] == round(n / Y, 2)
        assert s["seg_len_mi"] == pytest.approx(sum(p["len_mi"] for p in cs), abs=0.01)
        assert s["crashes_per_mi_yr"] == pytest.approx(n / Y / sum(p["len_mi"] for p in cs), abs=1e-3)
        for st in c["stations"]:
            if st.get("seg_id"):
                p = segs[st["seg_id"]]
                assert p["dfo_from"] - 1e-6 <= st["dfo"] <= p["dfo_to"] + 1e-6
                assert st["crashes_per_mi"] == round(p["crashes_total"] / Y / p["len_mi"], 2)


# ---------- SPAG region ----------
def test_region_registry_consistent():
    assert len(COUNTIES) == 15 and len({n for _, n, _, _ in COUNTIES}) == 15 and len(COUNTY_NBR_BY_FIPS) == 15
    assert COUNTY_BY_NBR[152] == "Lubbock" and COUNTY_NBR_BY_FIPS[303] == 152  # FARS COUNTY 303 = Lubbock
    assert COUNTY_BY_NBR[86] == "Garza" and COUNTY_BY_NBR[96] == "Hale" and COUNTY_BY_NBR[111] == "Hockley"  # TxDOT ≠ alphabetical
    assert "CO IN (" in LAYERS["roadway_inventory"]["where"] and "'LUBBOCK'" in LAYERS["active_transportation_crashes"]["where"]
    assert LAYERS["segment_crash"]["envelope"] and LAYERS["aadt"]["envelope"]


def test_county_index_point_in_polygon():
    sq = lambda nbr, name, x0, y0: {"attributes": {"CNTY_NBR": nbr, "CNTY_NM": name, "FIPS_ST_CNTY_CD": "48000", "DIST_NBR": 5},
                                   "geometry": {"rings": [[[x0, y0], [x0 + 1, y0], [x0 + 1, y0 + 1], [x0, y0 + 1], [x0, y0]]]}}
    idx = CountyIndex([sq(152, "Lubbock", -102, 33), sq(96, "Hale", -102, 34)])
    assert idx.lookup(-101.5, 33.5)["name"] == "Lubbock"
    assert idx.lookup(-101.5, 34.5)["name"] == "Hale"
    assert idx.lookup(-100.5, 33.5) is None  # outside both
    gj = idx.to_geojson({152: {"segments": 3}})
    assert gj["features"][0]["properties"]["name"] == "Hale" and gj["features"][1]["properties"]["segments"] == 3


def test_county_summary_rollup():
    segs = [{"county_nbr": 152, "len_mi": 1.0, "crashes_total": 2, "crashes_ka": 1, "rank": 1, "eb_excess": 0.4},
            {"county_nbr": 152, "len_mi": 0.5, "crashes_total": 0, "crashes_ka": 0, "rank": None, "eb_excess": None},
            {"county_nbr": 96, "len_mi": 1.0, "crashes_total": 0, "crashes_ka": 0, "rank": 2, "eb_excess": -0.1}]
    vru = [{"properties": {"county_nbr": 152, "severity": "K", "mode": "ped", "on_system": True}},
           {"properties": {"county_nbr": 96, "severity": "C", "mode": "bike", "on_system": False}}]
    fatal = [{"properties": {"county_nbr": 96}}]
    out = county_summary(segs, vru, fatal)
    lub, hale = out[152], out[96]
    assert (lub["segments"], lub["segments_screened"], lub["segments_flagged"], lub["segment_crashes"], lub["segment_crashes_ka"]) == (2, 1, 1, 2, 1)
    assert lub["segment_miles"] == 1.5 and lub["vru_crashes"] == 1 and lub["vru_ka"] == 1 and lub["vru_on_system_ka"] == 1 and lub["fatal_crashes"] == 0
    assert hale["segments_flagged"] == 0 and hale["vru_by_mode"] == {"bike": 1} and hale["fatal_crashes"] == 1
    assert out[9]["segments"] == 0 and out[9]["id"] == "bailey" and len(out) == 15
