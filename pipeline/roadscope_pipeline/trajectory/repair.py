"""Occlusion + repair evaluation: constant-acceleration Kalman filter with RTS smoother (numpy)
versus linear interpolation, scored against held-out truth.

Two gap protocols:
  uniform  - seeded random gaps (0.5-5 s) on random tracks;
  occluder - real line-of-sight occlusion intervals (0.5-5 s) from a virtual roadside sensor,
             where a nearer vehicle footprint blocks the ray to the target footprint centre.
Two truth variants:
  smoothed - Savitzky-Golay-smoothed NGSIM positions as both input and truth;
  raw      - unsmoothed NGSIM positions (ft->m) as both input and truth.
Noise parameters are tuned on validation tracks only, separately per protocol and variant."""
from __future__ import annotations

import numpy as np

from .ssm import heading

DT = 0.1
CONTEXT_S = 3.0          # observed context used on each side of a gap
Q_GRID = tuple(float(f'{v:.3g}') for v in np.logspace(-1, 5, 12))  # 0.1 .. 1e5
R_GRID = (0.02, 0.05, 0.1, 0.2)
GAP_S = (0.5, 5.0)
BUCKETS = ((0.5, 1.0), (1.0, 2.0), (2.0, 3.0), (3.0, 5.0))
METHODS = ("linear", "kf_ca", "kf_ca_path")
SENSOR = (-12.0, 12.0)   # local m; same pole as the UI LiDAR view
SENSOR_H = 4.5           # m (recorded; occlusion is evaluated in 2D)
FLICKER_FRAMES = 2       # visible runs this short between occluded frames are merged
MAX_STEP_M = 5.0         # inter-frame displacement > 5 m (50 m/s) = NGSIM position jump, track not scored

NOTES = [
    "Truth 'smoothed' is the Savitzky-Golay (15 frames, order 2) track; the smoother also spreads "
    "information from inside a gap into its first/last ~0.7 s of context, which favours smooth models.",
    "Truth 'raw' is the unsmoothed NGSIM position (ft->m); it carries NGSIM measurement noise, so it "
    "bounds achievable RMSE from below: Punzo, V., Borzacchiello, M. T., Ciuffo, B. (2011). On the "
    "assessment of vehicle trajectory data accuracy and application to the Next Generation SIMulation "
    "(NGSIM) program data. Transportation Research Part C 19(6), 1243-1262.",
    "Reconstruction of noisy NGSIM trajectories and its validation: Montanino, M., Punzo, V. (2015). "
    "Trajectory data reconstruction and simulation-based validation against macroscopic traffic "
    "patterns. Transportation Research Part B 80, 82-106.",
    "Occluder protocol is 2D (shadow of nearer vehicle footprints along the sensor ray, sensor height "
    "ignored): it over-states occlusion by cars relative to a 4.5 m pole and should be read as a "
    "realistic gap-placement protocol, not a LiDAR visibility model.",
    "Speed is not scored against raw truth: differentiated raw NGSIM positions are dominated by jitter.",
]


def ca_matrices(dt: float = DT, q: float = 2.0):
    """State [p, v, a]; white-noise jerk with spectral density q (m^2/s^5)."""
    F = np.array([[1, dt, dt * dt / 2], [0, 1, dt], [0, 0, 1]])
    Q = q * np.array([[dt**5 / 20, dt**4 / 8, dt**3 / 6],
                      [dt**4 / 8, dt**3 / 3, dt**2 / 2],
                      [dt**3 / 6, dt**2 / 2, dt]])
    return F, Q


