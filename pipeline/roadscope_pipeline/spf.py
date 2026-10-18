"""HSM Part B screening formulas, Negative Binomial SPFs, Empirical Bayes and SPF diagnostics.

Everything except :func:`fit_nb` is plain numpy/math so the ingest Lambda (no scipy or
statsmodels) can apply stored SPFs, recompute EB and the goodness-of-fit diagnostics.

SPF form (per site type)::

    ln μ = b0 + Σ_j b_j·x_j + ln L          μ: crashes per year, L: miles

Overdispersion follows the HSM Part C convention for roadway segments: the parameter is
estimated *per mile* and applied as k_seg = k / L (so Var(N) = μ + (k/L)·μ²). The TxDOT segment
results are one-mile segments (L = 1.00 ± 0.05 for all but the route-end remainders), so k_seg ≈ k.
"""
from __future__ import annotations

import math

import numpy as np

K_95 = 1.645

# Covariates a site-type SPF may use; values are read from a segment dict.
COVARIATES = {
    "ln_aadt": lambda s: math.log(s["aadt"]) if s.get("aadt") else None,
    "lanes": lambda s: s.get("lanes"),
    "divided": lambda s: None if s.get("divided") is None else float(s["divided"]),
    "speed": lambda s: s.get("speed_limit"),
    "urban": lambda s: None if s.get("urban") is None else float(s["urban"]),
}


# ---------- HSM Part B ----------
def exposure_100mvmt(aadt: float, length_mi: float, years: float) -> float:
    """Vehicle exposure M in 100 million vehicle-miles."""
    return 365.0 * years * aadt * length_mi / 1e8


def crash_rate(n: float, aadt: float, length_mi: float, years: float) -> float:
    """R = N·10^8 / (365·Y·AADT·L), crashes per 100 MVMT."""
    return n / exposure_100mvmt(aadt, length_mi, years)


def critical_rate(ra: float, m: float, k: float = K_95) -> float:
    """Rc = Ra + k·sqrt(Ra/M) + 1/(2M)."""
    return ra + k * math.sqrt(ra / m) + 1.0 / (2.0 * m)


def k_segment(k_per_mi: float, length_mi: float) -> float:
    """HSM segment convention: overdispersion of a segment of length L is k/L."""
    return k_per_mi / length_mi


def eb_expected(mu: float, n_obs: float, k: float) -> float:
    """HSM EB: w = 1/(1+k·μ), E = w·μ + (1−w)·N.

    μ and N are over the same study period; ``k`` is the overdispersion of *this* site
    (for a segment pass k_segment(k_per_mi, L)).
    """
    w = 1.0 / (1.0 + k * mu)
    return w * mu + (1.0 - w) * n_obs


# ---------- SPF evaluation (numpy only) ----------
def covariate_row(seg: dict, names) -> list | None:
    vals = [COVARIATES[n](seg) for n in names]
    return None if any(v is None for v in vals) else [float(v) for v in vals]


def predict(spf: dict, aadt: float, length_mi: float, **covs) -> float:
    """Predicted crashes per year.

    ``spf`` is either a site-type model ({"coef": {"const":…, "ln_aadt":…, …}}) or the
    legacy pooled form {"b0", "b1"} (μ = exp(b0)·AADT^b1·L).
    """
    if "coef" not in spf:
        return math.exp(spf["b0"]) * aadt ** spf["b1"] * length_mi
    x = {"ln_aadt": math.log(aadt), **covs}
    eta = spf["coef"]["const"] + sum(b * float(x[n]) for n, b in spf["coef"].items() if n != "const")
    return math.exp(eta) * length_mi


def predict_seg(spf: dict, seg: dict) -> float | None:
    names = [n for n in spf["coef"] if n != "const"]
    row = covariate_row(seg, names)
    if row is None or not seg.get("len_mi"):
        return None
    return predict(spf, seg["aadt"], seg["len_mi"], **dict(zip(names, row)))


def gof(y, mu, alpha, n_params: int) -> dict:
    """MAD and Pearson χ²/df under the NB2 variance μ + α·μ² (α per site)."""
    y, mu, alpha = (np.asarray(v, float) for v in (y, mu, alpha))
    resid = y - mu
    chi2 = float(np.sum(resid**2 / (mu + alpha * mu**2)))
    df = max(len(y) - n_params, 1)
    return {"mad": float(np.mean(np.abs(resid))), "pearson_chi2": chi2, "df": int(df), "chi2_df": chi2 / df}


