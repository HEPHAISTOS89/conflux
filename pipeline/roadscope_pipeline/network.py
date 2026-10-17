"""One-mile segment network: geometry, DFO calibration, attribute joins, screening metrics.

Data notes (verified against the live layers, 2026-10-17):
* Segment_Crash__Results has no item description. ``SUM_CRASH_`` values are all multiples
  of 1/9 (0.111, 0.333, 1.444 …; sums of rounded ninths such as 1.334 also occur), i.e. each
  crash contributes 1/9. We therefore read SUM_CRASH_ as *mean annual crashes over a 9-year
  window* and recover the integer count as N = round(9·SUM_CRASH_). The window years and the
  crash population (all severities vs. a subset) are not documented by the publisher.
* No severity split exists at segment level, so segment EPDO cannot be computed and is null.
* ``START_M``/``END_M`` are measures on the segmented route part (``US0084-KG_01`` starts at
  0) — not TxDOT DFO. Segment end points are therefore projected onto TxDOT_AADT geometry of
  the same route (``US0084-KG_01`` → ``US0084-KG`` = AADT ``RTE_NM`` = inventory/speed
  ``RIA_RTE_ID``), whose BEGIN/END_DFO give true DFO by linear referencing; joins are then
  DFO-overlap, length-weighted.
"""
from __future__ import annotations

import math
from collections import defaultdict

import numpy as np

from . import spf as S

LAT0 = 33.6
KX = 111320.0 * math.cos(math.radians(LAT0))
KY = 110574.0
CRASH_YEARS = 9
MAX_SNAP_M = 150.0

FC_GROUPS = {1: "Interstate/Freeway", 2: "Interstate/Freeway", 3: "Principal arterial",
             4: "Minor arterial", 5: "Collector/Local", 6: "Collector/Local", 7: "Collector/Local"}

CORRIDORS = [
    ("us-84", "US 84 (Slaton Hwy / Clovis Rd)", ["US0084-KG"]),
    ("us-62-82", "US 62/82 (19th St / Marsha Sharp Fwy)", ["US0062-KG", "US0082-KG"]),
    ("loop-289", "Loop 289", ["SL0289-KG"]),
    ("i-27", "I-27", ["IH0027-KG"]),
    ("sh-114", "SH 114", ["SH0114-KG"]),
    ("fm-2255", "FM 2255", ["FM2255-KG"]),
]


# ---------- geometry (plain math, local equirectangular metres) ----------
def to_xy(p):
    return (p[0] * KX, p[1] * KY)


def line_xy(paths):
    pts = [to_xy(p) for path in paths for p in path]
    return pts


def seg_len(a, b):
    return math.hypot(b[0] - a[0], b[1] - a[1])


