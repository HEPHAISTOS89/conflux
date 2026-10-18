"""SinD (Tsinghua SOTIF-AVLab, Tianjin signalised intersection, drone, 10 Hz) -> site trajectory feed.

Reads one SinD record folder (Veh_smoothed_tracks.csv, Ped_smoothed_tracks.csv, Veh_tracks_meta.csv) and the
Lanelet2 map (crosswalk lanelets) and writes a site folder in the documented schema (site.json + tracks.csv),
so the public converter path is exercised exactly as it will be by a LiDAR feed. Window: the 90 s with the most
pedestrian x vehicle co-presence. SinD vehicle x, y are bounding-box centres (reference "centre");
pedestrians are points. Licence: CC0 1.0 modified by the authors to exclude commercial purposes (LICENSE in the
repository); cite Xu et al. (2022) ITSC, doi:10.1109/ITSC55140.2022.9921959.
CLI: python -m roadscope_pipeline.trajectory.sind --record <dir> --map <osm> --out data/sites/tianjin-sind"""
from __future__ import annotations

import argparse
import csv
import json
import math
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

import numpy as np

from .site import SCHEMA

R_EARTH = 6378137.0
HZ = 10
CLASS = {"car": "car", "truck": "truck", "bus": "bus", "motorcycle": "motorcycle", "bicycle": "bicycle",
         "tricycle": "motorcycle", "pedestrian": "pedestrian"}
SOURCE = {
    "dataset": "SinD: a drone dataset at a signalised intersection in Tianjin, China (SOTIF-AVLab, Tsinghua University); record 8_2_1 sample",
    "url": "https://github.com/SOTIF-AVLab/SinD",
    "licence": "CC0 1.0 as modified by the authors: not permitted for commercial purposes (non-commercial research and display only)",
    "citation": "Xu, Y., Shao, W., Li, J., Yang, K., Wang, W., Huang, H., Lv, C., Wang, H. (2022). SIND: A Drone Dataset at "
                "Signalized Intersection in China. IEEE ITSC 2022, 2471-2478. doi:10.1109/ITSC55140.2022.9921959",
}