def kalman_rts(z: np.ndarray, observed: np.ndarray, r=0.05, q=2.0, dt: float = DT):
    """1-D CA Kalman filter + Rauch-Tung-Striebel smoother, batched over q/r (and z) arrays.
    z: (n,) or (B, n) measurements (ignored where ~observed). Scalar q, r and 1-D z return
    (position, velocity) of shape (n,); otherwise (B, n)."""
    z = np.asarray(z, float)
    single = z.ndim == 1 and np.ndim(q) == 0 and np.ndim(r) == 0
    q, r = np.atleast_1d(np.asarray(q, float)), np.atleast_1d(np.asarray(r, float))
    n = z.shape[-1]
    B = max(len(q), len(r), z.shape[0] if z.ndim == 2 else 1)
    Z = np.broadcast_to(z, (B, n))
    q, R = np.broadcast_to(q, (B,)), np.broadcast_to(r * r, (B,))
    F, Q1 = ca_matrices(dt, 1.0)
    Q = q[:, None, None] * Q1
    xf = np.zeros((n, B, 3)); Pf = np.zeros((n, B, 3, 3))
    xp = np.zeros((n, B, 3)); Pp = np.zeros((n, B, 3, 3))
    i0 = int(np.flatnonzero(observed)[0])
    x = np.zeros((B, 3)); x[:, 0] = Z[:, i0]
    P = np.zeros((B, 3, 3)); P[:, 0, 0] = R; P[:, 1, 1] = 25.0; P[:, 2, 2] = 9.0
    for k in range(n):
        if k > 0:
            x = x @ F.T
            P = F @ P @ F.T + Q
        xp[k], Pp[k] = x, P
        if observed[k]:
            S = P[:, 0, 0] + R
            K = P[:, :, 0] / S[:, None]
            x = x + K * (Z[:, k] - x[:, 0])[:, None]
            P = P - K[:, :, None] * P[:, 0, :][:, None, :]
        xf[k], Pf[k] = x, P
    xs = xf.copy()
    for k in range(n - 2, -1, -1):
        C = Pf[k] @ F.T @ np.linalg.inv(Pp[k + 1])
        xs[k] = xf[k] + (C @ (xs[k + 1] - xp[k + 1])[:, :, None])[:, :, 0]
    pos, vel = xs[:, :, 0].T, xs[:, :, 1].T
    return (pos[0], vel[0]) if single else (pos, vel)


def linear_fill(t: np.ndarray, z: np.ndarray, observed: np.ndarray) -> np.ndarray:
    return np.interp(t, t[observed], z[observed])


def _gaps(observed):
    e = np.flatnonzero(np.diff(np.r_[1, observed.astype(int), 1]))
    return list(zip(e[::2], e[1::2]))  # [start, end) of unobserved runs


def _heading(x, y, obs, s):
    """Heading at gap entry from the last ~1 s of observed positions before the gap."""
    i = np.flatnonzero(obs[:s])[-10:]
    if len(i) < 2:
        i = np.flatnonzero(obs)[:10]
    dx, dy = x[i[-1]] - x[i[0]], y[i[-1]] - y[i[0]]
    return np.arctan2(dy, dx) if np.hypot(dx, dy) > 0.05 else 0.0


def _gap_fill(x, y, observed, s, e, th, qa, qc, r):
    """KF-CA + RTS over one gap [s, e) in the frame rotated by th; batched over qa/qc/r.
    Returns gx, gy, speed with shape (B, e - s)."""
    c = int(CONTEXT_S / DT)
    a, b = max(0, s - c), min(len(x), e + c)
    o = observed[a:b]
    cs, sn = np.cos(th), np.sin(th)
    u = cs * x[a:b] + sn * y[a:b]
    w = -sn * x[a:b] + cs * y[a:b]
    pu, vu = kalman_rts(u, o, r=np.atleast_1d(r), q=np.atleast_1d(qa))
    pw, vw = kalman_rts(w, o, r=np.atleast_1d(r), q=np.atleast_1d(qc))
    g = slice(s - a, e - a)
    pu, pw, vu, vw = pu[:, g], pw[:, g], vu[:, g], vw[:, g]
    return cs * pu - sn * pw, sn * pu + cs * pw, np.hypot(vu, vw)


def repair_track(t, x, y, observed, params=None):
    """Reconstruct each gap from CONTEXT_S of observed data either side.
    linear: interpolation. kf_ca: independent x/y constant-acceleration KF + RTS (isotropic q).
    kf_ca_path: same model in the along/cross-track frame of the gap-entry heading with separate
    jerk PSDs (q_along, q_cross), so lateral (turning) motion gets its own tuned dynamics.
    Returns {method: (x, y, speed)} over the full track (observed frames keep the measurement)."""
    p = {"kf_ca": {"q": 2.0, "r": 0.05}, "kf_ca_path": {"qa": 2.0, "qc": 2.0, "r": 0.05}, **(params or {})}
    x, y = np.asarray(x, float), np.asarray(y, float)
    lx, ly = linear_fill(t, x, observed), linear_fill(t, y, observed)
    lv = np.hypot(np.gradient(lx, t), np.gradient(ly, t))
    out = {"linear": (lx, ly, lv)}
    for m in ("kf_ca", "kf_ca_path"):
        rx, ry, rv = x.copy(), y.copy(), lv.copy()
        for s, e in _gaps(observed):
            if m == "kf_ca":
                qa = qc = p[m]["q"]; r = p[m]["r"]; th = 0.0
            else:
                qa, qc, r = p[m]["qa"], p[m]["qc"], p[m]["r"]; th = _heading(x, y, observed, s)
            gx, gy, gv = _gap_fill(x, y, observed, s, e, th, qa, qc, r)
            rx[s:e], ry[s:e], rv[s:e] = gx[0], gy[0], gv[0]
        out[m] = (rx, ry, rv)
    return out


