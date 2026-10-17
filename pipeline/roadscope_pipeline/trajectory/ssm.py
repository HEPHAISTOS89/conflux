"""Surrogate safety measures on 10 Hz trajectories: TTC, DRAC (car-following / lane change),
PET over 2 m conflict-zone cells for crossing movements.

Track dict keys used: id, len_m, t, x, y, v, lane, dir, move, inside (bool array; for PET)."""
from __future__ import annotations

from collections import defaultdict

import numpy as np

TTC_MAX = 1.5      # s   (SPEC)
PET_MAX = 2.0      # s   (SPEC)
DRAC_MAX = 3.4     # m/s^2 (SPEC)
CELL = 2.0         # m
MIN_FRAMES = 3
MIN_GAP = 1.0      # m   spacing below this at 10 Hz is an NGSIM overlap artefact, not a gap
MIN_SPEED = 2.0    # m/s follower speed; excludes creeping inside standing queues     # an event must persist >= 0.3 s to reject residual jitter
HZ = 10
OPPOSITE = {"NB": "SB", "SB": "NB", "EB": "WB", "WB": "EB"}


def ttc_drac(gap: np.ndarray, v_f: np.ndarray, v_l: np.ndarray, min_gap: float = 0.0,
             min_speed: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    """gap = bumper-to-bumper spacing (m). TTC = gap/(v_f-v_l), DRAC = (v_f-v_l)^2/(2 gap) when closing."""
    gap, v_f, v_l = (np.asarray(q, float) for q in (gap, v_f, v_l))
    dv = v_f - v_l
    ok = (dv > 0) & (gap > max(min_gap, 0.0)) & (v_f >= min_speed)
    if min_gap <= 0:
        ok &= gap > 0
    ttc = np.full(gap.shape, np.inf)
    drac = np.zeros(gap.shape)
    ttc[ok] = gap[ok] / dv[ok]
    drac[ok] = dv[ok] ** 2 / (2 * gap[ok])
    return ttc, drac


def severity_ttc(ttc: float) -> str:
    return "critical" if ttc < 1.0 else "serious" if ttc < 1.5 else "moderate"


def severity_pet(pet: float) -> str:
    return "critical" if pet < 1.0 else "serious" if pet < 1.5 else "moderate"


def _frames(tr) -> np.ndarray:
    return np.round(np.asarray(tr["t"]) * HZ).astype(int)


def _index(tracks):
    idx = {}
    for tr in tracks:
        k = _frames(tr)
        idx[tr["id"]] = (k[0], tr)
    return idx


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
    # heading of follower from its velocity (finite difference of smoothed positions)
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
    return {"t": round(ks[j] / HZ, 1), "a": int(a), "b": int(b), "type": kind,
            "ttc_min": round(tmin, 2), "pet": None,
            "drac_max": round(float(drac[s].max()), 2), "severity": severity_ttc(tmin),
            "t0": round(ks[sl[0]] / HZ, 1), "t1": round(ks[sl[1] - 1] / HZ, 1)}


def rear_end(tracks, preceding: dict[int, np.ndarray] | None = None, lookahead_m: float = 60.0):
    """Car-following pairs: same lane, leader ahead along heading. If NGSIM `preceding`
    ids are supplied per track (array aligned to frames) they are used; otherwise the nearest
    same-lane vehicle ahead is taken."""
    idx = _index(tracks)
    by_frame = defaultdict(list)
    for tr in tracks:
        for k in _frames(tr):
            by_frame[k].append(tr["id"])
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
                hx, hy = (np.gradient(f["x"])[i], np.gradient(f["y"])[i])
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
    events = []
    for fid, m in leader.items():
        byl = defaultdict(list)
        for k, lid in m.items():
            byl[lid].append(k)
        for lid, ks in byl.items():
            ks = np.array(sorted(ks))
            gap, vf, vl, along = _pair_series(idx[fid][1], idx[lid][1], ks)
            ttc, drac = ttc_drac(gap, vf, vl, MIN_GAP, MIN_SPEED)
            ttc[along <= 0] = np.inf
            mask = ((ttc < TTC_MAX) | (drac > DRAC_MAX)) & _consistent(gap, vf, vl)
            for sl in _runs(mask):
                if (np.diff(ks[sl[0]:sl[1]]) != 1).any():
                    continue
                events.append(_event("rear_end", fid, lid, ks, ttc, drac, sl))
    return events


def lane_change(tracks, horizon_s: float = 3.0, reach_m: float = 60.0):
    """At each sustained lane change of A, evaluate TTC/DRAC against the nearest vehicle
    ahead and behind in the target lane over the next `horizon_s`."""
    idx = _index(tracks)
    events = []
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
                ahead = along[0] > 0  # b ahead of a -> a is follower
                if ahead:
                    ttc, drac = ttc_drac(gap, va, vb, MIN_GAP, MIN_SPEED)
                    fol, lea, ok = a["id"], b["id"], _consistent(gap, va, vb)
                else:
                    ttc, drac = ttc_drac(gap, vb, va, MIN_GAP, MIN_SPEED)
                    fol, lea, ok = b["id"], a["id"], _consistent(gap, vb, va)
                mask = ((ttc < TTC_MAX) | (drac > DRAC_MAX)) & ok
                for sl in _runs(mask):
                    events.append(_event("lane_change", fol, lea, common, ttc, drac, sl))
    return events


def conflicting(a: dict, b: dict) -> bool:
    """Movements whose paths cross: different approaches except opposing through/right pairs
    and same-approach pairs."""
    if a["dir"] == b["dir"]:
        return False
    if OPPOSITE.get(a["dir"]) == b["dir"]:
        return "left" in (a["move"], b["move"])
    return True


def pet(tracks, cell: float = CELL):
    """PET = t_enter(second) - t_exit(first) for 2 m cells inside the intersection occupied
    by conflicting movements. Minimum PET per vehicle pair is reported."""
    occ = defaultdict(list)  # cell -> [(id, t_in, t_out)]
    by_id = {tr["id"]: tr for tr in tracks}
    for tr in tracks:
        m = np.asarray(tr["inside"], bool)
        if not m.any():
            continue
        cx = np.floor(np.asarray(tr["x"])[m] / cell).astype(int)
        cy = np.floor(np.asarray(tr["y"])[m] / cell).astype(int)
        t = np.asarray(tr["t"])[m]
        seen = {}
        for c, tt in zip(zip(cx, cy), t):
            lo, hi = seen.get(c, (tt, tt))
            seen[c] = (min(lo, tt), max(hi, tt))
        for c, (lo, hi) in seen.items():
            occ[c].append((tr["id"], lo, hi))
    best = {}
    for c, lst in occ.items():
        for i in range(len(lst)):
            for j in range(i + 1, len(lst)):
                (ia, ai, ao), (ib, bi, bo) = lst[i], lst[j]
                if not conflicting(by_id[ia], by_id[ib]):
                    continue
                if ao < bi:
                    p, first, second, tc = bi - ao, ia, ib, bi
                elif bo < ai:
                    p, first, second, tc = ai - bo, ib, ia, ai
                else:
                    continue  # simultaneous occupancy of a 2 m cell by centre points: not a gap
                if p < PET_MAX:
                    key = tuple(sorted((ia, ib)))
                    if key not in best or p < best[key]["pet"]:
                        best[key] = {"t": round(float(tc), 1), "a": int(first), "b": int(second),
                                     "type": "crossing", "ttc_min": None, "pet": round(float(p), 2),
                                     "drac_max": None, "severity": severity_pet(p),
                                     "cell": [round(c[0] * cell + cell / 2, 1), round(c[1] * cell + cell / 2, 1)]}
    return list(best.values())


def all_conflicts(tracks, preceding=None):
    ev = rear_end(tracks, preceding) + lane_change(tracks) + pet(tracks)
    ev.sort(key=lambda e: e["t"])
    for n, e in enumerate(ev):
        e["id"] = n
    return [{"id": e.pop("id"), **e} for e in ev]
