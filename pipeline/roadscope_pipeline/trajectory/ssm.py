"""Surrogate safety measures on 10 Hz trajectories.

Detection follows the FHWA SSAM defaults (TTC <= 1.5 s, PET <= 5.0 s). TTC/DRAC are computed for
car-following and lane-change pairs; PET for crossing movements from vehicle bounding boxes
(length/width, heading from velocity) over the intersection of the two swept footprints.
DRAC >= 3.4 m/s^2 is reported as a separate flag, not a detection criterion.

Track dict keys used: id, len_m, w_m (optional, default 1.8), t, x, y (front-bumper centre),
v, vx/vy (optional), lane, dir, move, inside (bool array; for PET)."""
from __future__ import annotations

from collections import defaultdict

import numpy as np

HZ = 10
DT = 1.0 / HZ
TTC_MAX = 1.5      # s       SSAM default maximum TTC
PET_MAX = 5.0      # s       SSAM default maximum PET
DRAC_FLAG = 3.4    # m/s^2   AASHTO stopping-sight-distance deceleration (11.2 ft/s^2)
TTC_GRID = (1.0, 1.5, 2.0, 3.0)
PET_GRID = (1.0, 2.0, 3.0, 5.0)
TTC_BINS = ((0.5, "critical"), (1.0, "serious"), (1.5, "moderate"))
PET_BINS = ((1.0, "critical"), (2.5, "serious"), (5.0, "moderate"))
CELL = 0.5         # m   raster for swept footprints
UPSAMPLE = 5       # 10 Hz -> 50 Hz for footprint entry/exit timing (0.02 s)
MIN_ANGLE = 30.0   # deg below this the streams merge/diverge (rear-end-like), not crossing
DEFAULT_W = 1.8
MIN_FRAMES = 3     # an event must persist >= 0.3 s to reject residual jitter
MIN_GAP = 1.0      # m   spacing below this at 10 Hz is an NGSIM overlap artefact, not a gap
MIN_SPEED = 2.0    # m/s follower speed; excludes creeping inside standing queues
OPPOSITE = {"NB": "SB", "SB": "NB", "EB": "WB", "WB": "EB"}
DIR_HEADING = {"EB": 0.0, "NB": np.pi / 2, "WB": np.pi, "SB": -np.pi / 2}

CITATIONS = {
    "ssam": "Gettman, D., Pu, L., Sayed, T., Shelby, S. (2008). Surrogate Safety Assessment Model and "
            "Validation: Final Report. FHWA-HRT-08-051; SSAM User Manual FHWA-HRT-08-050. "
            "Federal Highway Administration.",
    "aashto": "AASHTO (2018) A Policy on Geometric Design of Highways and Streets, 7th ed.",
    "pet": "Allen, B. L., Shin, B. T., Cooper, P. J. (1978). Analysis of traffic conflicts and collisions. "
           "Transportation Research Record 667, 67-74.",
    "ngsim_accuracy": "Punzo, V., Borzacchiello, M. T., Ciuffo, B. (2011). On the assessment of vehicle "
                      "trajectory data accuracy and application to the Next Generation SIMulation (NGSIM) "
                      "program data. Transportation Research Part C 19(6), 1243-1262.",
}

