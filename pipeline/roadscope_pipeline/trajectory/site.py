"""Site trajectory feed (docs/SITE_TRAJECTORY_SCHEMA.md) -> curated intersection format.

Reads a site folder (site.json + tracks.csv | tracks.json), validates it, converts units and the
vehicle reference point to the curated convention (metres, front-bumper centre, 10 Hz, local plane
with +y along the main road), smooths positions (Savitzky-Golay, numpy only so the ingest Lambda
needs no scipy), derives direction / movement / lane / inside flags, and runs the surrogate safety
measures. The curated files are the same shape as the NGSIM sites built by build.py."""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import re
from urllib.parse import urlparse
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import numpy as np

from . import ssm

SCHEMA = "conflux-site/1.0"
HZ = 10
DT = 1.0 / HZ
FT = 0.3048
CLASSES = ("pedestrian", "bicycle", "motorcycle", "car", "truck", "bus")
VRU = {"pedestrian", "bicycle"}
DEFAULT_DIMS = {"pedestrian": (0.5, 0.5), "bicycle": (1.8, 0.6), "motorcycle": (2.0, 0.8),
                "car": (4.5, 1.8), "truck": (8.0, 2.5), "bus": (12.0, 2.6)}
REQUIRED = ("site_id", "track_id", "class", "t", "x", "y")
GRID_TOL = 0.02      # s   |t - nearest 0.1 s| above this is "off the 10 Hz grid"
MAX_GAP_S = 0.5      # s   internal gaps up to this are interpolated; longer ones split the track
MIN_FRAMES = 15      # 1.5 s
LANE_W = 3.5         # m   lateral bin when the feed carries no lane column
SG_WINDOW, SG_ORDER = 15, 2
MAX_WINDOW_S = 300.0
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")


class SiteError(ValueError):
    """A validation failure that names the offending field or row."""


# ---------------------------------------------------------------- reading

def read_site(folder: Path) -> dict:
    p = Path(folder) / "site.json"
    if not p.exists():
        raise SiteError(f"{p} missing")
    site = json.loads(p.read_text())
    if site.get("schema") != SCHEMA:
        raise SiteError(f"site.json schema must be '{SCHEMA}', got {site.get('schema')!r}")
    for k in ("id", "name", "city", "hz", "units", "reference", "recorded", "box", "source"):
        if k not in site:
            raise SiteError(f"site.json missing '{k}'")
    if not ID_RE.fullmatch(str(site["id"])):
        raise SiteError(f"site.json id {site['id']!r} must match {ID_RE.pattern}")
    if site["hz"] != HZ:
        raise SiteError(f"site.json hz must be {HZ}")
    if site["units"] not in ("m", "ft"):
        raise SiteError("site.json units must be 'm' or 'ft'")
    if site["reference"] not in ("front_bumper", "centre"):
        raise SiteError("site.json reference must be 'front_bumper' or 'centre'")
    for k in ("dataset", "url", "licence", "citation"):
        v = site["source"].get(k)
        if not v or not isinstance(v, str):
            raise SiteError(f"site.json source.{k} missing")
        if len(v) > 500:
            raise SiteError(f"site.json source.{k} longer than 500 characters")
    for k in ("name", "city", "recorded"):
        if not isinstance(site[k], str) or not site[k] or len(site[k]) > 200:
            raise SiteError(f"site.json {k} must be a string of 1-200 characters")
    u = urlparse(site["source"]["url"])
    if u.scheme not in ("http", "https") or not u.netloc:
        raise SiteError("site.json source.url must be an http(s) URL")
    box = site["box"]
    if not (isinstance(box, list) and len(box) == 2 and all(len(c) == 2 for c in box)):
        raise SiteError("site.json box must be [[x0, y0], [x1, y1]]")
    for cw in site.get("crosswalks", []):
        if "id" not in cw or len(cw.get("polygon", [])) < 3:
            raise SiteError(f"crosswalk {cw.get('id')!r} needs an id and a polygon with >= 3 vertices")
    return site


def _num(row: dict, k: str, i: int, required: bool = True) -> float | None:
    v = row.get(k)
    if v is None or str(v).strip() == "":
        if required:
            raise SiteError(f"tracks row {i}: '{k}' is empty")
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise SiteError(f"tracks row {i}: '{k}' = {v!r} is not a number") from None
    if not math.isfinite(f):
        raise SiteError(f"tracks row {i}: '{k}' = {v!r} is not finite")
    if k in ("length", "width") and not 0 < f <= 100:
        raise SiteError(f"tracks row {i}: '{k}' = {v!r} must be in (0, 100]")
    return f


