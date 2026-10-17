"""Synthetic occlusion + repair: constant-acceleration Kalman filter with RTS smoother
(numpy) versus linear interpolation, scored against held-out truth."""
from __future__ import annotations

import numpy as np

DT = 0.1


def ca_matrices(dt: float = DT, q: float = 2.0):
    """State [p, v, a]; white-noise jerk with spectral density q (m^2/s^5)."""
    F = np.array([[1, dt, dt * dt / 2], [0, 1, dt], [0, 0, 1]])
    Q = q * np.array([[dt**5 / 20, dt**4 / 8, dt**3 / 6],
                      [dt**4 / 8, dt**3 / 3, dt**2 / 2],
                      [dt**3 / 6, dt**2 / 2, dt]])
    return F, Q


def kalman_rts(z: np.ndarray, observed: np.ndarray, r: float = 0.05, q: float = 2.0, dt: float = DT):
    """1-D CA Kalman filter + Rauch-Tung-Striebel smoother. z: measurements (ignored where
    ~observed). Returns smoothed (position, velocity)."""
    n = len(z)
    F, Q = ca_matrices(dt, q)
    H = np.array([[1.0, 0, 0]])
    R = r * r
    xf = np.zeros((n, 3)); Pf = np.zeros((n, 3, 3))
    xp = np.zeros((n, 3)); Pp = np.zeros((n, 3, 3))
    i0 = int(np.flatnonzero(observed)[0])
    x = np.array([z[i0], 0.0, 0.0]); P = np.diag([R, 25.0, 9.0])
    for k in range(n):
        if k > 0:
            x = F @ x; P = F @ P @ F.T + Q
        xp[k], Pp[k] = x, P
        if observed[k]:
            S = H @ P @ H.T + R
            K = P @ H.T / S
            x = x + (K * (z[k] - H @ x)).ravel()
            P = (np.eye(3) - K @ H) @ P
        xf[k], Pf[k] = x, P
    xs = xf.copy()
    for k in range(n - 2, -1, -1):
        C = Pf[k] @ F.T @ np.linalg.inv(Pp[k + 1])
        xs[k] = xf[k] + C @ (xs[k + 1] - xp[k + 1])
    return xs[:, 0], xs[:, 1]


def linear_fill(t: np.ndarray, z: np.ndarray, observed: np.ndarray) -> np.ndarray:
    return np.interp(t, t[observed], z[observed])


CONTEXT_S = 3.0          # observed context used on each side of a gap
Q_GRID = tuple(float(f'{v:.3g}') for v in np.logspace(-1, 5, 12))  # 0.1 .. 1e5
R_GRID = (0.02, 0.05, 0.1, 0.2)
BUCKETS = ((0.8, 1.5), (1.5, 2.2), (2.2, 3.0))
METHODS = ("linear", "kf_ca", "kf_ca_path")


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


def repair_track(t, x, y, observed, params=None):
    """Reconstruct each gap from CONTEXT_S of observed data either side.
    linear: interpolation. kf_ca: independent x/y constant-acceleration KF + RTS (isotropic q).
    kf_ca_path: same model in the along/cross-track frame of the gap-entry heading with separate
    jerk PSDs (q_along, q_cross), so lateral (turning) motion gets its own tuned dynamics.
    Returns {method: (x, y, speed)} over the full track (observed frames keep the measurement)."""
    p = {"kf_ca": {"q": 2.0, "r": 0.05}, "kf_ca_path": {"qa": 2.0, "qc": 2.0, "r": 0.05}, **(params or {})}
    n = len(t)
    lx, ly = linear_fill(t, x, observed), linear_fill(t, y, observed)
    lv = np.hypot(np.gradient(lx, t), np.gradient(ly, t))
    out = {"linear": (lx, ly, lv)}
    c = int(CONTEXT_S / DT)
    for m in ("kf_ca", "kf_ca_path"):
        rx, ry = x.astype(float).copy(), y.astype(float).copy()
        rv = lv.copy()
        for s, e in _gaps(observed):
            a, b = max(0, s - c), min(n, e + c)
            o = observed[a:b]
            if m == "kf_ca":
                qa = qc = p[m]["q"]; r = p[m]["r"]; th = 0.0
            else:
                qa, qc, r = p[m]["qa"], p[m]["qc"], p[m]["r"]; th = _heading(x, y, observed, s)
            cs, sn = np.cos(th), np.sin(th)
            u = cs * x[a:b] + sn * y[a:b]
            w = -sn * x[a:b] + cs * y[a:b]
            pu, vu = kalman_rts(u, o, r=r, q=qa)
            pw, vw = kalman_rts(w, o, r=r, q=qc)
            gx, gy = cs * pu - sn * pw, sn * pu + cs * pw
            g = slice(s - a, e - a)
            rx[s:e], ry[s:e] = gx[g], gy[g]
            rv[s:e] = np.hypot(vu, vw)[g]
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


