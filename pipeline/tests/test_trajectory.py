import numpy as np
import pytest

from roadscope_pipeline.trajectory import repair, ssm

HZ = 10


def track(id_, t, x, y, v, lane=1, dir_="NB", move="through", length=4.5, inside=None):
    n = len(t)
    return {"id": id_, "len_m": length, "t": np.asarray(t, float), "x": np.asarray(x, float),
            "y": np.asarray(y, float), "v": np.asarray(v, float), "lane": np.full(n, lane),
            "dir": dir_, "move": move,
            "inside": np.ones(n, bool) if inside is None else np.asarray(inside, bool)}


def test_ttc_drac_formulae():
    ttc, drac = ssm.ttc_drac(np.array([10.0, 10.0, 5.0]), np.array([15.0, 10.0, 12.0]),
                             np.array([10.0, 12.0, 10.0]))
    assert ttc[0] == pytest.approx(2.0) and drac[0] == pytest.approx(25 / 20)
    assert np.isinf(ttc[1]) and drac[1] == 0          # leader faster: no conflict
    assert ttc[2] == pytest.approx(2.5) and drac[2] == pytest.approx(0.4)


def test_rear_end_event_on_toy_pair():
    t = np.arange(0, 3, 0.1)
    # leader front at 20 m moving 5 m/s; follower front at 5 m moving 15 m/s, same lane.
    # spacing = (20 + 5t) - (5 + 15t) - 4.5 = 10.5 - 10t ; closing 10 m/s.
    lead = track(1, t, np.zeros_like(t), 20 + 5 * t, np.full_like(t, 5.0))
    fol = track(2, t, np.zeros_like(t), 5 + 15 * t, np.full_like(t, 15.0))
    ev = ssm.rear_end([lead, fol])
    assert len(ev) == 1
    e = ev[0]
    assert (e["a"], e["b"], e["type"]) == (2, 1, "rear_end")
    # last frame with spacing >= MIN_GAP: t=0.9 -> spacing 1.5 m, TTC 0.15 s
    assert e["ttc_min"] == pytest.approx(0.15, abs=1e-6)
    assert e["drac_max"] == pytest.approx(100 / 3.0, rel=1e-3)
    assert e["severity"] == "critical"


def test_no_rear_end_across_lanes():
    t = np.arange(0, 3, 0.1)
    lead = track(1, t, np.zeros_like(t), 20 + 5 * t, np.full_like(t, 5.0), lane=2)
    fol = track(2, t, np.zeros_like(t), 5 + 15 * t, np.full_like(t, 15.0), lane=1)
    assert ssm.rear_end([lead, fol]) == []


def test_pet_bounding_boxes_on_toy_crossing():
    t = np.round(np.arange(0, 5, 0.1), 1)
    # A: NB, front bumper at x=1, y=-20+10t, 4.5 x 1.8 m box -> covers x in [0.1, 1.9].
    # B: EB, front bumper at y=1, x=-29+10t -> covers y in [0.1, 1.9].
    # Shared zone ~[0.1,1.9]^2 (on the 0.5 m raster: [0,2)^2). A's rear leaves when y_front-4.5 >= 2
    # -> t = 2.65; B's front enters at x_front >= 0 -> t = 2.9. PET = 0.25 s (exact geometry 0.27 s).
    a = track(1, t, np.full_like(t, 1.0), -20 + 10 * t, np.full_like(t, 10.0), dir_="NB")
    b = track(2, t, -29 + 10 * t, np.full_like(t, 1.0), np.full_like(t, 10.0), dir_="EB")
    ev = ssm.pet([a, b])
    assert len(ev) == 1
    e = ev[0]
    assert e["pet"] == pytest.approx(0.27, abs=0.04)
    assert (e["a"], e["b"], e["overlap"], e["severity"]) == (1, 2, False, "critical")
    assert e["angle_deg"] == pytest.approx(90, abs=1)
    assert abs(e["cell"][0] - 1) < 0.3 and abs(e["cell"][1] - 1) < 0.3
    # centre-point PET would be 0.8 s (2 m cells): footprints shorten it, as they must
    assert e["pet"] < 0.8
    # opposing throughs do not conflict
    c = track(3, t, np.full_like(t, 1.0), 20 - 10 * t, np.full_like(t, 10.0), dir_="SB")
    assert ssm.pet([a, c]) == []