RULES = {
    "detection": {
        "ttc_max_s": TTC_MAX, "pet_max_s": PET_MAX,
        "rule": "rear_end / lane_change: event while TTC <= 1.5 s for >= 0.3 s; "
                "crossing: PET <= 5.0 s over the shared swept-footprint zone",
        "citation": "FHWA SSAM default (Gettman et al. 2008, FHWA-HRT-08-051; SSAM User Manual FHWA-HRT-08-050)",
    },
    "severity_ttc": {
        "bins": [[0.0, 0.5, "critical"], [0.5, 1.0, "serious"], [1.0, 1.5, "moderate"]],
        "rule": "TTC_min <= 0.5 s critical; 0.5 < TTC_min <= 1.0 s serious; 1.0 < TTC_min <= 1.5 s moderate",
        "note": "study-specific bins within the SSAM TTC <= 1.5 s detection range",
    },
    "severity_pet": {
        "bins": [[0.0, 1.0, "critical"], [1.0, 2.5, "serious"], [2.5, 5.0, "moderate"]],
        "rule": "PET <= 1 s critical; 1 < PET <= 2.5 s serious; 2.5 < PET <= 5 s moderate",
        "note": "study-specific bins (no FHWA/SSAM standard for PET severity)",
    },
    "drac": {
        "threshold_mps2": DRAC_FLAG,
        "rule": "drac_flag = DRAC_max >= 3.4 m/s^2 (11.2 ft/s^2); reported alongside TTC events, not a detection criterion",
        "citation": "AASHTO (2018) A Policy on Geometric Design of Highways and Streets, 7th ed.",
    },
    "ttc": {"rule": "TTC = gap / (v_f - v_l) when v_f > v_l; gap = front-to-rear spacing (m); "
                    "follower speed >= 2 m/s, gap >= 1 m, closing rate consistent with spacing change"},
    "pet": {
        "rule": "footprint = length x width rectangle behind the front-bumper point, heading from velocity; "
                "conflict zone = intersection of the two swept footprints (0.5 m raster, 50 Hz); "
                "PET = t(second vehicle front enters zone) - t(first vehicle rear leaves zone); "
                "crossing only for conflicting approaches with conflict angle >= 30 deg",
        "citation": "Allen et al. (1978) TRR 667; FHWA SSAM (Gettman et al. 2008)",
    },
    "overlap": {
        "rule": "both footprints inside the shared zone at the same time -> recorded with pet = 0 and overlap = true",
        "note": "a physical overlap at NGSIM position accuracy is most likely a data error "
                "(Punzo et al. 2011), not an observed near-collision",
    },
    "citations": list(CITATIONS.values()),
}


