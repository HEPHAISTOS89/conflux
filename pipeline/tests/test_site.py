"""Site trajectory feed: schema validation, conversion and the pedestrian measures end to end."""
import csv
import json
from pathlib import Path

import numpy as np
import pytest

from roadscope_pipeline.trajectory import site, ssm

SITE = {
    "schema": site.SCHEMA, "id": "toy-site", "name": "Toy St at Test Ave", "city": "Lubbock, TX", "hz": 10,
    "units": "m", "reference": "centre", "recorded": "2026-01-01 08:00", "box": [[-10, -10], [10, 10]],
    "crosswalks": [{"id": "S", "polygon": [[-10, -14], [10, -14], [10, -10], [-10, -10]]}],
    "source": {"dataset": "toy", "url": "https://example.org", "licence": "CC0", "citation": "none"},
}


def write_site(tmp: Path, rows, site_doc=SITE):
    (tmp / "site.json").write_text(json.dumps(site_doc))
    with (tmp / "tracks.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["site_id", "track_id", "class", "t", "x", "y", "length", "width", "heading", "lane"])
        w.writerows(rows)


def vehicle_rows(tid, t, x, y, cls="car", L=4.5, W=1.8, heading="", lane=""):
    return [["toy-site", tid, cls, f"{tt:.1f}", f"{xx:.3f}", f"{yy:.3f}", L, W, heading, lane] for tt, xx, yy in zip(t, x, y)]


def ped_rows(tid, t, x, y):
    return [["toy-site", tid, "pedestrian", f"{tt:.1f}", f"{xx:.3f}", f"{yy:.3f}", "", "", "", ""] for tt, xx, yy in zip(t, x, y)]


def test_savgol_matches_polynomial_and_derivative():
    t = np.arange(0, 3, 0.1)
    y = 1 + 2 * t + 0.5 * t ** 2          # order-2 polynomial is reproduced exactly, edges included
    assert np.allclose(site.savgol(y), y, atol=1e-9)
    assert np.allclose(site.savgol(y, deriv=1), 2 + t, atol=1e-6)
    rng = np.random.default_rng(1)
    noisy = y + rng.normal(0, 0.05, len(t))
    assert np.abs(site.savgol(noisy) - y).max() < np.abs(noisy - y).max()


def test_point_in_polygon():
    sq = [[0, 0], [2, 0], [2, 2], [0, 2]]
    m = site.point_in_polygon([1, 3, 0.5], [1, 1, 1.9], sq)
    assert m.tolist() == [True, False, True]


def test_convert_recentres_to_front_bumper_and_assigns_flags(tmp_path):
    t = np.round(np.arange(0, 6, 0.1), 1)
    # NB car, centre reference at x=2 moving +y at 10 m/s from y=-30
    rows = vehicle_rows(7, t, np.full_like(t, 2.0), -30 + 10 * t)
    write_site(tmp_path, rows)
    s = site.read_site(tmp_path)
    feed = site.read_tracks(tmp_path, "toy-site")
    tracks, rep = site.convert_tracks(s, feed)
    assert rep["tracks"] == 1 and rep["recentred"] == 1
    tr = tracks[0]
    assert tr["id"] == 7 and tr["dir"] == "NB" and tr["move"] == "through"
    # front bumper = centre + L/2 along the heading (+y)
    assert tr["y"][10] == pytest.approx(-30 + 10 * 1.0 + 2.25, abs=0.05)
    assert tr["v"][10] == pytest.approx(10.0, abs=0.05)
    inside = tr["inside"]
    assert inside[np.argmin(np.abs(tr["y"] - 0))] and not inside[0]
    assert (tr["lane"][inside] == 0).all() and (tr["lane"][~inside] >= 1).all()


def test_feet_and_front_bumper_feed_is_not_shifted(tmp_path):
    t = np.round(np.arange(0, 3, 0.1), 1)
    doc = {**SITE, "units": "ft", "reference": "front_bumper", "box": [[-30, -30], [30, 30]],
           "crosswalks": [{"id": "S", "polygon": [[-30, -45], [30, -45], [30, -30], [-30, -30]]}]}
    rows = vehicle_rows(1, t, np.zeros_like(t), -100 + 30 * t, L=15, W=6)
    write_site(tmp_path, rows, doc)
    tracks, rep = site.convert_tracks(site.read_site(tmp_path), site.read_tracks(tmp_path, "toy-site"))
    tr = tracks[0]
    assert rep.get("recentred", 0) == 0
    assert tr["len_m"] == pytest.approx(15 * 0.3048, abs=0.01)
    assert tr["y"][0] == pytest.approx(-100 * 0.3048, abs=0.05)
    assert tr["v"][5] == pytest.approx(30 * 0.3048, abs=0.05)


def test_off_grid_timestamp_and_bad_class_are_rejected(tmp_path):
    t = np.round(np.arange(0, 3, 0.1), 1)
    rows = vehicle_rows(1, t, np.zeros_like(t), 10 * t)
    rows[5][3] = "0.55"
    write_site(tmp_path, rows)
    with pytest.raises(site.SiteError, match="off the 10 Hz grid"):
        site.convert_tracks(site.read_site(tmp_path), site.read_tracks(tmp_path, "toy-site"))
    rows = vehicle_rows(1, t, np.zeros_like(t), 10 * t, cls="scooter")
    write_site(tmp_path, rows)
    with pytest.raises(site.SiteError, match="class 'scooter'"):
        site.read_tracks(tmp_path, "toy-site")
    bad = {**SITE, "hz": 25}
    write_site(tmp_path, [], bad)
    with pytest.raises(site.SiteError, match="hz"):
        site.read_site(tmp_path)


def test_gap_interpolation_and_split(tmp_path):
    t = np.round(np.arange(0, 6, 0.1), 1)
    rows = vehicle_rows(1, t, np.zeros_like(t), 10 * t)
    rows = [r for r in rows if r[3] not in ("1.0", "1.1", "1.2")]          # 0.3 s gap: interpolated
    rows2 = vehicle_rows(2, t, np.full_like(t, 5.0), 10 * t)
    rows2 = [r for r in rows2 if not (2.0 <= float(r[3]) <= 3.0)]           # 1 s gap: split, longest run kept
    write_site(tmp_path, rows + rows2)
    tracks, rep = site.convert_tracks(site.read_site(tmp_path), site.read_tracks(tmp_path, "toy-site"))
    by = {tr["id"]: tr for tr in tracks}
    assert rep["interpolated_frames"] == 3 and rep["split"] == 1
    assert len(by[1]["t"]) == 60
    assert by[2]["t"][0] == pytest.approx(3.1) and len(by[2]["t"]) == 29


def test_pedestrian_pet_and_failure_to_yield_end_to_end(tmp_path):
    t = np.round(np.arange(0, 8, 0.1), 1)
    # pedestrian crossing the south crosswalk (y in [-14,-10]) west->east at 1.4 m/s, x = -8 + 1.4 t, y = -12
    ped = ped_rows("P1", t, -8 + 1.4 * t, np.full_like(t, -12.0))
    # NB car at x = 4, centre y = -80 + 12 t, never slows: front reaches y=-14 at t≈5.3 while the ped (x≈-0.6) is in the
    # crosswalk; 63 m away when the ped stepped in, beyond the 51 m AASHTO stopping distance at 12 m/s
    car = vehicle_rows(11, t, np.full_like(t, 4.0), -80 + 12 * t)
    # NB car in another lane that stops before the crosswalk (yields) at x = 8: decelerates to 0 by y=-16
    v = np.clip(12 - 3 * t, 0, None)
    y2 = -40 + np.cumsum(v) * 0.1
    car2 = vehicle_rows(12, t, np.full_like(t, 8.0), y2)
    write_site(tmp_path, ped + car + car2)
    s = site.read_site(tmp_path)
    built = site.build(s, site.read_tracks(tmp_path, "toy-site"))
    types = {c["type"] for c in built["conflicts"]}
    assert "yield" in types and "pedestrian" in types
    fty = [c for c in built["conflicts"] if c["type"] == "yield"]
    assert {c["a"] for c in fty} == {11} and all(c["b"] == "P1" for c in fty)
    e = fty[0]
    assert e["crosswalk"] == "S" and e["v_min_mps"] > 5 and e["dist_m"] >= e["ssd_m"]
    assert built["ssm"]["pedestrians"]["yield"]["failures"] == 1
    assert built["ssm"]["pedestrians"]["yield"]["opportunities"] >= 1
    pp = [c for c in built["conflicts"] if c["type"] == "pedestrian"]
    assert all(c["a"] == 11 for c in pp) and pp[0]["pet"] <= 5.0 and pp[0]["severity"] in ("critical", "serious", "moderate")
    # curated document shape matches the NGSIM sites
    doc = built["doc"]
    assert doc["crosswalks"][0]["id"] == "S" and doc["classes"] == {"pedestrian": 1, "car": 2}
    pts = doc["tracks"][0]["pts"]
    assert len(pts[0]) == 6 and doc["hz"] == 10
    assert built["index"]["summary"]["conflicts_by_type"]["yield"] == 1
    # yielding vehicle (12) never enters the crosswalk while the ped is there without stopping
    assert all(c["a"] != 12 for c in fty)


def test_pedestrians_without_crosswalks_refused(tmp_path):
    t = np.round(np.arange(0, 3, 0.1), 1)
    doc = {k: v for k, v in SITE.items() if k != "crosswalks"}
    write_site(tmp_path, ped_rows("P1", t, t, np.zeros_like(t)), doc)
    with pytest.raises(site.SiteError, match="crosswalks"):
        site.build(site.read_site(tmp_path), site.read_tracks(tmp_path, "toy-site"))


def test_convert_folder_writes_curated_files_and_index(tmp_path):
    t = np.round(np.arange(0, 4, 0.1), 1)
    rows = vehicle_rows(1, t, np.zeros_like(t), -20 + 10 * t) + vehicle_rows(2, t, np.full_like(t, 3.5), -28 + 10 * t)
    write_site(tmp_path, rows)
    out = tmp_path / "curated"
    res = site.convert_folder(tmp_path, out)
    names = {Path(p).name for p in res["written"]}
    assert names == {"toy-site.json", "toy-site_conflicts.json", "toy-site_ssm.json", "index.json"}
    idx = json.loads((out / "intersections" / "index.json").read_text())
    assert idx[0]["id"] == "toy-site" and idx[0]["tracks"] == 2
    man = json.loads((out / "manifest.json").read_text())
    assert man["sources"][0]["id"] == "site_toy-site" and man["sources"][0]["licence"] == "CC0"
    # a rebuild replaces, not duplicates, the index row and manifest source
    site.convert_folder(tmp_path, out)
    assert len(json.loads((out / "intersections" / "index.json").read_text())) == 1
    assert len(json.loads((out / "manifest.json").read_text())["sources"]) == 1


def test_vehicle_series_ignore_pedestrians():
    t = np.arange(0, 3, 0.1)
    ped = {"id": "P", "cls": "pedestrian", "len_m": 0.5, "w_m": 0.5, "t": t, "x": np.zeros_like(t), "y": 25 + 1.4 * t,
           "v": np.full_like(t, 1.4), "lane": np.full(len(t), 100), "dir": "NB", "move": "cross", "inside": np.ones(len(t), bool)}
    fol = {"id": 2, "cls": "car", "len_m": 4.5, "t": t, "x": np.zeros_like(t), "y": 5 + 15 * t, "v": np.full_like(t, 15.0),
           "lane": np.full(len(t), 100), "dir": "NB", "move": "through", "inside": np.ones(len(t), bool)}
    assert ssm.rear_end(ssm.vehicles([ped, fol])) == []
    conf, doc = ssm.analyse([ped, fol])
    assert conf == [] and doc["pedestrians"]["tracks"] == 1 and doc["pedestrians"]["yield"]["opportunities"] == 0


def test_non_finite_and_bad_dimensions_rejected(tmp_path):
    t = np.round(np.arange(0, 3, 0.1), 1)
    rows = vehicle_rows(1, t, np.zeros_like(t), 10 * t)
    rows[3][4] = "nan"
    write_site(tmp_path, rows)
    with pytest.raises(site.SiteError, match="not finite"):
        site.read_tracks(tmp_path, "toy-site")
    rows = vehicle_rows(1, t, np.zeros_like(t), 10 * t, L="inf")
    write_site(tmp_path, rows)
    with pytest.raises(site.SiteError, match="not finite"):
        site.read_tracks(tmp_path, "toy-site")
    rows = vehicle_rows(1, t, np.zeros_like(t), 10 * t, W=-1)
    write_site(tmp_path, rows)
    with pytest.raises(site.SiteError, match="must be in"):
        site.read_tracks(tmp_path, "toy-site")


def test_site_cannot_overwrite_a_non_site_intersection(tmp_path):
    t = np.round(np.arange(0, 4, 0.1), 1)
    rows = [["peachtree-10th", *r[1:]] for r in vehicle_rows(1, t, np.zeros_like(t), -20 + 10 * t)]
    write_site(tmp_path, rows, {**SITE, "id": "peachtree-10th"})
    out = tmp_path / "curated" / "intersections"
    out.mkdir(parents=True)
    (out / "index.json").write_text(json.dumps([{"id": "peachtree-10th", "approach": "all approaches within 61 m x 91 m box"}]))
    with pytest.raises(site.SiteError, match="non-site intersection"):
        site.convert_folder(tmp_path, tmp_path / "curated")
    assert json.loads((out / "index.json").read_text())[0]["approach"].startswith("all approaches")


def test_source_url_and_json_dimensions_validated(tmp_path):
    bad = {**SITE, "source": {**SITE["source"], "url": "javascript:alert(1)"}}
    write_site(tmp_path, [], bad)
    with pytest.raises(site.SiteError, match="http"):
        site.read_site(tmp_path)
    (tmp_path / "tracks.csv").unlink()
    (tmp_path / "tracks.json").write_text(json.dumps({"tracks": [{"id": "1", "class": "car", "length": "inf", "pts": [[0, 0, 0]]}]}))
    with pytest.raises(site.SiteError, match="not finite"):
        site.read_tracks(tmp_path, "toy-site")