def project(pt, line):
    """Return (distance, s_along) of pt's closest point on polyline."""
    best, s_best, acc = math.inf, 0.0, 0.0
    for a, b in zip(line, line[1:]):
        L = seg_len(a, b)
        t = 0.0 if L == 0 else max(0.0, min(1.0, ((pt[0] - a[0]) * (b[0] - a[0]) + (pt[1] - a[1]) * (b[1] - a[1])) / L**2))
        q = (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
        d = seg_len(pt, q)
        if d < best:
            best, s_best = d, acc + t * L
        acc += L
    return best, s_best


def length(line):
    return sum(seg_len(a, b) for a, b in zip(line, line[1:]))


def point_at(line_ll, s):
    """Lon/lat at distance s (m) along a lon/lat polyline."""
    acc = 0.0
    for a, b in zip(line_ll, line_ll[1:]):
        L = seg_len(to_xy(a), to_xy(b))
        if acc + L >= s and L > 0:
            t = (s - acc) / L
            return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
        acc += L
    return list(line_ll[-1])


def douglas_peucker(pts, tol_m):
    if len(pts) < 3:
        return pts
    xy = [to_xy(p) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        a, b = xy[i], xy[j]
        L = seg_len(a, b)
        dmax, idx = 0.0, -1
        for k in range(i + 1, j):
            p = xy[k]
            d = (abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / L) if L else seg_len(a, p)
            if d > dmax:
                dmax, idx = d, k
        if dmax > tol_m:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(pts, keep) if k]


def simplify_paths(paths, tol_m=5.0, nd=5):
    return [[[round(x, nd), round(y, nd)] for x, y in douglas_peucker(path, tol_m)] for path in paths]


# ---------- names ----------
PREFIX = {"IH": "I-{n}", "US": "US {n}", "SH": "SH {n}", "FM": "FM {n}", "SL": "Loop {n}",
          "SS": "Spur {n}", "BU": "Bus. {n}", "RM": "RM {n}", "BI": "Bus. I-{n}"}


def route_key(route_id: str) -> str:
    return route_id.split("_")[0]


def display_route(key: str) -> str:
    hwy = key.split("-")[0]
    pre, num = hwy[:2], hwy[2:].lstrip("0")
    return PREFIX.get(pre, "{n}").format(n=num) if pre in PREFIX else hwy


# ---------- linear-referenced records ----------
class RouteIndex:
    """Records grouped by route with DFO interval and optional geometry."""

    def __init__(self, feats, route_f, frm_f, to_f):
        self.by_route = defaultdict(list)
        for f in feats:
            a = f["attributes"]
            if a.get(route_f) is None or a.get(frm_f) is None or a.get(to_f) is None:
                continue
            paths = (f.get("geometry") or {}).get("paths") or []
            ll = [p for path in paths for p in path]
            rec = {"frm": a[frm_f], "to": a[to_f], "a": a, "ll": ll, "xy": [to_xy(p) for p in ll]}
            rec["len"] = length(rec["xy"]) if rec["xy"] else 0.0
            self.by_route[a[route_f]].append(rec)

    def dfo_at(self, route, pt_ll):
        best = (math.inf, None)
        p = to_xy(pt_ll)
        for r in self.by_route.get(route, []):
            if r["len"] <= 0:
                continue
            d, s = project(p, r["xy"])
            if d < best[0]:
                best = (d, r["frm"] + (r["to"] - r["frm"]) * s / r["len"])
        return best

    def overlaps(self, route, d0, d1):
        out = []
        for r in self.by_route.get(route, []):
            w = min(d1, r["to"]) - max(d0, r["frm"])
            if w > 0:
                out.append((w, r))
        return out

    def at(self, route, d):
        for r in self.by_route.get(route, []):
            if r["frm"] <= d <= r["to"]:
                return r
        return None


def wmean(pairs, field):
    num = den = 0.0
    for w, r in pairs:
        v = r["a"].get(field)
        if v is not None:
            num += w * v
            den += w
    return num / den if den else None


def dominant(pairs, field):
    acc = defaultdict(float)
    for w, r in pairs:
        v = r["a"].get(field)
        if v is not None:
            acc[v] += w
    return max(acc, key=acc.get) if acc else None


# ---------- build ----------
def build_segments(seg_feats, aadt_feats, ri_feats, speed_feats):
    aadt = RouteIndex(aadt_feats, "RTE_NM", "BEGIN_DFO", "END_DFO")
    ri = RouteIndex(ri_feats, "RIA_RTE_ID", "FRM_DFO", "TO_DFO")
    spd = RouteIndex(speed_feats, "RIA_RTE_ID", "FRM_DFO", "TO_DFO")
    segs = []
    for f in seg_feats:
        a = f["attributes"]
        paths = f["geometry"]["paths"]
        key = route_key(a["RouteID"])
        ends = [paths[0][0], paths[-1][-1]]
        dfos = []
        for p in ends:
            d, m = aadt.dfo_at(key, p)
            if d > MAX_SNAP_M:
                d, m = ri.dfo_at(key, p)
            dfos.append(m if d <= MAX_SNAP_M else None)
        d0, d1 = (min(dfos), max(dfos)) if None not in dfos else (None, None)
        ov_a = aadt.overlaps(key, d0, d1) if d0 is not None else []
        ov_r = ri.overlaps(key, d0, d1) if d0 is not None else []
        ov_s = spd.overlaps(key, d0, d1) if d0 is not None else []
        annual = float(a["SUM_CRASH_"] or 0)
        f_sys = dominant(ov_r, "F_SYSTEM")
        aadt_v = wmean(ov_a, "AADT_CUR") or wmean(ov_r, "ADT_CUR")
        lanes = wmean(ov_r, "NUM_LANES")
        segs.append({
            "seg_id": a["SEG_ID"], "route": key, "route_part": a["RouteID"],
            "name": dominant(ov_r, "STE_NAM") or display_route(key),
            "f_system": f_sys, "fc_group": FC_GROUPS.get(f_sys),
            "lanes": round(lanes) if lanes else None,
            "speed_limit": dominant(ov_r, "SPD_MAX"),
            "aadt": round(aadt_v) if aadt_v else None,
            "truck_pct": _r(wmean(ov_r, "TRK_AADT_PCT"), 1),
            "speed_all": _r(wmean(ov_s, "ALLSPEED"), 1),
            "dfo_from": _r(d0, 3), "dfo_to": _r(d1, 3),
            "len_mi": round(float(a["LEN_M"]), 4),
            "crashes_per_yr": round(annual, 3),
            "crashes_total": int(round(annual * CRASH_YEARS)),
            "crash_years": CRASH_YEARS,
            "_paths": paths,
        })
    return segs, {"aadt": aadt, "ri": ri, "speed": spd}


def _r(v, nd):
    return None if v is None else round(v, nd)


def screen(segs, fitted=None):
    """Rates, critical rates, SPF/EB. Mutates segs; returns spf.json payload.

    ``fitted``: an existing spf.json payload; when given, its (b0, b1, k) are reused and no
    refit happens (the ingest Lambda has no statsmodels).
    """
    Y = CRASH_YEARS
    ok = [s for s in segs if s["aadt"] and s["fc_group"] and s["len_mi"] > 0]
    # crash rate + critical rate by functional-class group
    groups = defaultdict(list)
    for s in ok:
        s["_M"] = S.exposure_100mvmt(s["aadt"], s["len_mi"], Y)
        s["rate_100mvmt"] = round(s["crashes_total"] / s["_M"], 3)
        groups[s["fc_group"]].append(s)
    class_stats = {}
    for g, ss in groups.items():
        ra = sum(x["crashes_total"] for x in ss) / sum(x["_M"] for x in ss)
        class_stats[g] = {"segments": len(ss), "crashes": sum(x["crashes_total"] for x in ss), "mean_rate": round(ra, 4)}
        for x in ss:
            rc = S.critical_rate(ra, x["_M"]) if ra > 0 else None
            x["crit_rate"] = _r(rc, 3)
            x["crit_ratio"] = round(x["rate_100mvmt"] / rc, 3) if rc else None

    def arrays(ss):
        return (np.array([x["crashes_total"] for x in ss], float), np.array([x["aadt"] for x in ss], float),
                np.array([x["len_mi"] for x in ss], float))

    if fitted is not None:
        pooled = {k: fitted[k] for k in ("b0", "b1", "k", "se_b0", "se_b1", "n", "crashes", "aic", "loglik")}
        by_class = {g: {**v, **class_stats.get(g, {})} for g, v in fitted["by_class"].items()}
        for g in groups:
            by_class.setdefault(g, {**class_stats[g], "fitted": False, "reason": "not in stored SPF"})
    else:
        pooled = S.fit_nb(*arrays(ok), Y)
        by_class = {}
    for g, ss in (groups.items() if fitted is None else []):
        entry = dict(class_stats[g])
        n, *_ = arrays(ss)
        if len(ss) >= 40 and (n > 0).sum() >= 15:
            try:
                fit = S.fit_nb(*arrays(ss), Y)
                if fit["converged"] and fit["k"] > 0 and math.isfinite(fit["b1"]):
                    entry.update(fit, fitted=True)
            except Exception as e:  # numerical failure on sparse classes
                entry.update(fitted=False, reason=f"fit failed: {e}")
        entry.setdefault("fitted", False)
        entry.setdefault("reason", "too few segments/crashes; pooled SPF used")
        if entry["fitted"]:
            entry.pop("reason")
        by_class[g] = entry

    for s in segs:
        for k in ("rate_100mvmt", "crit_rate", "crit_ratio", "spf_pred", "eb_expected", "eb_excess", "rank"):
            s.setdefault(k, None)
        s["epdo"] = None  # no severity split at segment level (see module docstring)
    for s in ok:
        model = by_class[s["fc_group"]] if by_class[s["fc_group"]]["fitted"] else pooled
        mu_yr = S.predict(model, s["aadt"], s["len_mi"])
        e_yr = S.eb_expected(mu_yr * Y, s["crashes_total"], model["k"]) / Y
        s["spf_pred"], s["eb_expected"], s["eb_excess"] = round(mu_yr, 4), round(e_yr, 4), round(e_yr - mu_yr, 4)
        s["spf_class"] = s["fc_group"] if model is not pooled else "pooled"
    for i, s in enumerate(sorted(ok, key=lambda x: -x["eb_excess"]), 1):
        s["rank"] = i
    return {
        "form": "N=exp(b0)·AADT^b1·L", "units": "crashes per year; L in miles",
        "estimation": "NB2 maximum likelihood (statsmodels); offset ln L + ln Y; Y = 9",
        **{k: pooled[k] for k in ("b0", "b1", "k", "se_b0", "se_b1", "n", "crashes", "aic", "loglik")},
        "by_class": by_class,
        "points": [{"seg_id": s["seg_id"], "aadt": s["aadt"], "len_mi": s["len_mi"], "obs_per_yr": s["crashes_per_yr"],
                    "pred_per_yr": s["spf_pred"], "fc_group": s["fc_group"]} for s in ok],
    }


NETWORK_PROPS = ["seg_id", "route", "name", "f_system", "lanes", "speed_limit", "aadt", "truck_pct", "len_mi",
                 "crashes_total", "crash_years", "rate_100mvmt", "crit_rate", "crit_ratio", "epdo", "spf_pred",
                 "eb_expected", "eb_excess", "rank", "fc_group", "dfo_from", "dfo_to", "crashes_per_yr", "speed_all"]


def to_geojson(segs, tol_m=5.0):
    feats = []
    for s in segs:
        paths = simplify_paths(s["_paths"], tol_m)
        geom = ({"type": "LineString", "coordinates": paths[0]} if len(paths) == 1
                else {"type": "MultiLineString", "coordinates": paths})
        feats.append({"type": "Feature", "geometry": geom, "properties": {k: s.get(k) for k in NETWORK_PROPS}})
    return {"type": "FeatureCollection", "features": feats}


# ---------- corridors ----------
def build_corridors(segs, idx, step=0.25):
    by_route = defaultdict(list)
    for s in segs:
        by_route[s["route"]].append(s)
    defs = list(CORRIDORS)
    listed = {r for _, _, rs in defs for r in rs}
    # 82nd St is an off-system city street (Roadway Inventory RIA_RTE_ID 252663, no HWY) and has
    # no segments in Segment_Crash__Results, so it is substituted by the highest-crash route left.
    totals = {r: sum(x["crashes_per_yr"] for x in ss) for r, ss in by_route.items() if r not in listed}
    sub = max(totals, key=totals.get)
    defs.append((display_route(sub).lower().replace(" ", "-").replace(".", ""), display_route(sub), [sub]))
    note = (f"82nd St is off-system (city street; Roadway Inventory RIA_RTE_ID 252663) and absent from the "
            f"segment crash layer; substituted by {display_route(sub)}, the highest-crash remaining route "
            f"({totals[sub]:.2f} crashes/yr).")
    out = []
    for cid, name, routes in defs:
        stations, lons, lats, total_len = [], [], [], 0.0
        for route in routes:
            recs = idx["ri"].by_route.get(route, [])
            if not recs:
                continue
            lo, hi = min(r["frm"] for r in recs), max(r["to"] for r in recs)
            total_len += hi - lo
            d = math.ceil(lo / step) * step
            while d <= hi + 1e-9:
                rr = idx["ri"].at(route, d)
                if rr is not None:
                    ra, sp, aa = rr["a"], idx["speed"].at(route, d), idx["aadt"].at(route, d)
                    seg = next((x for x in by_route[route] if x["dfo_from"] is not None
                                and x["dfo_from"] <= d <= x["dfo_to"]), None)
                    ll = point_at(rr["ll"], (d - rr["frm"]) / (rr["to"] - rr["frm"]) * rr["len"]) if rr["ll"] and rr["to"] > rr["frm"] else None
                    if ll:
                        lons.append(ll[0]); lats.append(ll[1])
                    stations.append({
                        "route": route, "dfo": round(d, 3),
                        "lon": round(ll[0], 5) if ll else None, "lat": round(ll[1], 5) if ll else None,
                        "lanes": ra.get("NUM_LANES"), "speed_limit": ra.get("SPD_MAX"),
                        "aadt": (aa["a"].get("AADT_CUR") if aa else None) or ra.get("ADT_CUR"),
                        "truck_pct": ra.get("TRK_AADT_PCT"), "f_system": ra.get("F_SYSTEM"),
                        "speed_all": sp["a"].get("ALLSPEED") if sp else None,
                        "speed_am": sp["a"].get("AMALLSPEED") if sp else None,
                        "speed_md": sp["a"].get("MDALLSPEED") if sp else None,
                        "speed_pm": sp["a"].get("PMALLSPEED") if sp else None,
                        "crashes_per_mi": round(seg["crashes_per_yr"] / seg["len_mi"], 3) if seg else None,
                        "seg_id": seg["seg_id"] if seg else None,
                    })
                d = round(d + step, 6)
        cs = [x for r in routes for x in by_route.get(r, [])]
        vals = lambda k: [s[k] for s in stations if s[k] is not None]
        top = max((x for x in cs if x["eb_excess"] is not None), key=lambda x: x["eb_excess"], default=None)
        out.append({
            "id": cid, "name": name, "routes": routes, "len_mi": round(total_len, 2), "stations": stations,
            "summary": {
                "segments": len(cs), "crashes_per_yr": round(sum(x["crashes_per_yr"] for x in cs), 3),
                "crashes_total": sum(x["crashes_total"] for x in cs), "crash_years": CRASH_YEARS,
                "aadt_mean": round(float(np.mean(vals("aadt")))) if vals("aadt") else None,
                "aadt_max": max(vals("aadt")) if vals("aadt") else None,
                "speed_all_mean": round(float(np.mean(vals("speed_all"))), 1) if vals("speed_all") else None,
                "truck_pct_mean": round(float(np.mean(vals("truck_pct"))), 1) if vals("truck_pct") else None,
                "bbox": [round(min(lons), 5), round(min(lats), 5), round(max(lons), 5), round(max(lats), 5)] if lons else None,
                "top_segment": top["seg_id"] if top else None,
                "note": note if cid == defs[-1][0] else None,
            },
        })
    return out
