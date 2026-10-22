"""Network, screening, SPF, corridor, VRU and fatal-crash routes."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response

from .. import queries, store
from ..http import cached, load_or_404
from ..models import Corridor, CorridorSummary, FeatureCollection, Manifest, Screening, Spf, VruSummary

router = APIRouter()
Metric = Literal["crashes_total", "rate_100mvmt", "crit_ratio", "epdo", "eb_excess", "aadt", "spf_pred", "eb_expected"]
County = Query(None, pattern=r"^[A-Za-z][A-Za-z -]{0,30}$|^\d{1,3}$",
               description="County of the SPAG region: slug ('hale'), name or TxDOT county number; omit for the whole region")


def county_or_404(fn, *args, what: str):
    try:
        return load_or_404(fn, *args, what=what)
    except queries.UnknownCounty as exc:
        raise HTTPException(404, f"Unknown county '{exc.args[0]}'; see /api/v1/counties for the fifteen SPAG counties") from exc


@router.get("/counties", response_model=FeatureCollection)
def counties(request: Request) -> Response:
    """The fifteen SPAG counties: simplified TxDOT boundary polygons with per-county roll-ups in properties."""
    return cached(request, FeatureCollection, load_or_404(queries.counties, what="Counties"))


@router.get("/meta", response_model=Manifest)
def meta(request: Request) -> Response:
    return cached(request, Manifest, load_or_404(store.load, "manifest.json", what="Manifest"))


@router.get("/network", response_model=FeatureCollection)
def network(request: Request, metric: Metric | None = None, county: str | None = County) -> Response:
    return cached(request, FeatureCollection, county_or_404(queries.network, metric, county, what="Network"))


@router.get("/screening", response_model=Screening)
def screening(
    request: Request,
    method: queries.ScreeningMethod = "eb_excess",
    limit: int = Query(25, ge=1, le=5000),
    f_system: int | None = Query(None, ge=1, le=7),
    county: str | None = County,
) -> Response:
    return cached(request, Screening, county_or_404(queries.screening, method, limit, f_system, county, what="Network"))


@router.get("/spf", response_model=Spf)
def spf(request: Request) -> Response:
    return cached(request, Spf, load_or_404(store.load, "spf.json", what="SPF"))


@router.get("/corridors", response_model=list[CorridorSummary])
def corridors(request: Request) -> Response:
    rows = load_or_404(store.load, "corridors.json", what="Corridors")
    out = [{k: v for k, v in c.items() if k != "stations"} | {"n_stations": len(c["stations"])} for c in rows]
    return cached(request, list[CorridorSummary], out)


@router.get("/corridors/{corridor_id}", response_model=Corridor)
def corridor(request: Request, corridor_id: str) -> Response:
    c = load_or_404(queries.corridor, corridor_id, what="Corridors")
    if c is None:
        raise HTTPException(404, f"Corridor '{corridor_id}' not found; see /api/v1/corridors for valid ids")
    return cached(request, Corridor, c)


@router.get("/vru", response_model=FeatureCollection)
def vru(
    request: Request,
    mode: Literal["ped", "bike", "scooter"] | None = None,
    severity: str | None = Query(None, pattern=r"^[KABCOkabco](,[KABCOkabco])*$", description="KABCO, comma list"),
    year: int | None = Query(None, ge=2000, le=2100),
    county: str | None = County,
) -> Response:
    return cached(request, FeatureCollection, county_or_404(queries.vru, mode, severity, year, county, what="VRU crashes"))


@router.get("/vru/summary", response_model=VruSummary)
def vru_summary(request: Request, county: str | None = County) -> Response:
    return cached(request, VruSummary, county_or_404(queries.vru_summary, county, what="VRU crashes"))


@router.get("/fatal", response_model=FeatureCollection)
def fatal(request: Request, county: str | None = County) -> Response:
    return cached(request, FeatureCollection, county_or_404(queries.fatal, county, what="Fatal crashes"))
