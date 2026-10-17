"""One-mile segment network: geometry, DFO calibration, attribute joins, screening metrics.

Crash data — what ``SUM_CRASH_`` is, and why it is NOT used as the crash count
(checked against the live services 2026-10-17; numbers recomputed on every build into
``spf.json → diagnostics.crash_field``):

* Metadata: the service item (6a850420e5b445bbbd8e8600beaaac4c, "Segment_Crash _Results",
  owner GREINING_TXDOT, created 2024-12-31) and its source item 80dc4d4a340c49dfb93e16492c11b018
  (owner khearing_fitp) have no description, snippet, tags, licence or field aliases; the layer
  description is empty and FGDC metadata holds only the title and extent. No years are stated
  anywhere. The layer's only published context is the web map "TxDOT SATP (SAFETY)"
  (315d7b978c78413fb2f1e2e32f8cc606) of the TxDOT *Statewide Active Transportation Plan*, where
  it sits beside "Active Transportation Crashes" and its popup shows only ``Crash_Rate`` labelled
  "Crash Rate (Per Mile)" (a class: No Crashes / Minimal / Low / Medium / High).
* Data: against the on-system pedestrian/cyclist/e-scooter crashes of the companion Active
  Transportation Crashes layer (CRIS, 2021–2023 — the only years it holds statewide), the
  per-segment ``SUM_CRASH_`` correlates at r ≈ 0.94; a least-squares fit of 9·SUM_CRASH_ on the
  matched KABCO counts gives ≈ 7–10 per K/A/B crash and < 1 per C/O crash. So SUM_CRASH_ is a
  *pedestrian/cyclist, injury-weighted* crash score for 2021–2023 (≈ 0.9 per KAB crash); its
  values come in ninths for an undocumented reason. It is neither an all-crash count nor a
  9-year annual mean (that reading would imply ~2× the ped/bike crashes the CRIS layer has), and
  "per mile per year" is not supported either (LEN_M ≈ 1, so per mile ≈ per segment, and the
  values track 3-year totals, not annual means).
* Therefore the screening outcome is the integer count of on-system active-transportation
  crashes (all KABCO severities) located on each segment: every on-system CRIS point of the
  layer lies ≤ 2 m from a segment polyline (snap tolerance ``AT_SNAP_M``) and off-system points
  are ≥ 2 m away and excluded; study period Y = the layer's crash years (2021–2023 → 3).
  SUM_CRASH_ is kept as ``satp_crash_score`` for reference only. This makes RoadScope's network
  screening a *pedestrian/cyclist* crash screening; all-severity all-mode CRIS counts are not
  published as an open feature service.
* No severity weights with a documented source are applied: EPDO is not computed (``epdo`` is
  null). K+A counts are reported as ``crashes_ka``.

AADT: ``AADT_CUR`` from TxDOT_AADT (GRID extract; ``EXT_DATE`` reported in
``diagnostics.aadt``). The service does not state the count year; the build compares it with the
Roadway Inventory 2024 ``ADT_CUR`` (whose ``ADT_YEAR`` is stated) and reports the agreement.

Linear referencing: ``START_M``/``END_M`` are measures on the segmented route part
(``US0084-KG_01`` starts at 0) — not TxDOT DFO. Segment end points are projected onto TxDOT_AADT
geometry of the same route (``US0084-KG_01`` → ``US0084-KG`` = AADT ``RTE_NM`` = inventory/speed
``RIA_RTE_ID``), whose BEGIN/END_DFO give true DFO; joins are then DFO-overlap, length-weighted.

Site types (HSM-style): rural/urban from Roadway Inventory ``RU`` (1 = rural; 2 = small urban,
4 = urbanized; RU = 1 exactly where UAN = 0, i.e. outside any urban area) × facility group from
``F_SYSTEM``. Divided = ``MED_TYPE`` ≠ 0 (all freeway segments are ≠ 0, all collectors = 0).
"""
from __future__ import annotations

import math
from collections import Counter, defaultdict
from itertools import combinations

import numpy as np

from . import spf as S
from .vru import severity