def _score(cases, params):
    """Pooled gap-frame position / speed RMSE per method for given params."""
    pe = {m: [] for m in METHODS}; se = {m: [] for m in METHODS}
    for tr, obs in cases:
        x, y, v, t = (np.asarray(tr[k], float) for k in ("x", "y", "v", "t"))
        rec = repair_track(t, x, y, obs, params)
        m = ~obs
        for k in METHODS:
            pe[k].append(np.hypot(rec[k][0][m] - x[m], rec[k][1][m] - y[m]))
            se[k].append(rec[k][2][m] - v[m])
    return ({k: _rmse(np.concatenate(pe[k])) for k in METHODS},
            {k: _rmse(np.concatenate(se[k])) for k in METHODS})


def tune(val_tracks, seed, gap_s, margin_s, max_gaps):
    """Grid search q/r (and q_along, q_cross) on synthetic gaps in validation tracks only."""
    rng = np.random.default_rng(seed + 1)
    cases = [(tr, _inject(tr, rng, gap_s, margin_s, max_gaps)) for tr in val_tracks]
    cases = [c for c in cases if (~c[1]).any()]
    ca = {(q, r): _score(cases, {"kf_ca": {"q": q, "r": r}})[0]["kf_ca"] for q in Q_GRID for r in R_GRID}
    q_best, r = min(ca, key=ca.get)  # R is a sensor property: shared by both KF variants
    curve = [[q, round(ca[(q, r)], 4)] for q in Q_GRID]
    # coordinate descent for the path-frame variant (along, then cross), starting at q_best
    f = lambda qa, qc: _score(cases, {"kf_ca_path": {"qa": qa, "qc": qc, "r": r}})[0]["kf_ca_path"]
    qa = min(Q_GRID, key=lambda v: f(v, q_best))
    qc = min(Q_GRID, key=lambda v: f(qa, v))
    params = {"kf_ca": {"q": q_best, "r": r}, "kf_ca_path": {"qa": qa, "qc": qc, "r": r}}
    best_rmse = ca[(q_best, r)]
    flat = [q for q in Q_GRID if ca[(q, r)] <= best_rmse * 1.01]
    params["q_status"] = {"interior": Q_GRID[0] < q_best < Q_GRID[-1],
                          "flat_within_1pct_from": min(flat), "flat_within_1pct_to": max(flat),
                          "note": "validation RMSE within 1% of optimum over this q range"}
    pos, spd = _score(cases, params)
    selected = min(METHODS, key=lambda k: pos[k])
    return params, {"tracks": len(cases), "gap_frames": int(sum((~o).sum() for _, o in cases)),
                    "rmse_m": pos, "speed_rmse": spd, "selected": selected, "q_curve": curve, "q_curve_r": r,
                    "grid": {"q": list(Q_GRID), "r": list(R_GRID)}}