def lanelet_crosswalks(osm: Path) -> list[dict]:
    """Crosswalk polygons (local metres, equirectangular about lat/lon 0, the SinD map convention) from
    Lanelet2 relations tagged subtype=crosswalk: left way + reversed right way."""
    root = ET.parse(osm).getroot()
    nodes = {n.get("id"): (math.radians(float(n.get("lon"))) * R_EARTH, math.radians(float(n.get("lat"))) * R_EARTH)
             for n in root.iter("node")}
    ways = {w.get("id"): [nodes[nd.get("ref")] for nd in w.iter("nd")] for w in root.iter("way")}
    out = []
    for rel in root.iter("relation"):
        tags = {t.get("k"): t.get("v") for t in rel.iter("tag")}
        if tags.get("type") != "lanelet" or tags.get("subtype") != "crosswalk":
            continue
        left = right = None
        for m in rel.iter("member"):
            if m.get("role") == "left":
                left = ways[m.get("ref")]
            elif m.get("role") == "right":
                right = ways[m.get("ref")]
        if left and right:
            # Lanelet2 bounds may be stored in either direction: join the right bound at the end nearer the left bound's end
            d = lambda a, b: (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
            poly = left + (right[::-1] if d(left[-1], right[-1]) < d(left[-1], right[0]) else right)
            out.append({"id": tags.get("name") or f"cw{len(out) + 1}", "polygon": [[round(x, 2), round(y, 2)] for x, y in poly]})
    return out


def _read(p: Path):
    with Path(p).open(newline="") as fh:
        return list(csv.DictReader(fh))


def load_record(record: Path):
    veh = _read(record / "Veh_smoothed_tracks.csv")
    ped = _read(record / "Ped_smoothed_tracks.csv")
    tracks = defaultdict(list)   # id -> [(t, x, y, heading_deg)]
    meta = {}
    for r in veh:
        tid = r["track_id"]
        meta[tid] = (CLASS.get(r["agent_type"], "car"), float(r["length"]), float(r["width"]))
        hd = (90.0 - math.degrees(float(r["heading_rad"]))) % 360.0   # math rad ccw from +x -> deg cw from +y
        tracks[tid].append((round(float(r["timestamp_ms"]) / 1000.0, 1), float(r["x"]), float(r["y"]), hd))
    for r in ped:
        tid = r["track_id"]
        meta[tid] = ("pedestrian", None, None)
        tracks[tid].append((round(float(r["timestamp_ms"]) / 1000.0, 1), float(r["x"]), float(r["y"]), None))
    return tracks, meta


def best_window(tracks, meta, seconds: float = 90.0) -> tuple[float, float]:
    """Start time maximising (pedestrian tracks present) x (vehicle tracks present) over the window."""
    t_end = max(p[-1][0] for p in tracks.values())
    best, best_t = -1.0, 0.0
    for t0 in np.arange(0, max(0.0, t_end - seconds) + 1, 5.0):
        t1 = t0 + seconds
        pn = vn = 0
        for tid, pts in tracks.items():
            if pts[0][0] <= t1 and pts[-1][0] >= t0:
                if meta[tid][0] == "pedestrian":
                    pn += 1
                else:
                    vn += 1
        score = pn * vn
        if score > best:
            best, best_t = score, float(t0)
    return best_t, best_t + seconds


def write_site(record: Path, osm: Path, out: Path, seconds: float = 90.0, window: tuple[float, float] | None = None) -> dict:
    tracks, meta = load_record(record)
    crosswalks = lanelet_crosswalks(osm)
    t0, t1 = window or best_window(tracks, meta, seconds)
    # intersection box: the hull of the crosswalk inner edges, i.e. the bounding box of all crosswalk vertices
    pts = np.array([p for cw in crosswalks for p in cw["polygon"]], float)
    cx, cy = pts.mean(0)
    box = [[round(float(pts[:, 0].min() - cx), 2), round(float(pts[:, 1].min() - cy), 2)],
           [round(float(pts[:, 0].max() - cx), 2), round(float(pts[:, 1].max() - cy), 2)]]
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    n = 0
    with (out / "tracks.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["site_id", "track_id", "class", "t", "x", "y", "length", "width", "heading", "lane"])
        for tid in sorted(tracks, key=lambda k: (meta[k][0] == "pedestrian", k)):
            cls, L, W = meta[tid]
            for t, x, y, hd in sorted(tracks[tid]):
                if t0 <= t <= t1:
                    w.writerow(["tianjin-sind", tid, cls, f"{t - t0:.1f}", f"{x:.3f}", f"{y:.3f}",
                                "" if L is None else f"{L:.2f}", "" if W is None else f"{W:.2f}",
                                "" if hd is None else f"{hd:.1f}", ""])
                    n += 1
    site = {
        "schema": SCHEMA, "id": "tianjin-sind", "name": "Tianjin signalised intersection (SinD 8_2_1)", "city": "Tianjin, China",
        "hz": HZ, "units": "m", "reference": "centre", "recorded": f"Monday 09:00-10:00, sunny; record seconds {t0:.0f}-{t1:.0f}",
        "window": [0.0, round(t1 - t0, 1)], "origin": [round(float(cx), 2), round(float(cy), 2)], "rotate_deg": 0,
        "box": box, "crosswalks": crosswalks, "source": SOURCE,
        "notes": "Drone video, 10 Hz, vehicle boxes centred (converter moves the point to the front bumper); "
                 "pedestrians are points (0.5 x 0.5 m footprint assumed). Signal states are not applied.",
    }
    (out / "site.json").write_text(json.dumps(site, indent=1))
    return {"site": out, "rows": n, "window": [t0, t1], "crosswalks": [c["id"] for c in crosswalks], "box": box}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--record", required=True)
    ap.add_argument("--map", required=True)
    ap.add_argument("--out", default="data/sites/tianjin-sind")
    ap.add_argument("--seconds", type=float, default=90.0)
    ap.add_argument("--t0", type=float, default=None, help="fixed window start (s) instead of the densest window")
    a = ap.parse_args(argv)
    win = (a.t0, a.t0 + a.seconds) if a.t0 is not None else None
    print(json.dumps(write_site(Path(a.record), Path(a.map), Path(a.out), a.seconds, win), default=str, indent=1))


if __name__ == "__main__":
    main()