def test_pet_overlap_is_flagged_not_skipped():
    t = np.round(np.arange(0, 5, 0.1), 1)
    a = track(1, t, np.full_like(t, 1.0), -20 + 10 * t, np.full_like(t, 10.0), dir_="NB")
    # B enters the zone at t=2.4 while A's footprint is still in it (until 2.65)
    b = track(2, t, -24 + 10 * t, np.full_like(t, 1.0), np.full_like(t, 10.0), dir_="EB")
    ev = ssm.pet([a, b])
    assert len(ev) == 1
    assert ev[0]["overlap"] is True and ev[0]["pet"] == 0.0
    assert ev[0]["severity"] == "critical"


def test_severity_bins_match_detection_rules():
    assert ssm.severity_ttc(0.5) == "critical" and ssm.severity_ttc(0.9) == "serious"
    assert ssm.severity_ttc(1.5) == "moderate" and ssm.severity_ttc(1.6) is None
    assert ssm.severity_pet(1.0) == "critical" and ssm.severity_pet(2.0) == "serious"
    assert ssm.severity_pet(5.0) == "moderate" and ssm.severity_pet(5.1) is None
    assert ssm.RULES["detection"]["ttc_max_s"] == ssm.TTC_BINS[-1][0]
    assert ssm.RULES["detection"]["pet_max_s"] == ssm.PET_BINS[-1][0]


def test_analyse_sensitivity_is_monotone():
    t = np.arange(0, 3, 0.1)
    lead = track(1, t, np.zeros_like(t), 20 + 5 * t, np.full_like(t, 5.0))
    fol = track(2, t, np.zeros_like(t), 5 + 15 * t, np.full_like(t, 15.0))
    conf, doc = ssm.analyse([lead, fol])
    assert len(conf) == 1 and conf[0]["drac_flag"] is True
    ttc = doc["sensitivity"]["ttc"]
    assert list(ttc) == ["1.0", "1.5", "2.0", "3.0"]
    assert all(ttc[k]["rear_end"] >= 1 for k in ttc)
    assert doc["scatter"][0][2] == "rear_end" and doc["rules"]["citations"]


def test_occluder_line_of_sight_on_toy_geometry():
    t = np.round(np.arange(0, 10, 0.1), 1)
    n = len(t)
    # sensor (-12, 12). Parked NB occluder, box centre (0, 12) -> x in [-0.9,0.9], y in [9.75,14.25].
    occl = track(1, t, np.zeros(n), np.full(n, 14.25), np.zeros(n), dir_="NB")
    # target NB at x=12, box centre y_c = 2 + 2t. The ray to (12, y_c) is at y = 12 + (y_c-12)*11.1/24
    # on the occluder's near face x=-0.9, inside [9.75, 14.25] for y_c in [7.14, 16.86] -> t in [2.57, 7.43].
    tgt = track(2, t, np.full(n, 12.0), 4.25 + 2 * t, np.full(n, 2.0), dir_="NB")
    occ = repair.occlusion([occl, tgt], sensor=(-12.0, 12.0))
    m, by = occ[2]
    hidden = t[m]
    assert hidden.min() == pytest.approx(2.6, abs=0.06) and hidden.max() == pytest.approx(7.4, abs=0.06)
    assert set(by[m]) == {1}
    assert not occ[1][0].any()            # nothing between sensor and occluder
    obs, sel = repair.occluder_gaps(tgt, m)
    assert len(sel) == 1 and 4.0 <= (sel[0][1] - sel[0][0]) * 0.1 <= 5.0
    # a 5.5 s occlusion exceeds the 0.5-5 s protocol range and is not used
    m2 = np.zeros(n, bool); m2[20:75] = True
    assert repair.occluder_gaps(tgt, m2)[1] == []