LAT0 = 33.6
KX = 111320.0 * math.cos(math.radians(LAT0))
KY = 110574.0
MAX_SNAP_M = 150.0
AT_SNAP_M = 5.0          # crash point → segment polyline tolerance
SITE_MIN_SEGMENTS = 30   # a site type gets its own SPF only with this many segments …
SITE_MIN_CRASHES = 20    # … and this many crashes; otherwise the pooled site-type model is used
EPV = 10                 # ≥ 10 crashes per estimated covariate (incl. ln AADT)
SITE_COVARIATES = ("lanes", "divided", "speed")

FC_GROUPS = {1: "Interstate/Freeway", 2: "Interstate/Freeway", 3: "Principal arterial",
             4: "Minor arterial", 5: "Collector/Local", 6: "Collector/Local", 7: "Collector/Local"}
FC_ORDER = ["Interstate/Freeway", "Principal arterial", "Minor arterial", "Collector/Local"]

CORRIDORS = [
    ("us-84", "US 84 (Slaton Hwy / Clovis Rd)", ["US0084-KG"]),
    ("us-62-82", "US 62/82 (19th St / Marsha Sharp Fwy)", ["US0062-KG", "US0082-KG"]),
    ("loop-289", "Loop 289", ["SL0289-KG"]),
    ("i-27", "I-27", ["IH0027-KG"]),
    ("sh-114", "SH 114", ["SH0114-KG"]),
    ("fm-2255", "FM 2255", ["FM2255-KG"]),
]


def site_type(urban, fc_group):
    if urban is None or fc_group is None:
        return None
    return f"{'Urban' if urban else 'Rural'} {fc_group.lower()}"


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


# ---------- crash points → segments ----------
def crash_period(at_feats):
    ys = sorted({f["attributes"].get("Crash_Year") for f in at_feats if f["attributes"].get("Crash_Year")})
    return (ys[0], ys[-1]) if ys else (None, None)


def assign_crashes(lines, at_feats, tol=AT_SNAP_M):
    """Assign each on-system crash point to the nearest segment polyline within ``tol`` metres.

    Returns (per-segment list of KABCO letters, assignment counts, nearest distances of matches).
    """
    boxes = [(min(x for x, _ in l) - tol, min(y for _, y in l) - tol, max(x for x, _ in l) + tol,
              max(y for _, y in l) + tol) for l in lines]
    per = [[] for _ in lines]
    stats = Counter()
    for f in at_feats:
        a, g = f["attributes"], f.get("geometry")
        if a.get("On_System_") != "Yes":
            stats["off_system_excluded"] += 1
            continue
        if not g or g.get("x") is None:
            stats["on_system_no_geometry"] += 1
            continue
        p = to_xy((g["x"], g["y"]))
        best, bi = math.inf, None
        for i, (l, b) in enumerate(zip(lines, boxes)):
            if b[0] <= p[0] <= b[2] and b[1] <= p[1] <= b[3]:
                d = project(p, l)[0]
                if d < best:
                    best, bi = d, i
        if bi is not None and best <= tol:
            per[bi].append(severity(a.get("Crash_Seve")))
            stats["on_system_matched"] += 1
        else:
            stats["on_system_unmatched"] += 1
    return per, dict(stats)