def _rmse(a):
    a = np.asarray(a, float)
    return float(np.sqrt(np.mean(np.square(a)))) if a.size else None


def _inject(tr, rng, gap_s, margin_s, max_gaps):
    t = np.asarray(tr["t"], float)
    obs = np.ones(len(t), bool)
    for _ in range(int(rng.integers(1, max_gaps + 1))):
        L = int(round(rng.uniform(*gap_s) / DT))
        lo, hi = int(margin_s / DT), len(t) - int(margin_s / DT) - L
        if hi <= lo:
            break
        s0 = int(rng.integers(lo, hi))
        if obs[max(0, s0 - 5):s0 + L + 5].all():
            obs[s0:s0 + L] = False
    return obs


# ---------------------------------------------------------------- occluder protocol

def occlusion(tracks, sensor=SENSOR):
    """2D line-of-sight occlusion from `sensor`. A target is occluded in a frame when the ray from
    the sensor to its footprint centre crosses a nearer vehicle's footprint (length x width box
    behind the front-bumper point, heading from velocity). Returns {id: (occluded bool[n],
    occluder id int[n] or -1)}."""
    S = np.asarray(sensor, float)
    rows = []
    for ti, tr in enumerate(tracks):
        th = heading(tr)
        L, W = float(tr["len_m"]), float(tr.get("w_m") or 1.8)
        x, y = np.asarray(tr["x"], float), np.asarray(tr["y"], float)
        k = np.round(np.asarray(tr["t"], float) / DT).astype(int)
        hx, hy = np.cos(th), np.sin(th)
        rows.append(np.column_stack([k, np.full(len(k), ti), np.arange(len(k)), x - hx * L / 2, y - hy * L / 2,
                                     hx, hy, np.full(len(k), L / 2), np.full(len(k), W / 2)]))
    out = {tr["id"]: (np.zeros(len(tr["t"]), bool), np.full(len(tr["t"]), -1)) for tr in tracks}
    if not rows:
        return out
    A = np.concatenate(rows)
    A = A[np.argsort(A[:, 0], kind="stable")]
    bounds = np.flatnonzero(np.diff(A[:, 0])) + 1
    for g in np.split(A, bounds):
        if len(g) < 2:
            continue
        C, H, hl, hw = g[:, 3:5], g[:, 5:7], g[:, 7], g[:, 8]
        N = np.column_stack([-H[:, 1], H[:, 0]])
        p = S - C                                  # sensor relative to occluder centre (j)
        px, py = (p * H).sum(1), (p * N).sum(1)    # in occluder frame, shape (j,)
        d = C - S                                  # ray to target centre (i)
        dx, dy = d @ H.T, d @ N.T                  # (i, j)
        te, tx = np.zeros(dx.shape), np.ones(dx.shape)
        with np.errstate(divide="ignore", invalid="ignore"):
            for p0, dd, h in ((px, dx, hl), (py, dy, hw)):
                t1, t2 = (-h - p0) / dd, (h - p0) / dd
                lo, hi = np.minimum(t1, t2), np.maximum(t1, t2)
                par = dd == 0
                inside = np.abs(p0) <= h
                lo = np.where(par, np.where(inside, -np.inf, np.inf), lo)
                hi = np.where(par, np.where(inside, np.inf, -np.inf), hi)
                te, tx = np.maximum(te, lo), np.minimum(tx, hi)
        hit = (te <= tx) & (te < 1.0)
        np.fill_diagonal(hit, False)
        hit[:, (np.abs(px) <= hl) & (np.abs(py) <= hw)] = False   # sensor inside a box: ignore
        te = np.where(hit, te, np.inf)
        occ = hit.any(1)
        who = np.argmin(te, 1)
        for row, o, j in zip(g, occ, who):
            if o:
                tr = tracks[int(row[1])]
                m, by = out[tr["id"]]
                m[int(row[2])] = True
                by[int(row[2])] = tracks[int(g[j, 1])]["id"]
    return out