def occlude_and_repair(tracks, frac: float = 0.2, gap_s=(0.8, 3.0), min_dur_s: float = 6.0,
                       margin_s: float = 1.0, seed: int = 20251, max_gaps: int = 2, val_max: int = 60):
    """Split eligible tracks: ~frac become the test set (seeded occlusion, scored against held-out
    truth); up to val_max of the rest are the validation set used only to tune q/r and pick the
    method written to `repaired`. Metrics are reported per method and per gap-length bucket."""
    rng = np.random.default_rng(seed)
    eligible = [tr for tr in tracks if tr["t"][-1] - tr["t"][0] >= min_dur_s]
    n = max(1, int(round(frac * len(eligible)))) if eligible else 0
    perm = rng.permutation(len(eligible))
    test = [eligible[i] for i in sorted(perm[:n])]
    val = [eligible[i] for i in sorted(perm[n:n + val_max])]
    params, val_rep = tune(val, seed, gap_s, margin_s, max_gaps) if val else ({}, None)
    best = val_rep["selected"] if val_rep else "kf_ca"
    r2 = lambda a: [round(float(q), 2) for q in a]
    out = []
    gap_err = []  # (gap_len_s, method, pos_err array, speed_err array)
    for tr in test:
        t, x, y, v = (np.asarray(tr[k], float) for k in ("t", "x", "y", "v"))
        obs = _inject(tr, rng, gap_s, margin_s, max_gaps)
        if obs.all():
            continue
        rec = repair_track(t, x, y, obs, params)
        m = ~obs
        gaps = _gaps(obs)
        row = {"id": tr["id"], "gaps": [[round(t[a], 1), round(t[b - 1], 1)] for a, b in gaps],
               "method": best, "methods": {}}
        for k in METHODS:
            rx, ry, rv = rec[k]
            pe = np.hypot(rx - x, ry - y); se = rv - v
            row["methods"][k] = {"rmse_m": round(_rmse(pe[m]), 3), "speed_rmse": round(_rmse(se[m]), 3)}
            for a, b in gaps:
                gap_err.append(((b - a) * DT, k, pe[a:b], se[a:b]))
        row["rmse_m"] = row["methods"][best]["rmse_m"]
        row["speed_rmse"] = row["methods"][best]["speed_rmse"]
        row["raw"] = [[round(t[i], 1), *r2((x[i], y[i]))] for i in np.flatnonzero(obs)]
        row["truth"] = [[round(t[i], 1), *r2((x[i], y[i]))] for i in np.flatnonzero(m)]
        row["repaired"] = [[round(t[i], 1), *r2((rec[best][0][i], rec[best][1][i]))] for i in np.flatnonzero(m)]
        row["linear"] = [[round(t[i], 1), *r2((rec["linear"][0][i], rec["linear"][1][i]))] for i in np.flatnonzero(m)]
        out.append(row)

    def agg(rows):
        return {"gaps": len(rows), "gap_frames": int(sum(len(r[2]) for r in rows)),
                "rmse_m": round(_rmse(np.concatenate([r[2] for r in rows])), 3) if rows else None,
                "speed_rmse": round(_rmse(np.concatenate([r[3] for r in rows])), 3) if rows else None}

    methods = {k: agg([g for g in gap_err if g[1] == k]) for k in METHODS}
    by_gap = []
    for lo, hi in BUCKETS:
        sel = [g for g in gap_err if lo <= g[0] + 1e-9 and (g[0] < hi - 1e-9 or hi == BUCKETS[-1][1] and g[0] <= hi + 1e-9)]
        by_gap.append({"gap_s": [lo, hi], **{k: agg([g for g in sel if g[1] == k]) for k in METHODS}})
    share = {k: round(float(np.mean([r["methods"][k]["rmse_m"] < r["methods"]["linear"]["rmse_m"] for r in out])), 3)
             for k in ("kf_ca", "kf_ca_path")} if out else {}
    summ = {"tracks_occluded": len(out), "tracks_eligible": len(eligible), "seed": seed,
            "gap_s": list(gap_s), "gaps": methods["linear"]["gaps"], "gap_frames": methods["linear"]["gap_frames"],
            "context_s": CONTEXT_S, "selected_method": best, "params": params, "validation": val_rep,
            "methods": methods, "by_gap": by_gap, "better_than_linear_share": share,
            "truth": "Savitzky-Golay-smoothed NGSIM track (held out inside gaps)"}
    summ["kalman_rts"] = {k: methods["kf_ca"][k] for k in ("rmse_m", "speed_rmse")}
    summ["linear"] = {k: methods["linear"][k] for k in ("rmse_m", "speed_rmse")}
    return {"tracks": out, "summary": summ}