# ---------- build ----------
def build_segments(seg_feats, aadt_feats, ri_feats, speed_feats, at_feats):
    aadt = RouteIndex(aadt_feats, "RTE_NM", "BEGIN_DFO", "END_DFO")
    ri = RouteIndex(ri_feats, "RIA_RTE_ID", "FRM_DFO", "TO_DFO")
    spd = RouteIndex(speed_feats, "RIA_RTE_ID", "FRM_DFO", "TO_DFO")
    y0, y1 = crash_period(at_feats)
    years = (y1 - y0 + 1) if y0 else None
    lines = [line_xy(f["geometry"]["paths"]) for f in seg_feats]
    sev, assign_stats = assign_crashes(lines, at_feats)
    segs = []
    for f, sv in zip(seg_feats, sev):
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
        f_sys = dominant(ov_r, "F_SYSTEM")
        fc = FC_GROUPS.get(f_sys)
        aadt_v = wmean(ov_a, "AADT_CUR") or wmean(ov_r, "ADT_CUR")
        lanes = wmean(ov_r, "NUM_LANES")
        ru = dominant(ov_r, "RU")
        med = dominant(ov_r, "MED_TYPE")
        urban = None if ru is None else ru != 1
        n = len(sv)
        segs.append({
            "seg_id": a["SEG_ID"], "route": key, "route_part": a["RouteID"],
            "name": dominant(ov_r, "STE_NAM") or display_route(key),
            "f_system": f_sys, "fc_group": fc, "ru": ru, "urban": urban,
            "divided": None if med is None else med != 0,
            "site_type": site_type(urban, fc),
            "lanes": round(lanes) if lanes else None,
            "speed_limit": dominant(ov_r, "SPD_MAX"),
            "aadt": round(aadt_v) if aadt_v else None,
            "aadt_source": "TxDOT_AADT.AADT_CUR" if wmean(ov_a, "AADT_CUR") else ("RI.ADT_CUR" if aadt_v else None),
            "truck_pct": _r(wmean(ov_r, "TRK_AADT_PCT"), 1),
            "speed_all": _r(wmean(ov_s, "ALLSPEED"), 1),
            "dfo_from": _r(d0, 3), "dfo_to": _r(d1, 3),
            "len_mi": round(float(a["LEN_M"]), 4),
            "crashes_total": n, "crashes_ka": sum(s in ("K", "A") for s in sv),
            "crashes_per_yr": round(n / years, 2) if years else None,
            "crash_years": years, "crash_period": f"{y0}-{y1}" if y0 else None,
            "satp_crash_score": a.get("SUM_CRASH_"),
            "_sev": sv, "_paths": paths,
        })
    idx = {"aadt": aadt, "ri": ri, "speed": spd}
    meta = {"crash_period": [y0, y1], "crash_years": years, "assignment": assign_stats,
            "join": join_quality(segs, idx, assign_stats), "crash_field": crash_field_evidence(segs),
            "aadt": aadt_check(aadt_feats, ri)}
    return segs, idx, meta


def _r(v, nd):
    return None if v is None else round(v, nd)


# ---------- data-quality diagnostics (numpy only) ----------
def join_quality(segs, idx, assign_stats):
    groups = defaultdict(list)
    for s in segs:
        groups[s["fc_group"] or "Unclassified (no inventory match)"].append(s)
    pct = lambda xs, f: round(100.0 * sum(1 for x in xs if f(x)) / len(xs), 1) if xs else None
    by = {}
    for g in FC_ORDER + ["Unclassified (no inventory match)"]:
        ss = groups.get(g, [])
        if not ss:
            continue
        by[g] = {"segments": len(ss),
                 "pct_dfo_matched": pct(ss, lambda x: x["dfo_from"] is not None),
                 "pct_inventory_matched": pct(ss, lambda x: x["f_system"] is not None),
                 "pct_aadt_matched": pct(ss, lambda x: x["aadt"] is not None),
                 "pct_aadt_from_txdot_aadt": pct(ss, lambda x: x["aadt_source"] == "TxDOT_AADT.AADT_CUR"),
                 "pct_segments_with_crash": pct(ss, lambda x: x["crashes_total"] > 0),
                 "crashes_matched": sum(x["crashes_total"] for x in ss),
                 "rural_segments": sum(1 for x in ss if x["urban"] is False)}
    unclassified = defaultdict(lambda: {"segments": 0, "reason": None})
    for s in groups.get("Unclassified (no inventory match)", []):
        r = s["route"]
        in_ri, in_aadt = r in idx["ri"].by_route, r in idx["aadt"].by_route
        reason = ("route absent from Roadway Inventory (CO=152, Lubbock County) and TxDOT_AADT (envelope)"
                  if not in_ri and not in_aadt else
                  "segment end points > 150 m from the route's inventory/AADT geometry" if s["dfo_from"] is None else
                  "DFO range outside the route's Lubbock County inventory records")
        unclassified[r]["segments"] += 1
        unclassified[r]["reason"] = reason
    on = assign_stats.get("on_system_matched", 0) + assign_stats.get("on_system_unmatched", 0)
    return {
        "by_facility_group": by,
        "unclassified_routes": dict(unclassified),
        "crash_points": {**assign_stats, "snap_tolerance_m": AT_SNAP_M,
                         "pct_on_system_matched": round(100.0 * assign_stats.get("on_system_matched", 0) / on, 1) if on else None},
        "note": _collector_note(by.get("Collector/Local")),
    }


