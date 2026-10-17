"""HSM Part B screening formulas and the Negative Binomial SPF + Empirical Bayes."""
from __future__ import annotations

import math

import numpy as np

K_95 = 1.645
EPDO_WEIGHTS = {"K": 542, "A": 542, "B": 11, "C": 6, "O": 1}  # FHWA 2005 comprehensive-cost ratios


def exposure_100mvmt(aadt: float, length_mi: float, years: float) -> float:
    """Vehicle exposure M in 100 million vehicle-miles."""
    return 365.0 * years * aadt * length_mi / 1e8


def crash_rate(n: float, aadt: float, length_mi: float, years: float) -> float:
    """R = N·10^8 / (365·Y·AADT·L), crashes per 100 MVMT."""
    return n / exposure_100mvmt(aadt, length_mi, years)


def critical_rate(ra: float, m: float, k: float = K_95) -> float:
    """Rc = Ra + k·sqrt(Ra/M) + 1/(2M)."""
    return ra + k * math.sqrt(ra / m) + 1.0 / (2.0 * m)


def epdo(counts: dict) -> float:
    return sum(EPDO_WEIGHTS[s] * n for s, n in counts.items())


def eb_expected(mu: float, n_obs: float, k: float) -> float:
    """HSM EB: w = 1/(1+k·μ), E = w·μ + (1−w)·N (μ and N over the same period)."""
    w = 1.0 / (1.0 + k * mu)
    return w * mu + (1.0 - w) * n_obs


def fit_nb(n: np.ndarray, aadt: np.ndarray, length_mi: np.ndarray, years: float) -> dict:
    """ln μ = b0 + b1·ln AADT + ln L (+ ln Y offset so b0 is per year).

    Overdispersion α (=k) by maximum likelihood (statsmodels discrete NB2), then the
    GLM NegativeBinomial is refit at that α for the reported deviance/AIC.
    """
    import statsmodels.api as sm  # local import: not available on the ingest Lambda

    X = sm.add_constant(np.log(aadt))
    offset = np.log(length_mi) + math.log(years)
    mle = sm.NegativeBinomial(n, X, offset=offset, loglike_method="nb2").fit(disp=0, maxiter=200)
    b0, b1, alpha = (float(v) for v in mle.params)
    glm = sm.GLM(n, X, family=sm.families.NegativeBinomial(alpha=alpha), offset=offset).fit()
    return {
        "b0": float(glm.params[0]), "b1": float(glm.params[1]), "k": alpha,
        "se_b0": float(glm.bse[0]), "se_b1": float(glm.bse[1]),
        "n": int(len(n)), "crashes": int(n.sum()), "aic": float(mle.aic),
        "loglik": float(mle.llf), "converged": bool(mle.mle_retvals.get("converged", True)),
    }


def predict(spf: dict, aadt: float, length_mi: float) -> float:
    """Predicted crashes per year: exp(b0)·AADT^b1·L."""
    return math.exp(spf["b0"]) * aadt ** spf["b1"] * length_mi