def read_tracks(folder: Path, site_id: str) -> dict[str, dict]:
    """-> {track_id: {"cls", "len", "w", "lane", "pts": [(t, x, y, heading|None)]}} in feed units."""
    folder = Path(folder)
    if (folder / "tracks.csv").exists():
        return _read_csv(folder / "tracks.csv", site_id)
    if (folder / "tracks.json").exists():
        return _read_json(folder / "tracks.json")
    raise SiteError(f"{folder}: neither tracks.csv nor tracks.json found")


def _new(cls: str, i: int) -> dict:
    if cls not in CLASSES:
        raise SiteError(f"tracks row {i}: class {cls!r} not in {CLASSES}")
    return {"cls": cls, "len": None, "w": None, "lane": None, "pts": []}


def _read_csv(p: Path, site_id: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    with p.open(newline="") as fh:
        r = csv.DictReader(fh)
        missing = [k for k in REQUIRED if k not in (r.fieldnames or [])]
        if missing:
            raise SiteError(f"tracks.csv missing columns {missing}")
        for i, row in enumerate(r, start=2):
            if str(row["site_id"]).strip() != site_id:
                raise SiteError(f"tracks row {i}: site_id {row['site_id']!r} != {site_id!r}")
            tid = str(row["track_id"]).strip()
            if not tid:
                raise SiteError(f"tracks row {i}: track_id empty")
            tr = out.get(tid)
            if tr is None:
                tr = out[tid] = _new(str(row["class"]).strip(), i)
            elif tr["cls"] != str(row["class"]).strip():
                raise SiteError(f"tracks row {i}: track {tid} changes class to {row['class']!r}")
            t, x, y = _num(row, "t", i), _num(row, "x", i), _num(row, "y", i)
            L, W = _num(row, "length", i, False), _num(row, "width", i, False)
            if L is not None:
                tr["len"] = L
            if W is not None:
                tr["w"] = W
            ln = _num(row, "lane", i, False)
            if ln is not None:
                tr["lane"] = int(ln)
            tr["pts"].append((t, x, y, _num(row, "heading", i, False)))
    return out


def _read_json(p: Path) -> dict[str, dict]:
    doc = json.loads(p.read_text())
    out: dict[str, dict] = {}
    for i, tr in enumerate(doc.get("tracks", [])):
        tid = str(tr.get("id", "")).strip()
        if not tid:
            raise SiteError(f"tracks.json track {i}: id missing")
        o = out[tid] = _new(str(tr.get("class")), i)
        o["len"], o["w"] = _num(tr, "length", i, False), _num(tr, "width", i, False)
        ln = _num(tr, "lane", i, False)
        o["lane"] = int(ln) if ln is not None else None
        for pt in tr.get("pts", []):
            if len(pt) < 3:
                raise SiteError(f"tracks.json track {tid}: point {pt} needs [t, x, y]")
            vals = [float(pt[0]), float(pt[1]), float(pt[2]), float(pt[3]) if len(pt) > 3 and pt[3] is not None else None]
            if not all(math.isfinite(x) for x in vals if x is not None):
                raise SiteError(f"tracks.json track {tid}: point {pt} has a non-finite value")
            o["pts"].append(tuple(vals))
    return out


# ---------------------------------------------------------------- numerics

def savgol(y: np.ndarray, window: int = SG_WINDOW, order: int = SG_ORDER, deriv: int = 0, delta: float = DT) -> np.ndarray:
    """Savitzky-Golay filter with scipy's 'interp' edge mode, in numpy: a least-squares polynomial of
    `order` over `window` samples; the interior is a convolution, the edges a direct polynomial fit."""
    y = np.asarray(y, float)
    n = len(y)
    w = min(window, n - (1 - n % 2))
    if w % 2 == 0:
        w -= 1
    if w < order + 2:
        if deriv == 0:
            return y.copy()
        return np.gradient(y, delta) if deriv == 1 and n > 1 else np.zeros(n)
    h = w // 2
    k = np.arange(-h, h + 1, dtype=float)
    A = np.vander(k, order + 1, increasing=True)          # columns 1, k, k^2 ...
    coef = np.linalg.pinv(A)                               # (order+1, w): polynomial coefficients from samples
    scale = math.factorial(deriv) / delta ** deriv
    out = np.convolve(y, coef[deriv][::-1], mode="same") * scale
    # edges: fit the first/last window once and evaluate the polynomial (or its derivative) there
    for s, idx in ((slice(0, w), np.arange(h)), (slice(n - w, n), np.arange(n - h, n))):
        c = coef @ y[s]
        kk = idx - (s.start + h)
        val = np.zeros(len(kk))
        for p in range(deriv, order + 1):
            val += c[p] * (math.factorial(p) / math.factorial(p - deriv)) * kk ** (p - deriv)
        out[idx] = val / delta ** deriv
    return out


def point_in_polygon(x, y, poly) -> np.ndarray:
    """Even-odd rule for arrays of points against one polygon [[x, y], ...]."""
    px = np.asarray([p[0] for p in poly], float)
    py = np.asarray([p[1] for p in poly], float)
    x, y = np.asarray(x, float), np.asarray(y, float)
    inside = np.zeros(x.shape, bool)
    j = len(px) - 1
    for i in range(len(px)):
        cond = (py[i] > y) != (py[j] > y)
        xs = (px[j] - px[i]) * (y - py[i]) / np.where(py[j] == py[i], 1e-12, py[j] - py[i]) + px[i]
        inside ^= cond & (x < xs)
        j = i
    return inside


def _transform(xy, origin, rot_deg: float) -> np.ndarray:
    th = math.radians(rot_deg)
    c, s = math.cos(th), math.sin(th)
    p = np.asarray(xy, float) - np.asarray(origin, float)
    return np.column_stack([c * p[:, 0] - s * p[:, 1], s * p[:, 0] + c * p[:, 1]])


def _dir(dx: float, dy: float) -> str:
    return ("EB" if dx > 0 else "WB") if abs(dx) >= abs(dy) else ("NB" if dy > 0 else "SB")


def _move(th: np.ndarray, v: np.ndarray, cls: str) -> str:
    if cls == "pedestrian":
        return "cross"
    mv = np.flatnonzero(v >= 1.0)
    if len(mv) < 2:
        return "through"
    d = math.degrees(math.atan2(math.sin(th[mv[-1]] - th[mv[0]]), math.cos(th[mv[-1]] - th[mv[0]])))
    return "left" if d > 45 else "right" if d < -45 else "through"


# ---------------------------------------------------------------- conversion

def convert_tracks(site: dict, feed: dict[str, dict]) -> tuple[list[dict], dict]:
    """Feed tracks -> internal track dicts (ssm.py keys) in curated units; returns (tracks, report)."""
    unit = FT if site["units"] == "ft" else 1.0
    origin = site.get("origin", [0.0, 0.0])
    rot = float(site.get("rotate_deg", 0.0))
    win = site.get("window")
    if win is not None and win[1] - win[0] > MAX_WINDOW_S:
        raise SiteError(f"window longer than {MAX_WINDOW_S:.0f} s")
    box = np.asarray(site["box"], float) * unit
    (bx0, by0), (bx1, by1) = box.min(0), box.max(0)
    front = site["reference"] == "front_bumper"
    report = Counter()
    tracks = []
    for tid, tr in feed.items():
        cls = tr["cls"]
        pts = sorted(tr["pts"])
        t = np.array([p[0] for p in pts], float)
        if win is not None:
            keep = (t >= win[0] - 1e-9) & (t <= win[1] + 1e-9)
            pts = [p for p, k in zip(pts, keep) if k]
            t = t[keep]
        if len(t) == 0:
            report["outside_window"] += 1
            continue
        off = np.abs(t * HZ - np.round(t * HZ)) / HZ
        if (off > GRID_TOL).any():
            i = int(np.flatnonzero(off > GRID_TOL)[0])
            raise SiteError(f"track {tid}: t = {t[i]:.4f} s is off the {HZ} Hz grid (tolerance {GRID_TOL} s)")
        k = np.round(t * HZ).astype(int)
        k, first = np.unique(k, return_index=True)
        xy = _transform([(pts[i][1] * unit, pts[i][2] * unit) for i in first], np.asarray(origin, float) * unit, rot)
        hd = np.array([pts[i][3] if pts[i][3] is not None else np.nan for i in first], float)
        # split at gaps longer than MAX_GAP_S, keep the longest run, interpolate the rest
        cuts = np.flatnonzero(np.diff(k) > int(round(MAX_GAP_S * HZ))) + 1
        runs = np.split(np.arange(len(k)), cuts)
        if len(runs) > 1:
            report["split"] += 1
        run = max(runs, key=len)
        k, xy, hd = k[run], xy[run], hd[run]
        full = np.arange(k[0], k[-1] + 1)
        if len(full) < MIN_FRAMES:
            report["too_short"] += 1
            continue
        x = np.interp(full, k, xy[:, 0])
        y = np.interp(full, k, xy[:, 1])
        report["interpolated_frames"] += int(len(full) - len(k))
        L, W = tr["len"], tr["w"]
        dL, dW = DEFAULT_DIMS[cls]
        L = dL if L is None else L * unit
        W = dW if W is None else W * unit
        if cls in VRU:
            L, W = min(L, 2.5), min(W, 1.0)
        L, W = min(max(L, 0.3), 30.0), min(max(W, 0.3), 4.0)   # any class: a plausible road-user box before it reaches ssm
        xs, ys = savgol(x), savgol(y)
        vx, vy = savgol(x, deriv=1), savgol(y, deriv=1)
        v = np.hypot(vx, vy)
        a = savgol(v, deriv=1)
        if np.isfinite(hd).all():
            th = np.pi / 2 - np.unwrap(np.radians(np.interp(full, k, np.degrees(np.unwrap(np.radians(hd))))))
            th = th + math.radians(rot)
        else:
            th = ssm.heading({"x": xs, "y": ys, "vx": vx, "vy": vy, "dir": None})
        if not front and cls != "pedestrian":
            # the curated convention is the front-bumper centre: push the centre half a length forward
            xs, ys = xs + np.cos(th) * L / 2, ys + np.sin(th) * L / 2
            report["recentred"] += 1
        inside = (xs >= bx0) & (xs <= bx1) & (ys >= by0) & (ys <= by1)
        direction = _dir(xs[-1] - xs[0], ys[-1] - ys[0])
        tracks.append({
            "id": int(tid) if tid.isdigit() else tid, "cls": cls, "len_m": round(float(L), 2), "w_m": round(float(W), 2),
            "dir": direction, "move": _move(th, v, cls), "t": full * DT, "x": xs, "y": ys, "v": v, "a": a,
            "vx": vx, "vy": vy, "inside": inside, "lane_given": tr["lane"], "theta": th,
        })
    _assign_lanes(tracks)
    report["tracks"] = len(tracks)
    return tracks, dict(report)


def _assign_lanes(tracks: list[dict]) -> None:
    """lane: 0 inside the box; given lane when the feed has one; otherwise 3.5 m lateral bins per
    direction counted from the kerb side (1 = kerb lane); pedestrians 100 (unassigned)."""
    lat = {d: [] for d in ("NB", "SB", "EB", "WB")}
    for tr in tracks:
        if tr["cls"] in VRU or tr["lane_given"] is not None:
            continue
        m = ~tr["inside"]
        lat[tr["dir"]].extend((tr["x"] if tr["dir"] in ("NB", "SB") else tr["y"])[m].tolist())
    edge = {}
    for d, vals in lat.items():
        if vals:
            # kerb side: NB/EB kerb is the +x / -y side? Use the side away from the opposing flow:
            # NB traffic keeps right (+x), SB keeps right (-x); EB keeps right (-y), WB keeps right (+y).
            q = np.percentile(vals, [2, 98])
            edge[d] = q[1] if d in ("NB", "WB") else q[0]
    for tr in tracks:
        n = len(tr["t"])
        if tr["cls"] in VRU:
            lane = np.full(n, 100)
        elif tr["lane_given"] is not None:
            lane = np.full(n, int(tr["lane_given"]))
        else:
            d = tr["dir"]
            s = tr["x"] if d in ("NB", "SB") else tr["y"]
            e = edge.get(d, float(s[0]))
            lane = 1 + np.floor(np.abs(s - e) / LANE_W).astype(int)
            lane = np.clip(lane, 1, 9)
        lane = np.where(tr["inside"], 0, lane)
        tr["lane"] = lane.astype(int)


def lanes_geom(tracks: list[dict], bin_m: float = 5.0) -> list[dict]:
    """Lane centre + p10/p90 edges per (NB/SB direction, lane) from approach points (ngsim.lanes_geom without pandas)."""
    rows = defaultdict(list)
    for tr in tracks:
        if tr["cls"] in VRU or tr["dir"] not in ("NB", "SB"):
            continue
        m = (~tr["inside"]) & (tr["lane"] > 0)
        for x, y, ln in zip(tr["x"][m], tr["y"][m], tr["lane"][m]):
            rows[(tr["dir"], int(ln), math.floor(y / bin_m) * bin_m + bin_m / 2)].append(x)
    by = defaultdict(dict)
    for (d, ln, b), xs in rows.items():
        if len(xs) >= 20:
            by[(d, ln)][b] = (len(xs), *np.percentile(xs, [10, 50, 90]))
    out = []
    for (d, ln), bins in sorted(by.items()):
        if len(bins) < 3:
            continue
        bs = sorted(bins)
        out.append({"dir": d, "lane": ln, "samples": int(sum(bins[b][0] for b in bs)),
                    "centre": [[round(float(bins[b][2]), 2), round(float(b), 2)] for b in bs],
                    "p10": [[round(float(bins[b][1]), 2), round(float(b), 2)] for b in bs],
                    "p90": [[round(float(bins[b][3]), 2), round(float(b), 2)] for b in bs]})
    return out


def _r2(a):
    return [round(float(v), 2) for v in a]


def _np(o):
    if isinstance(o, np.generic):
        return o.item()
    raise TypeError(f"not JSON serializable: {type(o).__name__}")


def crosswalk_polys(site: dict) -> list[dict]:
    unit = FT if site["units"] == "ft" else 1.0
    origin = np.asarray(site.get("origin", [0.0, 0.0]), float) * unit
    rot = float(site.get("rotate_deg", 0.0))
    out = []
    for cw in site.get("crosswalks", []):
        poly = _transform(np.asarray(cw["polygon"], float) * unit, origin, rot)
        out.append({"id": str(cw["id"]), "polygon": [_r2(p) for p in poly]})
    return out


def build(site: dict, feed: dict[str, dict], repair: bool = False) -> dict[str, Any]:
    """Site + feed -> {"doc", "conflicts", "ssm", "repair"|None, "index", "report"} ready to serialise."""
    tracks, report = convert_tracks(site, feed)
    if not tracks:
        raise SiteError("no track survived validation")
    crosswalks = crosswalk_polys(site)
    if any(tr["cls"] == "pedestrian" for tr in tracks) and not crosswalks:
        raise SiteError("the feed has pedestrians but site.json defines no crosswalks (needed for PET and yielding)")
    unit = FT if site["units"] == "ft" else 1.0
    box = _transform(np.asarray(site["box"], float) * unit, np.asarray(site.get("origin", [0, 0]), float) * unit,
                     float(site.get("rotate_deg", 0.0)))
    conflicts, ssm_doc = ssm.analyse(tracks, crosswalks=crosswalks)
    rep = None
    if repair:
        from . import repair as repair_mod
        vehicles = [t for t in tracks if t["cls"] not in VRU and isinstance(t["id"], int)]
        rep = repair_mod.occlude_and_repair(vehicles) if len(vehicles) >= 5 else None
    xs = np.concatenate([t["x"] for t in tracks]); ys = np.concatenate([t["y"] for t in tracks])
    t0 = min(float(t["t"][0]) for t in tracks); t1 = max(float(t["t"][-1]) for t in tracks)
    classes = Counter(t["cls"] for t in tracks)
    doc = {
        "id": site["id"], "name": site["name"], "schema": SCHEMA,
        "source": {**site["source"], "location": site.get("city"), "recorded": site["recorded"],
                   "feed_units": site["units"], "feed_reference": site["reference"],
                   "processing": "site feed -> m, front-bumper reference, local plane (+y main road); "
                                 "Savitzky-Golay (15 frames, order 2) on x/y, v and a from smoothed derivatives; "
                                 f"gaps <= {MAX_GAP_S} s interpolated"},
        "hz": HZ, "window_s": round(t1 - t0, 1), "t0": round(t0, 1),
        "bbox": [_r2([xs.min(), ys.min()]), _r2([xs.max(), ys.max()])],
        "axes": "local metres; +y along the main road, +x across; vehicle point = front-bumper centre, pedestrian point = body centre",
        "box": [_r2(box.min(0)), _r2(box.max(0))], "crosswalks": crosswalks, "classes": dict(classes),
        "lanes_geom": lanes_geom(tracks),
        "tracks": [{"id": t["id"], "cls": t["cls"], "len_m": t["len_m"], "w_m": t["w_m"], "dir": t["dir"], "move": t["move"],
                    "pts": [[round(float(a), 1), *_r2(b)] + [int(c)] for a, *b, c in zip(t["t"], t["x"], t["y"], t["v"], t["a"], t["lane"])]}
                   for t in tracks],
    }
    by = Counter((c["type"], c["severity"]) for c in conflicts)
    index = {"id": site["id"], "name": site["name"], "site": site["id"], "city": site.get("city"),
             "approach": "site feed", "window": [t0, t1], "recorded": site["recorded"], "s": round(t1 - t0, 1), "hz": HZ,
             "tracks": len(tracks), "classes": dict(classes), "conflicts": len(conflicts),
             "summary": {"conflicts_by_type": dict(Counter(c["type"] for c in conflicts)),
                         "conflicts_by_type_severity": {f"{k[0]}:{k[1]}": v for k, v in sorted(by.items())},
                         "conflicts_drac_flag": sum(c["drac_flag"] for c in conflicts),
                         "conflicts_overlap": sum(c["overlap"] for c in conflicts),
                         "ssm_rules": {k: ssm_doc["rules"][k] for k in ("detection", "drac", "pedestrian_pet", "failure_to_yield")},
                         **({"repair": rep["summary"]} if rep else {})}}
    return {"doc": doc, "conflicts": conflicts, "ssm": {"id": site["id"], **ssm_doc}, "repair": rep, "index": index, "report": report}


def write_outputs(built: dict, out_dir: Path) -> list[Path]:
    out_dir = Path(out_dir); out_dir.mkdir(parents=True, exist_ok=True)
    sid = built["doc"]["id"]
    files = [(f"{sid}.json", built["doc"]), (f"{sid}_conflicts.json", built["conflicts"]), (f"{sid}_ssm.json", built["ssm"])]
    if built["repair"]:
        files.append((f"{sid}_repair.json", built["repair"]))
    written = []
    for name, obj in files:
        p = out_dir / name
        p.write_text(json.dumps(obj, separators=(",", ":"), default=_np, allow_nan=False))
        written.append(p)
    ip = out_dir / "index.json"
    index = json.loads(ip.read_text()) if ip.exists() else []
    clash = [row for row in index if row.get("id") == sid and row.get("approach") != "site feed"]
    if clash:
        raise SiteError(f"site id {sid!r} is already a non-site intersection in index.json; choose another id")
    index = [row for row in index if row.get("id") != sid] + [built["index"]]
    ip.write_text(json.dumps(index, indent=1, default=_np))
    written.append(ip)
    return written


def manifest_entry(site: dict, feed_path: Path, n_records: int, when: str | None = None) -> dict:
    import hashlib
    return {"id": f"site_{site['id']}", "url": site["source"]["url"], "licence": site["source"]["licence"],
            "records": n_records, "fetched_at": when or dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "sha256": hashlib.sha256(Path(feed_path).read_bytes()).hexdigest(),
            "filter": f"site feed {site['id']}, window {site.get('window')}",
            "outputs": [f"intersections/{site['id']}{x}.json" for x in ("", "_conflicts", "_ssm")]}


def convert_folder(folder: Path, out: Path, repair: bool = False) -> dict:
    folder = Path(folder)
    site = read_site(folder)
    feed = read_tracks(folder, site["id"])
    built = build(site, feed, repair=repair)
    written = write_outputs(built, Path(out) / "intersections")
    feed_path = folder / ("tracks.csv" if (folder / "tracks.csv").exists() else "tracks.json")
    n_rec = sum(len(t["pts"]) for t in feed.values())
    man_p = Path(out) / "manifest.json"
    man = json.loads(man_p.read_text()) if man_p.exists() else {}
    entry = manifest_entry(site, feed_path, n_rec)
    src = man.setdefault("sources", [])
    src[:] = sorted([e for e in src if e.get("id") != entry["id"]] + [entry], key=lambda e: e.get("id", ""))
    man_p.write_text(json.dumps(man, indent=2))
    return {"site": site["id"], "written": [str(p) for p in written], "records": n_rec, **built["report"],
            "conflicts": built["index"]["conflicts"], "by_type": built["index"]["summary"]["conflicts_by_type"]}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Convert a site trajectory feed to the curated intersection format")
    ap.add_argument("--site", required=True, help="folder with site.json and tracks.csv|tracks.json")
    ap.add_argument("--out", default="data/curated")
    ap.add_argument("--repair", action="store_true", help="also run the occlusion-repair benchmark (slow)")
    a = ap.parse_args(argv)
    print(json.dumps(convert_folder(Path(a.site), Path(a.out), repair=a.repair), indent=1, default=_np))


if __name__ == "__main__":
    main()