def _collector_note(c):
    base = ("Crashes are CRIS points snapped to segment polylines, so crash matching does not depend on DFO or "
            "route-name joins (route keys US0084-KG_01 -> US0084-KG match RTE_NM/RIA_RTE_ID exactly).")
    if not c:
        return base
    return (base + f" Collector/Local: {c['segments']} segments, {c['rural_segments']} rural; DFO {c['pct_dfo_matched']}%, "
            f"inventory {c['pct_inventory_matched']}%, AADT {c['pct_aadt_matched']}% matched; {c['crashes_matched']} crashes. "
            "The low count is the real pedestrian/cyclist crash frequency of (mostly rural FM) collectors, not a join "
            "failure; the earlier '18 crashes' was round(9*SUM_CRASH_) of the same ped/bike score.")


def crash_field_evidence(segs):
    """Quantify what SUM_CRASH_ measures, against the matched CRIS active-transportation crashes."""
    S9 = np.array([9.0 * float(s["satp_crash_score"] or 0) for s in segs])
    N = np.array([s["crashes_total"] for s in segs], float)
    sev = np.array([[sum(v == c for v in s["_sev"]) for c in "KABCO"] for s in segs], float)
    w, *_ = np.linalg.lstsq(sev, S9, rcond=None)
    res = S9 - sev @ w
    r2 = 1 - float(res @ res) / float(((S9 - S9.mean()) ** 2).sum()) if S9.std() > 0 else None
    ninths = np.abs(S9 - np.round(S9)) < 0.02
    return {
        "field": "SUM_CRASH_",
        "conclusion": ("Pedestrian/cyclist injury-weighted crash score for 2021-2023 (≈0.9 per K/A/B crash, "
                       "≈0 per C/O crash); not an all-crash count, not a 9-year annual mean, not crashes per "
                       "mile per year. Not used as the SPF outcome; kept as satp_crash_score."),
        "evidence": {
            "item_metadata": ("Items 6a850420e5b445bbbd8e8600beaaac4c (GREINING_TXDOT, created 2024-12-31) and source "
                              "80dc4d4a340c49dfb93e16492c11b018 (khearing_fitp): empty description, snippet, tags, "
                              "licence; field aliases equal field names; FGDC metadata has title and extent only; "
                              "no years stated (checked 2026-10-17)."),
            "web_map": ("Published only in web map 'TxDOT SATP (SAFETY)' (315d7b978c78413fb2f1e2e32f8cc606), "
                        "Statewide Active Transportation Plan, beside 'Active Transportation Crashes'; popup shows "
                        "Crash_Rate labelled 'Crash Rate (Per Mile)'."),
            "active_transportation_layer_years": "2021-2023 (statewide min/max Crash_Year)",
            "corr_with_matched_crashes": round(float(np.corrcoef(S9, N)[0, 1]), 3) if N.std() > 0 else None,
            "sum_crash_total": round(float(S9.sum() / 9), 2), "matched_crashes_total": int(N.sum()),
            "matched_kab_total": int(sev[:, :3].sum()),
            "lstsq_weight_of_9xSUM_per_crash": {c: round(float(v), 2) for c, v in zip("KABCO", w)},
            "lstsq_r2": round(r2, 3) if r2 is not None else None,
            "pct_values_multiple_of_one_ninth": round(100.0 * ninths.mean(), 1),
            "len_m_equals_1_pct": round(100.0 * np.mean([abs(s["len_mi"] - 1) < 0.05 for s in segs]), 1),
        },
    }