def cure(x, y, mu) -> dict:
    """CURE plot (Hauer & Bamfo 1997): cumulative residuals ordered by x with ±2σ* limits.

    σ²(i) = Σ_{j≤i} e_j²;  σ*(i) = σ(i)·sqrt(1 − σ²(i)/σ²(n)).  Under a well-specified model
    the cumulative residual random-walks inside ±2σ* (≈95%).
    """
    x, y, mu = (np.asarray(v, float) for v in (x, y, mu))
    o = np.argsort(x, kind="stable")
    e = (y - mu)[o]
    cum = np.cumsum(e)
    s2 = np.cumsum(e**2)
    tot = s2[-1] if len(s2) else 0.0
    sig_star = np.sqrt(np.clip(s2 * (1.0 - s2 / tot), 0.0, None)) if tot > 0 else np.zeros_like(s2)
    bound = 2.0 * sig_star
    outside = int(np.sum(np.abs(cum) > bound + 1e-12)) if len(cum) else 0
    return {
        "x": "aadt",
        "points": [[int(round(float(a))), round(float(c), 3), round(float(b), 3)] for a, c, b in zip(x[o], cum, bound)],
        "columns": ["aadt", "cum_residual", "two_sigma_star"],
        "pct_outside": round(100.0 * outside / len(cum), 1) if len(cum) else None,
        "max_abs_cum": round(float(np.max(np.abs(cum))), 4) if len(cum) else None,
    }


# ---------- estimation (scipy/statsmodels; batch worker only) ----------
def _nb_negll(theta, y, X, offset, inv_len, k_per_mile):
    from scipy.special import gammaln

    beta, lnk = theta[:-1], theta[-1]
    mu = np.exp(np.clip(X @ beta + offset, -30, 30))
    alpha = math.exp(lnk) * (inv_len if k_per_mile else 1.0)
    r = 1.0 / alpha
    ll = gammaln(y + r) - gammaln(r) - gammaln(y + 1) + r * np.log(r / (r + mu)) + y * np.log(mu / (r + mu))
    return -float(np.sum(ll))


def fit_nb(y, X, names, length_mi, years: float, k_per_mile: bool = True, lnk_bounds=(-12.0, 6.0)) -> dict:
    """NB2 maximum likelihood with offset ln L + ln Y (so the intercept is per year).

    ``X``: n×p covariate matrix (no constant column; one is added), ``names`` its column names.
    k_per_mile=True: α_i = k / L_i (HSM segment convention); False: α_i = k.
    Standard errors from the inverse numerical Hessian of the log-likelihood. If k hits the
    lower bound the data show no extra-Poisson variation; SEs are then for β at fixed k.
    """
    from scipy.optimize import minimize
    from statsmodels.tools.numdiff import approx_hess3

    y = np.asarray(y, float)
    L = np.asarray(length_mi, float)
    Xc = np.column_stack([np.ones(len(y)), np.asarray(X, float).reshape(len(y), -1)])
    offset = np.log(L) + math.log(years)
    inv_len = 1.0 / L
    # Poisson start values via a few IRLS steps
    beta = np.zeros(Xc.shape[1])
    beta[0] = math.log(max(y.sum(), 0.5) / np.exp(offset).sum())
    for _ in range(25):
        mu = np.exp(np.clip(Xc @ beta + offset, -30, 30))
        z = Xc @ beta + (y - mu) / mu
        W = mu
        try:
            beta = np.linalg.solve(Xc.T @ (W[:, None] * Xc) + 1e-8 * np.eye(len(beta)), Xc.T @ (W * z))
        except np.linalg.LinAlgError:
            break
    best = None
    for lnk0 in (0.0, -2.0, 1.5):
        res = minimize(_nb_negll, np.r_[beta, lnk0], args=(y, Xc, offset, inv_len, k_per_mile), method="L-BFGS-B",
                       bounds=[(None, None)] * len(beta) + [lnk_bounds], options={"maxiter": 5000, "ftol": 1e-14, "gtol": 1e-9})
        if best is None or res.fun < best.fun:
            best = res
    theta = best.x
    at_bound = theta[-1] <= lnk_bounds[0] + 1e-3
    f = lambda t: -_nb_negll(t, y, Xc, offset, inv_len, k_per_mile)
    if at_bound:
        H = approx_hess3(theta[:-1], lambda b: f(np.r_[b, theta[-1]]))
        cov_b = np.linalg.pinv(-H)
        se_lnk = float("nan")
    else:
        H = approx_hess3(theta, f)
        cov = np.linalg.pinv(-H)
        cov_b, se_lnk = cov[:-1, :-1], float(math.sqrt(max(cov[-1, -1], 0.0)))
    se = np.sqrt(np.clip(np.diag(cov_b), 0.0, None))
    k = math.exp(theta[-1])
    ll = -float(best.fun)
    p = len(theta)
    cols = ["const", *names]
    return {
        "coef": {c: float(b) for c, b in zip(cols, theta[:-1])},
        "se": {c: float(s) for c, s in zip(cols, se)},
        "k": k, "se_k": k * se_lnk if math.isfinite(se_lnk) else None, "k_at_lower_bound": bool(at_bound),
        "k_convention": "per mile (k_seg = k/L)" if k_per_mile else "per segment (constant)",
        "n": int(len(y)), "crashes": int(y.sum()), "n_params": p,
        "loglik": ll, "aic": 2 * p - 2 * ll, "converged": bool(best.success),
    }
