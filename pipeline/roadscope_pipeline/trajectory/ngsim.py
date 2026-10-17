"""Fetch NGSIM (Lankershim / Peachtree) from data.transportation.gov SODA and build
smoothed 10 Hz trajectories in local metres around one signalised intersection."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from scipy.signal import savgol_filter

SODA = "https://data.transportation.gov/resource/8ect-6jqj.json"
FT = 0.3048
HZ = 10
DT = 1.0 / HZ
CLS = {"1": "motorcycle", "2": "car", "3": "truck"}
DIRS = {1: "EB", 2: "NB", 3: "WB", 4: "SB"}
MOVES = {1: "through", 2: "left", 3: "right"}

# Per-site intersection choice (see build.py SITES for rationale).
COLS = ["vehicle_id", "frame_id", "global_time", "local_x", "local_y", "v_length", "v_width",
        "v_class", "lane_id", "int_id", "section_id", "direction", "movement", "preceding"]


def _get(params: dict, cache: Path) -> list[dict]:
    if cache.exists():
        return json.loads(cache.read_text())
    rows, off, page = [], 0, 50000
    while True:
        r = requests.get(SODA, params={**params, "$limit": page, "$offset": off,
                                       "$order": ":id"}, timeout=180)
        r.raise_for_status()
        batch = r.json()
        rows += batch
        if len(batch) < page:
            break
        off += page
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(rows))
    return rows


def densest_window(location: str, int_id: int, seconds: float, cache_dir: Path) -> tuple[int, int, tuple[float, float]]:
    """Return (t0_ms, t1_ms, centre_ft) of the window with most distinct vehicles inside the intersection."""
    rows = _get({"$select": "vehicle_id,global_time,local_x,local_y",
                 "$where": f"location='{location}' AND int_id='{int_id}'"},
                cache_dir / f"{location}_int{int_id}_times.json")
    df = pd.DataFrame(rows).astype(float)
    centre = (float(df.local_x.median()), float(df.local_y.median()))
    sec = (df.global_time // 1000).astype(np.int64)
    per_s = df.assign(s=sec).groupby("s").vehicle_id.unique()
    s_index = np.arange(per_s.index.min(), per_s.index.max() + 1)
    best, best_t = -1, int(s_index[0])
    w = int(seconds)
    for s0 in s_index[: max(1, len(s_index) - w)]:
        ids = set()
        for s in range(s0, s0 + w):
            if s in per_s.index:
                ids.update(per_s[s])
        if len(ids) > best:
            best, best_t = len(ids), int(s0)
    return best_t * 1000, (best_t + w) * 1000, centre


def fetch_zone(location: str, t0: int, t1: int, centre: tuple[float, float], half_x_ft: float,
               half_y_ft: float, cache_dir: Path) -> pd.DataFrame:
    cx, cy = centre
    where = (f"location='{location}' AND global_time between {t0} and {t1} "
             f"AND local_x between {cx - half_x_ft} and {cx + half_x_ft} "
             f"AND local_y between {cy - half_y_ft} and {cy + half_y_ft}")
    rows = _get({"$select": ",".join(COLS), "$where": where},
                cache_dir / f"{location}_{t0}_{t1}_zone.json")
    df = pd.DataFrame(rows)
    num = [c for c in COLS]
    df[num] = df[num].apply(pd.to_numeric)
    return df.drop_duplicates(["vehicle_id", "global_time"]).sort_values(["vehicle_id", "global_time"])


def _mode(s: pd.Series) -> int:
    m = s.mode()
    return int(m.iloc[0]) if len(m) else 0


def build_tracks(df: pd.DataFrame, t0: int, centre: tuple[float, float], min_frames: int = 15,
                 window: int = 15, poly: int = 2) -> list[dict]:
    """Smooth NGSIM jitter with Savitzky-Golay on positions; recompute speed and acceleration."""
    cx, cy = centre
    tracks = []
    for vid, g in df.groupby("vehicle_id"):
        k = np.round((g.global_time.values - t0) / 100).astype(int)
        g = g.assign(k=k).drop_duplicates("k").set_index("k")
        full = np.arange(k.min(), k.max() + 1)
        # NGSIM can carry short dropouts (vehicle leaves and re-enters the box): keep longest run.
        runs = np.split(g.index.values, np.where(np.diff(g.index.values) > 3)[0] + 1)
        run = max(runs, key=len)
        if len(run) < min_frames:
            continue
        full = np.arange(run[0], run[-1] + 1)
        g = g.loc[run].reindex(full)
        raw_ok = g.local_x.notna().values & g.local_y.notna().values
        x = g.local_x.interpolate().values * FT - cx * FT
        y = g.local_y.interpolate().values * FT - cy * FT
        lane = g.lane_id.ffill().astype(int).values
        wl = min(window, len(full) - (1 - len(full) % 2))
        if wl % 2 == 0:
            wl -= 1
        xs = savgol_filter(x, wl, poly)
        ys = savgol_filter(y, wl, poly)
        vx = savgol_filter(x, wl, poly, deriv=1, delta=DT)
        vy = savgol_filter(y, wl, poly, deriv=1, delta=DT)
        v = np.hypot(vx, vy)
        a = savgol_filter(v, wl, poly, deriv=1, delta=DT)
        inside = g.int_id.fillna(0).values > 0
        ref = g[inside] if inside.any() else g
        tracks.append({
            "id": int(vid),
            "cls": CLS.get(str(int(g.v_class.dropna().iloc[0])), "car"),
            "len_m": round(float(g.v_length.dropna().iloc[0]) * FT, 2),
            "w_m": round(float(g.v_width.dropna().iloc[0]) * FT, 2),
            "dir": DIRS.get(_mode(ref.direction.dropna()), "?"),
            "move": MOVES.get(_mode(ref.movement.dropna()), "?"),
            "t": full * DT, "x": xs, "y": ys, "v": v, "a": a, "lane": lane,
            "inside": inside, "vx": vx, "vy": vy,
            # unsmoothed NGSIM positions (ft->m, same origin); raw_ok False where interpolated
            "x_raw": x, "y_raw": y, "raw_ok": raw_ok,
        })
    return tracks


def lanes_geom(tracks: list[dict], bin_m: float = 5.0) -> list[dict]:
    """Lane centreline + edges per (direction, lane_id) from lateral percentiles along y bins.
    Only approach points (outside the intersection box, lane_id>0) are used."""
    rows = []
    for tr in tracks:
        m = (~tr["inside"]) & (tr["lane"] > 0) & (tr["v"] >= 0)
        for x, y, ln in zip(tr["x"][m], tr["y"][m], tr["lane"][m]):
            rows.append((tr["dir"], int(ln), x, y))
    if not rows:
        return []
    d = pd.DataFrame(rows, columns=["dir", "lane", "x", "y"])
    d = d[d.dir.isin(["NB", "SB"])]  # corridor approaches run along local y
    d["b"] = np.floor(d.y / bin_m) * bin_m + bin_m / 2
    out = []
    for (dr, ln), g in d.groupby(["dir", "lane"]):
        q = g.groupby("b").x.agg(n="size", lo=lambda s: s.quantile(.1), c="median",
                                 hi=lambda s: s.quantile(.9))
        q = q[q.n >= 20]
        if len(q) < 3:
            continue
        out.append({"dir": dr, "lane": int(ln), "samples": int(q.n.sum()),
                    "centre": [[round(c, 2), round(b, 2)] for b, c in zip(q.index, q.c)],
                    "p10": [[round(c, 2), round(b, 2)] for b, c in zip(q.index, q.lo)],
                    "p90": [[round(c, 2), round(b, 2)] for b, c in zip(q.index, q.hi)]})
    return out