def aadt_check(aadt_feats, ri):
    ext = Counter(f["attributes"].get("EXT_DATE") for f in aadt_feats)
    aidx = RouteIndex(aadt_feats, "RTE_NM", "BEGIN_DFO", "END_DFO")
    on_sys = ("IH", "US", "SH", "FM", "SL", "SS", "BU")
    years, eq, tot, ratios = Counter(), 0, 0, []
    for recs in ri.by_route.values():
        for r in recs:
            a = r["a"]
            if a.get("HSYS") not in on_sys:
                continue
            years[a.get("ADT_YEAR")] += 1
            m = aidx.at(a["RIA_RTE_ID"], (a["FRM_DFO"] + a["TO_DFO"]) / 2)
            if m and m["a"].get("AADT_CUR") and a.get("ADT_CUR"):
                tot += 1
                eq += m["a"]["AADT_CUR"] == a["ADT_CUR"]
                ratios.append(m["a"]["AADT_CUR"] / a["ADT_CUR"])
    return {
        "field": "TxDOT_AADT.AADT_CUR (fallback Roadway_Inventory_2024.ADT_CUR where no AADT record overlaps)",
        "ext_date": dict(ext),
        "count_year": ("not published by the service; AADT_CUR differs from the Roadway Inventory 2024 ADT_CUR "
                       "(ADT_YEAR stated) on most on-system records, so it is a different (presumably later) count "
                       "year than 2024; crash period 2021-2023 therefore uses a post-period AADT."),
        "ri_adt_year_on_system": {str(k): v for k, v in sorted(years.items(), key=lambda kv: str(kv[0]))},
        "pct_equal_to_ri_2024_adt": round(100.0 * eq / tot, 1) if tot else None,
        "median_ratio_aadt_cur_to_ri_adt": round(float(np.median(ratios)), 4) if ratios else None,
        "compared_records": tot,
    }


# ---------- screening ----------
def _arrays(ss, names, Y):
    rows = [S.covariate_row(s, names) for s in ss]
    return (np.array([s["crashes_total"] for s in ss], float), np.array(rows, float).reshape(len(ss), len(names)),
            np.array([s["len_mi"] for s in ss], float))


def _fit(ss, names, Y):
    y, X, L = _arrays(ss, names, Y)
    return {"spec": list(names), **S.fit_nb(y, X, names, L, Y)}


def _select(ss, candidates, Y):
    fits = []
    for spec in candidates:
        if any(S.covariate_row(s, spec) is None for s in ss):
            continue
        try:
            f = _fit(ss, spec, Y)
            if f["converged"] and all(math.isfinite(v) for v in f["coef"].values()):
                fits.append(f)
        except Exception:  # numerical failure on a sparse spec
            continue
    if not fits:
        return None, []
    best = min(fits, key=lambda f: f["aic"])
    return best, [{"spec": f["spec"], "aic": round(f["aic"], 2), "k": round(f["k"], 4)} for f in fits]