def max_step(tr) -> float:
    """Largest 0.1 s displacement in the smoothed or raw positions (m)."""
    st = [np.hypot(np.diff(np.asarray(tr["x"], float)), np.diff(np.asarray(tr["y"], float)))]
    if "x_raw" in tr:
        st.append(np.hypot(np.diff(np.asarray(tr["x_raw"], float)), np.diff(np.asarray(tr["y_raw"], float))))
    return float(max((a.max() for a in st if a.size), default=0.0))


def _close_flicker(m, n=FLICKER_FRAMES):
    m = m.copy()
    for s, e in _gaps(~m):           # runs of visible frames
        if 0 < s and e < len(m) and e - s <= n:
            m[s:e] = True
    return m


def occluder_gaps(tr, occ, gap_s=GAP_S, margin_s: float = 1.0):
    """Real occlusion intervals usable as gaps: length within gap_s and >= margin_s of observed
    track either side. Returns observed mask (False on the selected gaps) and [(s, e)]."""
    m = _close_flicker(occ)
    n, mg = len(m), int(margin_s / DT)
    lo, hi = int(round(gap_s[0] / DT)), int(round(gap_s[1] / DT))
    sel = [(s, e) for s, e in _gaps(~m) if lo <= e - s <= hi and s >= mg and n - e >= mg]
    obs = np.ones(n, bool)
    for s, e in sel:
        obs[s:e] = False
    return obs, sel


# ---------------------------------------------------------------- evaluation

def _case(tr, obs, variant):
    """Input/truth arrays for one (track, protocol mask) under a truth variant."""
    t = np.asarray(tr["t"], float)
    gaps = _gaps(obs)
    if variant == "raw":
        ok = np.asarray(tr["raw_ok"], bool)
        x, y = np.asarray(tr["x_raw"], float), np.asarray(tr["y_raw"], float)
        return {"tr": tr, "t": t, "x": x, "y": y, "v": None, "obs": obs & ok, "valid": ok, "gaps": gaps}
    return {"tr": tr, "t": t, "x": np.asarray(tr["x"], float), "y": np.asarray(tr["y"], float),
            "v": np.asarray(tr["v"], float), "obs": obs, "valid": np.ones(len(t), bool), "gaps": gaps}


def _evaluate(cases, params):
    """Per-gap errors for every method: [(gap_len_s, method, pos_err, speed_err|None)], recs."""
    errs, recs = [], []
    for c in cases:
        rec = repair_track(c["t"], c["x"], c["y"], c["obs"], params)
        recs.append(rec)
        for k in METHODS:
            rx, ry, rv = rec[k]
            for s, e in c["gaps"]:
                v = c["valid"][s:e]
                pe = np.hypot(rx[s:e] - c["x"][s:e], ry[s:e] - c["y"][s:e])[v]
                se = None if c["v"] is None else (rv[s:e] - c["v"][s:e])[v]
                errs.append(((e - s) * DT, k, pe, se))
    return errs, recs


def _agg(rows):
    pe = [r[2] for r in rows]
    se = [r[3] for r in rows if r[3] is not None]
    return {"gaps": len(rows), "gap_frames": int(sum(len(p) for p in pe)),
            "rmse_m": round(_rmse(np.concatenate(pe)), 3) if pe and sum(map(len, pe)) else None,
            "speed_rmse": round(_rmse(np.concatenate(se)), 3) if se and sum(map(len, se)) else None}


def _by_gap(errs):
    out = []
    for i, (lo, hi) in enumerate(BUCKETS):
        last = i == len(BUCKETS) - 1
        sel = [g for g in errs if lo - 1e-9 <= g[0] and (g[0] < hi - 1e-9 or last and g[0] <= hi + 1e-9)]
        out.append({"gap_s": [lo, hi], **{k: _agg([g for g in sel if g[1] == k]) for k in METHODS}})
    return out


