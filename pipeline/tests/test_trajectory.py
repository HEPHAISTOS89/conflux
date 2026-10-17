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


def test_pet_crossing_cells():
    t = np.round(np.arange(0, 4, 0.1), 1)
    # A northbound along x=1 through y=0 at t=2.0 (10 m/s); B eastbound along y=1, reaching
    # x=1 at t=3.0. Shared 2 m cell [0,2)x[0,2): A in t=[2.0,2.1], B in t=[2.9,3.0] -> PET 0.8 s.
    a = track(1, t, np.full_like(t, 1.0), -20 + 10 * t, np.full_like(t, 10.0), dir_="NB")
    b = track(2, t, -29 + 10 * t, np.full_like(t, 1.0), np.full_like(t, 10.0), dir_="EB")
    ev = ssm.pet([a, b])
    assert len(ev) == 1
    assert ev[0]["pet"] == pytest.approx(0.8, abs=1e-6)
    assert (ev[0]["a"], ev[0]["b"], ev[0]["severity"]) == (1, 2, "critical")
    # opposing throughs do not conflict
    c = track(3, t, np.full_like(t, 1.0), 20 - 10 * t, np.full_like(t, 10.0), dir_="SB")
    assert ssm.pet([a, c]) == []


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
    for r in r1["tracks"]:
        for g0, g1 in r["gaps"]:
            assert 0.7 <= g1 - g0 + 0.1 <= 3.05