def _site_candidates(ss):
    varying = [c for c in SITE_COVARIATES if len({S.COVARIATES[c](s) for s in ss}) > 1]
    max_extra = min(2, sum(s["crashes_total"] for s in ss) // EPV - 1)
    specs = [["ln_aadt"]]
    for m in range(1, max(max_extra, 0) + 1):
        specs += [["ln_aadt", *c] for c in combinations(varying, m)]
    return specs


def _overdispersion_diagnosis(ok, Y):
    """Why the old pooled k was 7.2: refit the old outcome and the corrected ones."""
    out = {}
    L = np.array([s["len_mi"] for s in ok], float)
    lnA = np.log([s["aadt"] for s in ok])[:, None]
    old = np.array([round(9 * float(s["satp_crash_score"] or 0)) for s in ok], float)
    N = np.array([s["crashes_total"] for s in ok], float)
    urb = np.array([float(s["urban"]) for s in ok])[:, None]
    for key, y, yrs, X, nm in [
        ("old_round_9x_sum_crash_9yr", old, 9, lnA, ["ln_aadt"]),
        ("cris_count_times_9", 9 * N, Y, lnA, ["ln_aadt"]),
        ("cris_count_pooled", N, Y, lnA, ["ln_aadt"]),
        ("cris_count_pooled_plus_urban", N, Y, np.hstack([lnA, urb]), ["ln_aadt", "urban"]),
    ]:
        f = S.fit_nb(y, X, nm, L, yrs)
        out[key] = {"k": round(f["k"], 3), "aic": round(f["aic"], 1), "coef": {c: round(v, 3) for c, v in f["coef"].items()}}
    out["explanation"] = (
        "The old outcome round(9·SUM_CRASH_) is (i) a ×9-scaled, injury-weighted ped/bike score, not a count — "
        "scaling a Poisson count by c multiplies its variance/mean ratio by c, which NB absorbs as spurious "
        "overdispersion (compare cris_count_times_9 with cris_count_pooled) — and (ii) a ped/bike outcome whose "
        "exposure is urban activity, not AADT: pooling rural FM roads (≈0 crashes at any AADT) with urban "
        "arterials leaves large unexplained heterogeneity (compare _plus_urban). Site-type SPFs remove (ii).")
    out["zero_share"] = round(float(np.mean(N == 0)), 3)
    return out


def screen(segs, fitted=None):
    """Rates, critical rates, site-type SPFs + EB. Mutates segs; returns the spf.json payload.

    ``fitted``: an existing spf.json payload; when given, its stored models are applied and nothing
    is refit (the ingest Lambda has no scipy/statsmodels). Goodness-of-fit and CURE are recomputed.
    """
    Y = next((s["crash_years"] for s in segs if s.get("crash_years")), None)
    ok = [s for s in segs if s["aadt"] and s["site_type"] and s["len_mi"] > 0]
    for s in ok:
        s["_M"] = S.exposure_100mvmt(s["aadt"], s["len_mi"], Y)
        s["_rate"] = s["crashes_total"] / s["_M"]

    def stats(ss):
        n, m = sum(x["crashes_total"] for x in ss), sum(x["_M"] for x in ss)
        return {"segments": len(ss), "crashes": n, "mean_rate": round(n / m, 1)}

    by_fc, by_site = defaultdict(list), defaultdict(list)
    for s in ok:
        by_fc[s["fc_group"]].append(s)
        by_site[s["site_type"]].append(s)
    # critical rate: reference population = site type
    for t, ss in by_site.items():
        ra = sum(x["crashes_total"] for x in ss) / sum(x["_M"] for x in ss)
        for x in ss:
            rc = S.critical_rate(ra, x["_M"])
            x["_crit"], x["_ratio"] = rc, x["_rate"] / rc

    site_order = [site_type(u, g) for u in (True, False) for g in FC_ORDER]
    site_names = [t for t in site_order if t in by_site]
    if fitted is None:
        p = _fit(ok, ["ln_aadt"], Y)
        pooled = {"b0": p["coef"]["const"], "b1": p["coef"]["ln_aadt"], "k": p["k"], "se_b0": p["se"]["const"],
                  "se_b1": p["se"]["ln_aadt"], "n": p["n"], "crashes": p["crashes"], "aic": p["aic"], "loglik": p["loglik"]}
        fallback, fb_cands = _select(ok, [["ln_aadt"], ["ln_aadt", "urban"], ["ln_aadt", "urban", "lanes"],
                                           ["ln_aadt", "urban", "speed"], ["ln_aadt", "urban", "lanes", "speed"]], Y)
        fallback["candidates"] = fb_cands
        models, cands = {}, {}
        for t in site_names:
            ss = by_site[t]
            n_cr = sum(x["crashes_total"] for x in ss)
            complete = all(S.covariate_row(x, SITE_COVARIATES) is not None for x in ss)
            if len(ss) >= SITE_MIN_SEGMENTS and n_cr >= SITE_MIN_CRASHES and complete:
                m, c = _select(ss, _site_candidates(ss), Y)
                if m is not None:
                    models[t], cands[t] = m, c
        overdisp = _overdispersion_diagnosis(ok, Y)
    else:
        if "site_types" not in fitted or "fallback" not in fitted:
            raise ValueError("stored spf.json predates site-type SPFs; run build_network on the batch worker first")
        pooled = {k: fitted[k] for k in ("b0", "b1", "k", "se_b0", "se_b1", "n", "crashes", "aic", "loglik")}
        fallback = fitted["fallback"]
        models = {t: v["model"] for t, v in fitted["site_types"].items() if v.get("model")}
        cands = {t: v.get("candidates", []) for t, v in fitted["site_types"].items()}
        overdisp = (fitted.get("diagnostics") or {}).get("overdispersion")
    pooled_model = {"coef": {"const": pooled["b0"], "ln_aadt": pooled["b1"]}, "k": pooled["k"],
                    "k_convention": "per mile (k_seg = k/L)", "n_params": 3}

    def kseg(model, s):
        return S.k_segment(model["k"], s["len_mi"]) if model.get("k_convention", "").startswith("per mile") else model["k"]

    def apply(model, s):
        mu = S.predict_seg(model, s)
        return None if mu is None else (mu, kseg(model, s))

    for s in segs:
        for k in ("rate_100mvmt", "crit_rate", "crit_ratio", "spf_pred", "eb_expected", "eb_excess", "rank", "spf_model"):
            s.setdefault(k, None)
        s["epdo"] = None  # no documented severity weights (see module docstring)
    for s in ok:
        model, used = (models[s["site_type"]], s["site_type"]) if s["site_type"] in models else (fallback, "fallback")
        r = apply(model, s)
        if r is None:  # missing covariate for the site model
            model, used, r = fallback, "fallback", apply(fallback, s)
        mu_yr, ks = r
        e = S.eb_expected(mu_yr * Y, s["crashes_total"], ks) / Y
        s["_mu"], s["_eb"], s["_k"], s["_w"], s["_p"] = mu_yr, e, ks, 1 / (1 + ks * mu_yr * Y), model["n_params"]
        s["spf_model"] = used
        s["rate_100mvmt"], s["crit_rate"], s["crit_ratio"] = round(s["_rate"], 1), round(s["_crit"], 1), round(s["_ratio"], 2)
        s["spf_pred"], s["eb_expected"], s["eb_excess"] = round(mu_yr, 2), round(e, 2), round(e - mu_yr, 2)
    for i, s in enumerate(sorted(ok, key=lambda x: (-(x["_eb"] - x["_mu"]), -x["_ratio"])), 1):
        s["rank"] = i

    def gof_block(ss, n_params):
        y = [x["crashes_total"] for x in ss]
        mu = [x["_mu"] * Y for x in ss]
        return ({k: (round(v, 4) if isinstance(v, float) else v) for k, v in S.gof(y, mu, [x["_k"] for x in ss], n_params).items()},
                S.cure([x["aadt"] for x in ss], y, mu))

    site_out = {}
    for t in site_names:
        ss = by_site[t]
        own = t in models
        g, c = gof_block(ss, models[t]["n_params"] if own else fallback["n_params"])
        entry = {**stats(ss), "fitted": own, "model_used": t if own else "fallback",
                 "model": _round_model(models[t]) if own else None,
                 "candidates": cands.get(t, []) if own else [],
                 "gof": g, "cure": c,
                 "eb_weight_median": round(float(np.median([x["_w"] for x in ss])), 3)}
        if not own:
            entry["reason"] = (f"{len(ss)} segments / {entry['crashes']} crashes < {SITE_MIN_SEGMENTS} / {SITE_MIN_CRASHES}: "
                               "pooled site-type model (fallback) applied")
            entry["gof_note"] = ("GOF and CURE of the fallback model on this subset; with so few crashes they are not "
                                 "informative (a CURE drifting outside ±2σ* here reflects all-negative residuals).")
        site_out[t] = entry
    # pooled ln-AADT-only model diagnostics, for comparison with the site-type system
    for s in ok:
        s["_mu_pool"] = S.predict(pooled_model, s["aadt"], s["len_mi"])
    yp = [s["crashes_total"] for s in ok]
    mup = [s["_mu_pool"] * Y for s in ok]
    pooled_gof = {k: (round(v, 4) if isinstance(v, float) else v)
                  for k, v in S.gof(yp, mup, [S.k_segment(pooled["k"], s["len_mi"]) for s in ok], 3).items()}
    sys_g, sys_c = gof_block(ok, max(m["n_params"] for m in [fallback, *models.values()]))
    return {
        "form": "N=exp(b0)·AADT^b1·L", "units": "crashes per year; L in miles",
        "outcome": ("on-system pedestrian/cyclist/e-scooter crashes, all KABCO severities (TxDOT CRIS via the "
                    "Active Transportation Crashes layer), snapped to segments"),
        "crash_period": next((s["crash_period"] for s in segs if s.get("crash_period")), None), "crash_years": Y,
        "estimation": (f"NB2 maximum likelihood (scipy L-BFGS-B, SE from numerical Hessian); offset ln L + ln Y, Y = {Y}; "
                       "overdispersion per mile, applied as k_seg = k/L (HSM Part C segment convention); "
                       f"site-type specs selected by AIC (≤ 1 covariate per {EPV} crashes)"),
        "eb": "E = w·μ_Y + (1−w)·N, w = 1/(1 + (k/L)·μ_Y), μ_Y = SPF crashes over the Y-year period",
        "epdo": None,
        **{k: pooled[k] for k in ("b0", "b1", "k", "se_b0", "se_b1", "n", "crashes", "aic", "loglik")},
        "pooled_gof": {**pooled_gof, "cure": S.cure([s["aadt"] for s in ok], yp, mup)},
        "by_class": {g: {**stats(by_fc[g]), "fitted": False, "reason": "superseded by site_types"} for g in FC_ORDER if g in by_fc},
        "site_types": site_out,
        "fallback": _round_model(fallback) | {"candidates": fallback.get("candidates", [])},
        "system_gof": {**sys_g, "cure": sys_c},
        "points": [{"seg_id": s["seg_id"], "aadt": s["aadt"], "len_mi": s["len_mi"], "obs_per_yr": s["crashes_per_yr"],
                    "pred_per_yr": s["spf_pred"], "fc_group": s["fc_group"], "site_type": s["site_type"]} for s in ok],
        "diagnostics": {"overdispersion": overdisp},
    }


def _round_model(m):
    out = {k: v for k, v in m.items() if k != "candidates"}
    for k in ("aic", "loglik"):
        if isinstance(out.get(k), float):
            out[k] = round(out[k], 3)
    return out


NETWORK_PROPS = ["seg_id", "route", "name", "f_system", "lanes", "speed_limit", "aadt", "truck_pct", "len_mi",
                 "crashes_total", "crash_years", "rate_100mvmt", "crit_rate", "crit_ratio", "epdo", "spf_pred",
                 "eb_expected", "eb_excess", "rank", "fc_group", "dfo_from", "dfo_to", "crashes_per_yr", "speed_all",
                 "site_type", "urban", "divided", "spf_model", "crashes_ka", "crash_period", "satp_crash_score",
                 "aadt_source"]


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
    years = next((s["crash_years"] for s in segs if s.get("crash_years")), None)
    totals = {r: sum(x["crashes_per_yr"] or 0 for x in ss) for r, ss in by_route.items() if r not in listed}
    sub = max(totals, key=totals.get)
    defs.append((display_route(sub).lower().replace(" ", "-").replace(".", ""), display_route(sub), [sub]))
    note = (f"82nd St is off-system (city street; Roadway Inventory RIA_RTE_ID 252663) and absent from the "
            f"segment crash layer; substituted by {display_route(sub)}, the highest-crash remaining route "
            f"({totals[sub]:.2f} ped/bike crashes/yr).")
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
                        "crashes_per_mi": round(seg["crashes_per_yr"] / seg["len_mi"], 2) if seg and seg["crashes_per_yr"] is not None else None,
                        "seg_id": seg["seg_id"] if seg else None,
                    })
                d = round(d + step, 6)
        cs = [x for r in routes for x in by_route.get(r, [])]
        vals = lambda k: [s[k] for s in stations if s[k] is not None]
        top = max((x for x in cs if x["eb_excess"] is not None), key=lambda x: x["eb_excess"], default=None)
        out.append({
            "id": cid, "name": name, "routes": routes, "len_mi": round(total_len, 2), "stations": stations,
            "summary": {
                "segments": len(cs), "crashes_per_yr": round(sum(x["crashes_per_yr"] or 0 for x in cs), 2),
                "crashes_total": sum(x["crashes_total"] for x in cs), "crash_years": years,
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