def _grid_sse(cases, th_fn, qa, qc, r):
    """Pooled squared position error over gap frames for a batch of (qa, qc, r)."""
    sse, cnt = np.zeros(len(qa)), 0
    for c in cases:
        for s, e in c["gaps"]:
            gx, gy, _ = _gap_fill(c["x"], c["y"], c["obs"], s, e, th_fn(c, s), qa, qc, r)
            v = c["valid"][s:e]
            sse += (((gx - c["x"][s:e]) ** 2 + (gy - c["y"][s:e]) ** 2)[:, v]).sum(1)
            cnt += int(v.sum())
    return sse, max(cnt, 1)


def tune(cases):
    """Grid search q/r for kf_ca, then coordinate descent (q_along, q_cross) for kf_ca_path, on
    validation cases only; method selected by validation position RMSE."""
    QQ, RR = (a.ravel() for a in np.meshgrid(np.array(Q_GRID), np.array(R_GRID), indexing="ij"))
    sse, cnt = _grid_sse(cases, lambda c, s: 0.0, QQ, QQ, RR)
    ca = {(q, r): float(np.sqrt(v / cnt)) for q, r, v in zip(QQ, RR, sse)}
    q_best, r = (float(v) for v in min(ca, key=ca.get))   # R is a sensor property: shared by both KF variants
    qg = np.array(Q_GRID)
    path_th = lambda c, s: _heading(c["x"], c["y"], c["obs"], s)
    sa, _ = _grid_sse(cases, path_th, qg, np.full(len(qg), q_best), np.full(len(qg), r))
    qa = float(qg[np.argmin(sa)])
    sc, _ = _grid_sse(cases, path_th, np.full(len(qg), qa), qg, np.full(len(qg), r))
    qc = float(qg[np.argmin(sc)])
    params = {"kf_ca": {"q": float(q_best), "r": float(r)}, "kf_ca_path": {"qa": qa, "qc": qc, "r": float(r)}}
    best_rmse = ca[(q_best, r)]
    flat = [q for q in Q_GRID if ca[(q, r)] <= best_rmse * 1.01]
    params["q_status"] = {"interior": bool(Q_GRID[0] < q_best < Q_GRID[-1]),
                          "flat_within_1pct_from": min(flat), "flat_within_1pct_to": max(flat),
                          "note": "validation RMSE within 1% of optimum over this q range"}
    errs, _ = _evaluate(cases, params)
    agg = {k: _agg([g for g in errs if g[1] == k]) for k in METHODS}
    pos = {k: agg[k]["rmse_m"] for k in METHODS}
    spd = {k: agg[k]["speed_rmse"] for k in METHODS}
    selected = min(METHODS, key=lambda k: pos[k] if pos[k] is not None else np.inf)
    return params, {"tracks": len(cases), "gap_frames": agg["linear"]["gap_frames"],
                    "rmse_m": pos, "speed_rmse": spd, "selected": selected,
                    "q_curve": [[q, round(ca[(q, r)], 4)] for q in Q_GRID], "q_curve_r": float(r),
                    "grid": {"q": list(Q_GRID), "r": list(R_GRID)}}


def _r2(a):
    return [round(float(q), 2) for q in a]


def _run(val_pairs, test_pairs, variant):
    """Tune on validation, score test, for one protocol x truth variant."""
    val = [_case(tr, o, variant) for tr, o in val_pairs]
    test = [_case(tr, o, variant) for tr, o in test_pairs]
    params, val_rep = tune(val) if val else ({}, None)
    best = val_rep["selected"] if val_rep else "kf_ca"
    errs, recs = _evaluate(test, params)
    methods = {k: _agg([g for g in errs if g[1] == k]) for k in METHODS}
    per_track = []
    for c, rec in zip(test, recs):
        m = np.zeros(len(c["t"]), bool)
        for s, e in c["gaps"]:
            m[s:e] = True
        m &= c["valid"]
        row = {}
        for k in METHODS:
            rx, ry, rv = rec[k]
            row[k] = {"rmse_m": round(_rmse(np.hypot(rx - c["x"], ry - c["y"])[m]), 3),
                      "speed_rmse": None if c["v"] is None else round(_rmse((rv - c["v"])[m]), 3)}
        per_track.append(row)
    share = {k: round(float(np.mean([r[k]["rmse_m"] < r["linear"]["rmse_m"] for r in per_track])), 3)
             for k in ("kf_ca", "kf_ca_path")} if per_track else {}
    res = {"params": params, "selected_method": best, "validation": val_rep, "methods": methods,
           "by_gap": _by_gap(errs), "better_than_linear_share": share,
           "tracks_test": len(test), "tracks_val": len(val)}
    return res, test, recs, per_track