def ttc_drac(gap: np.ndarray, v_f: np.ndarray, v_l: np.ndarray, min_gap: float = 0.0,
             min_speed: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    """gap = bumper-to-bumper spacing (m). TTC = gap/(v_f-v_l), DRAC = (v_f-v_l)^2/(2 gap) when closing."""
    gap, v_f, v_l = (np.asarray(q, float) for q in (gap, v_f, v_l))
    dv = v_f - v_l
    ok = (dv > 0) & (gap > max(min_gap, 0.0)) & (v_f >= min_speed)
    ttc = np.full(gap.shape, np.inf)
    drac = np.zeros(gap.shape)
    ttc[ok] = gap[ok] / dv[ok]
    drac[ok] = dv[ok] ** 2 / (2 * gap[ok])
    return ttc, drac


def _bin(value: float, bins) -> str | None:
    for hi, label in bins:
        if value <= hi + 1e-9:
            return label
    return None


def severity_ttc(ttc: float) -> str | None:
    return _bin(ttc, TTC_BINS)


def severity_pet(pet: float) -> str | None:
    return _bin(pet, PET_BINS)


def heading(tr, vmin: float = 1.0) -> np.ndarray:
    """Per-frame heading (rad) from velocity; held from the last frame moving >= vmin m/s
    (back-filled at the start; approach direction if the vehicle never moves)."""
    x, y = np.asarray(tr["x"], float), np.asarray(tr["y"], float)
    n = len(x)
    if "vx" in tr and tr["vx"] is not None:
        vx, vy = np.asarray(tr["vx"], float), np.asarray(tr["vy"], float)
    else:
        vx, vy = (np.gradient(x, DT), np.gradient(y, DT)) if n > 1 else (np.zeros(n), np.zeros(n))
    ok = np.hypot(vx, vy) >= vmin
    if not ok.any():
        return np.full(n, DIR_HEADING.get(tr.get("dir"), 0.0))
    th = np.arctan2(vy, vx)
    idx = np.maximum.accumulate(np.where(ok, np.arange(n), -1))
    idx[idx < 0] = np.flatnonzero(ok)[0]
    return th[idx]


def _frames(tr) -> np.ndarray:
    return np.round(np.asarray(tr["t"]) * HZ).astype(int)


def _index(tracks):
    return {tr["id"]: (_frames(tr)[0], tr) for tr in tracks}


def _at(entry, k):
    k0, tr = entry
    i = k - k0
    return i if 0 <= i < len(tr["t"]) else None


def _runs(mask: np.ndarray):
    if not mask.any():
        return []
    e = np.flatnonzero(np.diff(np.r_[0, mask.astype(int), 0]))
    return [(a, b) for a, b in zip(e[::2], e[1::2]) if b - a >= MIN_FRAMES]


def _pair_series(f, l, ks):
    """gap, v_f, v_l, along-track sign for frames ks where both exist."""
    i_f = ks - _frames(f)[0]
    i_l = ks - _frames(l)[0]
    dx = l["x"][i_l] - f["x"][i_f]
    dy = l["y"][i_l] - f["y"][i_f]
    hx = np.gradient(f["x"])[i_f]
    hy = np.gradient(f["y"])[i_f]
    along = (dx * hx + dy * hy) / np.maximum(np.hypot(hx, hy), 1e-6)
    # NGSIM local_x/local_y is the front-bumper centre: spacing minus leader length.
    gap = np.hypot(dx, dy) - l["len_m"]
    return gap, f["v"][i_f], l["v"][i_l], along


def _consistent(gap, v_f, v_l):
    """Keep frames where the speed-difference closing rate agrees with the observed rate of
    change of spacing (rejects NGSIM lane-assignment / position-jump artefacts)."""
    if len(gap) < 2:
        return np.zeros(len(gap), bool)
    closing = -np.gradient(gap, 1.0 / HZ)
    dv = v_f - v_l
    return np.abs(closing - dv) <= np.maximum(1.0, 0.5 * np.abs(dv))


def _event(kind, a, b, ks, ttc, drac, sl):
    s = slice(*sl)
    j = int(np.argmin(ttc[s])) + sl[0]
    tmin = float(ttc[j])
    dmax = float(drac[s].max())
    return {"t": round(ks[j] / HZ, 1), "t0": round(ks[sl[0]] / HZ, 1), "t1": round(ks[sl[1] - 1] / HZ, 1),
            "a": int(a), "b": int(b), "type": kind, "ttc_min": round(tmin, 2), "pet": None,
            "drac_max": round(dmax, 2), "severity": severity_ttc(tmin),
            "drac_flag": bool(dmax >= DRAC_FLAG), "overlap": False}


def _series_events(series, ttc_max):
    """series: [(kind, fol, lea, ks, ttc, drac, ok, contiguous_required)] -> events at threshold."""
    out = []
    for kind, fol, lea, ks, ttc, drac, ok, contiguous in series:
        for sl in _runs((ttc <= ttc_max) & ok):
            if contiguous and (np.diff(ks[sl[0]:sl[1]]) != 1).any():
                continue
            out.append(_event(kind, fol, lea, ks, ttc, drac, sl))
    return out


def rear_end_series(tracks, preceding: dict[int, np.ndarray] | None = None, lookahead_m: float = 60.0):
    """Car-following pairs: same lane, leader ahead along heading. If NGSIM `preceding`
    ids are supplied per track (array aligned to frames) they are used; otherwise the nearest
    same-lane vehicle ahead is taken."""
    idx = _index(tracks)
    by_frame = defaultdict(list)
    for tr in tracks:
        for k in _frames(tr):
            by_frame[k].append(tr["id"])
    grads = {tr["id"]: (np.gradient(tr["x"]), np.gradient(tr["y"])) for tr in tracks}
    leader = defaultdict(dict)  # follower -> {k: leader}
    for k, ids in by_frame.items():
        for fid in ids:
            f = idx[fid][1]
            i = _at(idx[fid], k)
            if f["lane"][i] <= 0:
                continue
            lid = None
            if preceding is not None and fid in preceding:
                p = int(preceding[fid][i])
                if p in idx and _at(idx[p], k) is not None and idx[p][1]["lane"][_at(idx[p], k)] == f["lane"][i]:
                    lid = p
            else:
                hx, hy = grads[fid][0][i], grads[fid][1][i]
                n = np.hypot(hx, hy)
                if n < 1e-6:
                    continue
                best = lookahead_m
                for oid in ids:
                    if oid == fid:
                        continue
                    o = idx[oid][1]
                    j = _at(idx[oid], k)
                    if o["lane"][j] != f["lane"][i] or o["dir"] != f["dir"]:
                        continue
                    d = ((o["x"][j] - f["x"][i]) * hx + (o["y"][j] - f["y"][i]) * hy) / n
                    if 0 < d < best:
                        best, lid = d, oid
            if lid is not None:
                leader[fid][k] = lid
    series = []
    for fid, m in leader.items():
        byl = defaultdict(list)
        for k, lid in m.items():
            byl[lid].append(k)
        for lid, ks in byl.items():
            ks = np.array(sorted(ks))
            gap, vf, vl, along = _pair_series(idx[fid][1], idx[lid][1], ks)
            ttc, drac = ttc_drac(gap, vf, vl, MIN_GAP, MIN_SPEED)
            ttc[along <= 0] = np.inf
            series.append(("rear_end", fid, lid, ks, ttc, drac, _consistent(gap, vf, vl), True))
    return series


def rear_end(tracks, preceding=None, lookahead_m: float = 60.0, ttc_max: float = TTC_MAX):
    return _series_events(rear_end_series(tracks, preceding, lookahead_m), ttc_max)


def lane_change_series(tracks, horizon_s: float = 3.0, reach_m: float = 60.0):
    """At each sustained lane change of A, TTC/DRAC against vehicles in the target lane over
    the next `horizon_s`."""
    series = []
    for a in tracks:
        ln = a["lane"]
        ka = _frames(a)
        for i in np.flatnonzero(np.diff(ln) != 0) + 1:
            new = ln[i]
            if ln[i - 1] <= 0 or new <= 0 or ln[i - 1] > 10 and new > 10:
                continue
            h = min(len(ln), i + int(horizon_s * HZ))
            if not (ln[i:h] == new).all() or h - i < MIN_FRAMES:
                continue
            ks = ka[i:h]
            for b in tracks:
                if b["id"] == a["id"] or b["dir"] != a["dir"]:
                    continue
                kb = _frames(b)
                common = ks[(ks >= kb[0]) & (ks <= kb[-1])]
                if len(common) < MIN_FRAMES:
                    continue
                ib = common - kb[0]
                if not (b["lane"][ib] == new).all():
                    continue
                gap, va, vb, along = _pair_series(a, b, common)
                if np.abs(along).min() > reach_m:
                    continue
                if along[0] > 0:  # b ahead of a -> a is follower
                    ttc, drac = ttc_drac(gap, va, vb, MIN_GAP, MIN_SPEED)
                    fol, lea, ok = a["id"], b["id"], _consistent(gap, va, vb)
                else:  # b follows: gap must subtract the leader's (a's) length
                    gap, vb, va, _ = _pair_series(b, a, common)
                    ttc, drac = ttc_drac(gap, vb, va, MIN_GAP, MIN_SPEED)
                    fol, lea, ok = b["id"], a["id"], _consistent(gap, vb, va)
                series.append(("lane_change", fol, lea, common, ttc, drac, ok, False))
    return series


def lane_change(tracks, horizon_s: float = 3.0, reach_m: float = 60.0, ttc_max: float = TTC_MAX):
    return _series_events(lane_change_series(tracks, horizon_s, reach_m), ttc_max)


def conflicting(a: dict, b: dict) -> bool:
    """Movements whose paths cross: different approaches except opposing through/right pairs."""
    if a["dir"] == b["dir"]:
        return False
    if OPPOSITE.get(a["dir"]) == b["dir"]:
        return "left" in (a["move"], b["move"])
    return True


_OFF = 1 << 20


def footprint_cells(tr, cell: float = CELL, up: int = UPSAMPLE):
    """Swept footprint of a track over its intersection frames.
    Returns (codes, t_in, t_out, heading_at) with codes sorted unique raster cells and the
    first/last time any part of the vehicle covers each cell, or None if never inside."""
    m = np.asarray(tr["inside"], bool)
    if not m.any():
        return None
    i0, i1 = np.flatnonzero(m)[[0, -1]]
    t = np.asarray(tr["t"], float)[i0:i1 + 1]
    th = np.unwrap(heading(tr)[i0:i1 + 1])
    x = np.asarray(tr["x"], float)[i0:i1 + 1]
    y = np.asarray(tr["y"], float)[i0:i1 + 1]
    if len(t) > 1:
        tt = np.linspace(t[0], t[-1], (len(t) - 1) * up + 1)
        x, y, th = np.interp(tt, t, x), np.interp(tt, t, y), np.interp(tt, t, th)
    else:
        tt = t
    L, W = float(tr["len_m"]), float(tr.get("w_m") or DEFAULT_W)
    step = cell / 2
    s = np.linspace(-L, 0.0, int(np.ceil(L / step)) + 1)          # along: rear .. front bumper
    u = np.linspace(-W / 2, W / 2, int(np.ceil(W / step)) + 1)     # lateral
    S, U = (a.ravel() for a in np.meshgrid(s, u))
    c, sn = np.cos(th)[:, None], np.sin(th)[:, None]
    px = x[:, None] + S * c - U * sn
    py = y[:, None] + S * sn + U * c
    codes = ((np.floor(px / cell).astype(np.int64) + _OFF) << 21) | (np.floor(py / cell).astype(np.int64) + _OFF)
    times = np.broadcast_to(tt[:, None], codes.shape)
    codes, times = codes.ravel(), times.ravel()
    o = np.argsort(codes, kind="stable")
    codes, times = codes[o], times[o]
    uniq, start = np.unique(codes, return_index=True)
    t_in = np.minimum.reduceat(times, start)
    t_out = np.maximum.reduceat(times, start)
    return uniq, t_in, t_out, (tt, np.mod(th, 2 * np.pi))


def _cell_xy(codes, cell):
    cx = (codes >> 21) - _OFF
    cy = (codes & ((1 << 21) - 1)) - _OFF
    return (cx + 0.5) * cell, (cy + 0.5) * cell


def pet(tracks, cell: float = CELL, pet_max: float = PET_MAX, up: int = UPSAMPLE):
    """Bounding-box PET for conflicting movements. One event per vehicle pair whose swept
    footprints intersect at a conflict angle >= MIN_ANGLE and PET <= pet_max. Simultaneous
    occupancy of the shared zone is recorded as pet=0, overlap=True."""
    fp = {}
    for tr in tracks:
        f = footprint_cells(tr, cell, up)
        if f is not None:
            fp[tr["id"]] = (tr, f)
    ids = list(fp)
    span = {i: (fp[i][1][1].min(), fp[i][1][2].max()) for i in ids}
    events = []
    for ii in range(len(ids)):
        ta, (ca, ain, aout, (att, ath)) = fp[ids[ii]]
        for jj in range(ii + 1, len(ids)):
            tb, (cb, bin_, bout, (btt, bth)) = fp[ids[jj]]
            if not conflicting(ta, tb):
                continue
            sa, sb = span[ids[ii]], span[ids[jj]]
            if sa[0] > sb[1] + pet_max or sb[0] > sa[1] + pet_max:
                continue
            z, ia, ib = np.intersect1d(ca, cb, assume_unique=True, return_indices=True)
            if not len(z):
                continue
            a_in, a_out = ain[ia].min(), aout[ia].max()
            b_in, b_out = bin_[ib].min(), bout[ib].max()
            ha = np.interp((a_in + a_out) / 2, att, ath)
            hb = np.interp((b_in + b_out) / 2, btt, bth)
            ang = abs((np.degrees(ha - hb) + 180) % 360 - 180)
            if ang < MIN_ANGLE:
                continue
            if a_in <= b_in:
                first, second, f_out, s_in, s_out = ta, tb, a_out, b_in, b_out
            else:
                first, second, f_out, s_in, s_out = tb, ta, b_out, a_in, a_out
            overlap = s_in <= f_out
            p = 0.0 if overlap else s_in - f_out
            if p > pet_max + 1e-9:
                continue
            zx, zy = _cell_xy(z, cell)
            events.append({
                "t": round(float(s_in), 1),
                "t0": round(float(s_in if overlap else f_out), 1),
                "t1": round(float(min(f_out, s_out) if overlap else s_in), 1),
                "a": int(first["id"]), "b": int(second["id"]), "type": "crossing",
                "ttc_min": None, "pet": round(float(p), 2), "drac_max": None,
                "severity": severity_pet(p), "drac_flag": False, "overlap": bool(overlap),
                "angle_deg": round(float(ang), 1), "zone_m2": round(float(len(z) * cell * cell), 1),
                "cell": [round(float(zx.mean()), 1), round(float(zy.mean()), 1)],
            })
    return events


def _number(ev):
    ev.sort(key=lambda e: (e["t"], e["a"], e["b"]))
    return [{"id": n, **e} for n, e in enumerate(ev)]


def analyse(tracks, preceding=None):
    """Return (conflicts at SSAM detection thresholds, ssm summary document)."""
    series = rear_end_series(tracks, preceding) + lane_change_series(tracks)
    crossing = pet(tracks, pet_max=max(PET_GRID))
    conflicts = _number(_series_events(series, TTC_MAX) + [e for e in crossing if e["pet"] <= PET_MAX])
    sens_ttc, wide = {}, None
    for thr in TTC_GRID:
        ev = _series_events(series, thr)
        sens_ttc[f"{thr:.1f}"] = {k: sum(e["type"] == k for e in ev) for k in ("rear_end", "lane_change")}
        sens_ttc[f"{thr:.1f}"]["drac_flag"] = sum(e["drac_flag"] for e in ev)
        if thr == max(TTC_GRID):
            wide = ev
    sens_pet = {}
    for thr in PET_GRID:
        ev = [e for e in crossing if e["pet"] <= thr + 1e-9]
        sens_pet[f"{thr:.1f}"] = {"crossing": len(ev), "overlap": sum(e["overlap"] for e in ev),
                                  "crossing_excl_overlap": sum(not e["overlap"] for e in ev)}
    scatter = [[e["ttc_min"], e["drac_max"], e["type"], e["severity"] if e["ttc_min"] <= TTC_MAX else None]
               for e in sorted(wide or [], key=lambda e: e["ttc_min"])]
    counts = defaultdict(int)
    for e in conflicts:
        counts[f"{e['type']}:{e['severity']}"] += 1
    doc = {
        "rules": RULES,
        "sensitivity": {"ttc": sens_ttc, "pet": sens_pet,
                        "note": "counts of distinct events at each threshold; TTC events from the same "
                                "pair series, PET from one footprint pass (min PET per pair)"},
        "scatter": scatter,
        "scatter_fields": ["ttc_min_s", "drac_max_mps2", "type", "severity"],
        "scatter_note": "every TTC event detected at TTC <= 3.0 s; severity null above the 1.5 s detection threshold",
        "counts": {"total": len(conflicts), "by_type_severity": dict(sorted(counts.items())),
                   "drac_flag": sum(e["drac_flag"] for e in conflicts),
                   "overlap": sum(e["overlap"] for e in conflicts)},
    }
    return conflicts, doc


def all_conflicts(tracks, preceding=None):
    return analyse(tracks, preceding)[0]