def test_kalman_beats_linear_on_accelerating_track():
    t = np.arange(0, 10, 0.1)
    rng = np.random.default_rng(0)
    x = 2 * t + 0.5 * 1.5 * t ** 2 + rng.normal(0, 0.02, len(t))
    y = 0.3 * t ** 2
    v = np.hypot(2 + 1.5 * t, 0.6 * t)
    obs = np.ones(len(t), bool)
    obs[40:70] = False  # 3 s occlusion while accelerating
    rec = repair.repair_track(t, x, y, obs)
    m = ~obs
    xt, yt = 2 * t + 0.75 * t ** 2, y

    def rmse(k):
        rx, ry, rv = rec[k]
        return (np.sqrt(np.mean((rx[m] - xt[m]) ** 2 + (ry[m] - yt[m]) ** 2)),
                np.sqrt(np.mean((rv[m] - v[m]) ** 2)))

    kp, ks = rmse("kf_ca")
    lp, ls = rmse("linear")
    assert kp < 0.5 * lp
    assert ks < 0.5 * ls


def test_occlusion_is_seeded_and_in_range():
    t = np.round(np.arange(0, 12, 0.1), 1)
    trs = [track(i, t, np.zeros_like(t), i + 10 * t, np.full_like(t, 10.0)) for i in range(20)]
    r1 = repair.occlude_and_repair(trs, seed=7)
    r2 = repair.occlude_and_repair(trs, seed=7)
    assert [r["gaps"] for r in r1["tracks"]] == [r["gaps"] for r in r2["tracks"]]
    assert r1["summary"]["tracks_occluded"] == 4
    s = r1["summary"]
    assert set(s["protocols"]) == {"uniform", "occluder"}
    assert {"methods", "by_gap", "validation", "params", "selected_method"} <= set(s)
    assert [b["gap_s"] for b in s["by_gap"]] == [[0.5, 1.0], [1.0, 2.0], [2.0, 3.0], [3.0, 5.0]]
    for r in r1["tracks"]:
        assert r["protocol"] in ("uniform", "occluder")
        if r["protocol"] != "uniform":
            continue
        for g0, g1 in r["gaps"]:
            assert 0.45 <= g1 - g0 + 0.1 <= 5.05


def test_kalman_batch_matches_scalar():
    rng = np.random.default_rng(1)
    z = np.cumsum(rng.normal(0, 0.3, 60))
    obs = np.ones(60, bool); obs[20:35] = False
    pb, vb = repair.kalman_rts(z, obs, r=np.array([0.05, 0.2]), q=np.array([2.0, 50.0]))
    for i, (r, q) in enumerate(((0.05, 2.0), (0.2, 50.0))):
        p, v = repair.kalman_rts(z, obs, r=r, q=q)
        assert np.allclose(pb[i], p) and np.allclose(vb[i], v)


def test_lane_change_gap_subtracts_leader_length():
    # 4.5 m car cuts into lane 2 at t=1 s, front 19 m ahead of a 15 m truck closing at 2 m/s.
    # Bumper gap = 19 - 4.5 = 14.5 m (not 19 - 15 = 4 m) -> TTC stays >= 3.85 s over the 3 s horizon.
    t = np.arange(0, 4.5, 0.1)
    truck = track(1, t, np.zeros_like(t), 12 * t, np.full_like(t, 12.0), lane=2, length=15.0)
    car = track(2, t, np.zeros_like(t), 31 + 10 * (t - 1), np.full_like(t, 10.0), lane=2)
    car["lane"] = np.where(t < 1 - 1e-9, 1, 2)
    series = ssm.lane_change_series([truck, car])
    assert len(series) == 1
    kind, fol, lea, ks, ttc, drac, ok, _ = series[0]
    assert (fol, lea) == (1, 2)
    assert ttc.min() >= 3.85
    assert ssm.lane_change([truck, car], ttc_max=1.5) == []