def _rows(test, recs, per_track, best, protocol, extra=None):
    out = []
    for n, (c, rec, pt) in enumerate(zip(test, recs, per_track)):
        t, x, y, obs = c["t"], c["x"], c["y"], c["obs"]
        m = ~obs
        row = {"id": c["tr"]["id"], "protocol": protocol,
               "gaps": [[round(t[a], 1), round(t[b - 1], 1)] for a, b in c["gaps"]],
               "method": best, "methods": pt,
               "rmse_m": pt[best]["rmse_m"], "speed_rmse": pt[best]["speed_rmse"],
               "raw": [[round(t[i], 1), *_r2((x[i], y[i]))] for i in np.flatnonzero(obs)],
               "truth": [[round(t[i], 1), *_r2((x[i], y[i]))] for i in np.flatnonzero(m)],
               "repaired": [[round(t[i], 1), *_r2((rec[best][0][i], rec[best][1][i]))] for i in np.flatnonzero(m)],
               "linear": [[round(t[i], 1), *_r2((rec["linear"][0][i], rec["linear"][1][i]))] for i in np.flatnonzero(m)]}
        if extra:
            row.update(extra[n])
        out.append(row)
    return out


def occlude_and_repair(tracks, frac: float = 0.2, gap_s=GAP_S, min_dur_s: float = 6.0,
                       margin_s: float = 1.0, seed: int = 20251, max_gaps: int = 2, val_max: int = 60,
                       sensor=SENSOR):
    """Uniform protocol: ~frac of eligible tracks are the test set (seeded gaps); up to val_max of
    the rest tune q/r. Occluder protocol: tracks with real occlusion gaps split 50/50 (seeded) into
    validation and test. Top-level summary keys describe uniform x smoothed (backward compatible);
    summary.protocols holds both protocols x both truth variants."""
    rng = np.random.default_rng(seed)
    jumps = sorted((tr["id"] for tr in tracks if max_step(tr) > MAX_STEP_M), key=str)
    eligible = [tr for tr in tracks if tr["t"][-1] - tr["t"][0] >= min_dur_s and tr["id"] not in jumps]
    n = max(1, int(round(frac * len(eligible)))) if eligible else 0
    perm = rng.permutation(len(eligible))
    test_tr = [eligible[i] for i in sorted(perm[:n])]
    val_tr = [eligible[i] for i in sorted(perm[n:n + val_max])]
    vrng = np.random.default_rng(seed + 1)
    u_val = [(tr, o) for tr in val_tr if not (o := _inject(tr, vrng, gap_s, margin_s, max_gaps)).all()]
    u_test = [(tr, o) for tr in test_tr if not (o := _inject(tr, rng, gap_s, margin_s, max_gaps)).all()]

    occ = occlusion(tracks, sensor)
    occ_pairs, occ_by, n_frames, n_occ = [], {}, 0, 0
    for tr in tracks:
        m, by = occ[tr["id"]]
        n_frames += len(m); n_occ += int(m.sum())
        obs, sel = occluder_gaps(tr, m, gap_s, margin_s)
        if sel and tr["id"] not in jumps:   # jump tracks still act as occluders
            occ_pairs.append((tr, obs))
            occ_by[tr["id"]] = [sorted({int(b) for b in by[s:e] if b >= 0}) for s, e in sel]
    orng = np.random.default_rng(seed + 2)
    op = orng.permutation(len(occ_pairs))
    o_test = [occ_pairs[i] for i in sorted(op[: len(op) // 2])]
    o_val = [occ_pairs[i] for i in sorted(op[len(op) // 2:])]
    all_gaps = [(e - s) * DT for _, o in occ_pairs for s, e in _gaps(o)]

    variants = ["smoothed"] + (["raw"] if tracks and all("x_raw" in tr for tr in tracks) else [])
    protocols = {
        "uniform": {"description": f"seeded random gaps {gap_s[0]}-{gap_s[1]} s, 1-{max_gaps} per track, "
                                   f">= {margin_s} s from track ends", "gap_s": list(gap_s), "seed": seed,
                    "truth_variants": {}},
        "occluder": {"description": "real 2D line-of-sight occlusion intervals from a virtual roadside sensor; "
                                    f"intervals {gap_s[0]}-{gap_s[1]} s kept, >= {margin_s} s from track ends; "
                                    f"visible flickers <= {FLICKER_FRAMES} frames merged",
                     "sensor": {"x_m": sensor[0], "y_m": sensor[1], "height_m": SENSOR_H, "model": "2D"},
                     "gap_s": list(gap_s), "seed": seed + 2,
                     "occlusion": {"frames": n_frames, "occluded_frames": n_occ,
                                   "occluded_share": round(n_occ / max(n_frames, 1), 3),
                                   "tracks_with_gaps": len(occ_pairs), "gaps": len(all_gaps),
                                   "gap_len_mean_s": round(float(np.mean(all_gaps)), 2) if all_gaps else None,
                                   "gaps_by_bin": [[lo, hi, sum(lo - 1e-9 <= g < hi - 1e-9 or (hi == BUCKETS[-1][1] and g == hi)
                                                                for g in all_gaps)] for lo, hi in BUCKETS]},
                     "truth_variants": {}},
    }
    out_tracks = []
    top = None
    for name, (vp, tp) in (("uniform", (u_val, u_test)), ("occluder", (o_val, o_test))):
        for var in variants:
            res, test, recs, per_track = _run(vp, tp, var)
            protocols[name]["truth_variants"][var] = {k: res[k] for k in ("tracks_test", "tracks_val", "selected_method",
                                                                         "params", "methods", "by_gap",
                                                                         "better_than_linear_share")}
            protocols[name]["truth_variants"][var]["validation"] = (
                {k: v for k, v in res["validation"].items() if k not in ("grid",)} if res["validation"] else None)
            if var == "smoothed":
                extra = None
                if name == "occluder":
                    extra = [{"occluded_by": occ_by[c["tr"]["id"]]} for c in test]
                rows = _rows(test, recs, per_track, res["selected_method"], name, extra)
                out_tracks += rows
                if name == "uniform":
                    top = res
            else:
                # attach raw-truth per-track metrics to the smoothed rows of this protocol
                ids = {r["id"]: r for r in out_tracks if r["protocol"] == name}
                for c, pt in zip(test, per_track):
                    if c["tr"]["id"] in ids:
                        ids[c["tr"]["id"]]["methods_raw"] = {k: {"rmse_m": pt[k]["rmse_m"]} for k in METHODS}

    methods = top["methods"]
    summ = {"tracks_occluded": sum(r["protocol"] == "uniform" for r in out_tracks), "tracks_eligible": len(eligible),
            "seed": seed, "gap_s": list(gap_s), "gaps": methods["linear"]["gaps"],
            "gap_frames": methods["linear"]["gap_frames"], "context_s": CONTEXT_S,
            "selected_method": top["selected_method"], "params": top["params"], "validation": top["validation"],
            "methods": methods, "by_gap": top["by_gap"], "better_than_linear_share": top["better_than_linear_share"],
            "truth": "Savitzky-Golay-smoothed NGSIM track (held out inside gaps); uniform protocol. "
                     "See summary.protocols for the occluder protocol and raw-truth variant.",
            "protocols": protocols,
            "truth_variants": {"smoothed": "Savitzky-Golay (15 frames, order 2) NGSIM positions as input and truth",
                               **({"raw": "unsmoothed NGSIM local_x/local_y (ft->m) as input and truth; "
                                          "NGSIM-interpolated frames excluded from scoring"} if "raw" in variants else {})},
            "screening": {"max_step_m": MAX_STEP_M, "tracks_excluded": len(jumps), "ids": jumps,
                          "rule": "tracks with any 0.1 s displacement > 5 m (smoothed or raw) are not scored "
                                  "in either protocol (NGSIM position jumps); they still occlude others"},
            "notes": NOTES}
    summ["kalman_rts"] = {k: methods["kf_ca"][k] for k in ("rmse_m", "speed_rmse")}
    summ["linear"] = {k: methods["linear"][k] for k in ("rmse_m", "speed_rmse")}
    return {"tracks": out_tracks, "summary": summ}
