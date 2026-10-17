"""Network, screening, SPF, corridor, VRU and fatal-crash routes."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response

from .. import queries, store
from ..http import cached, load_or_404
from ..models import Corridor, CorridorSummary, FeatureCollection, Manifest, Screening, Spf, VruSummary

router = APIRouter()
Metric = Literal["crashes_total", "rate_100mvmt", "crit_ratio", "epdo", "eb_excess", "aadt", "spf_pred", "eb_expected"]


@router.get("/meta", response_model=Manifest)
def meta(request: Request) -> Response:
    return cached(request, Manifest, load_or_404(store.load, "manifest.json", what="Manifest"))


@router.get("/network", response_model=FeatureCollection)
def network(request: Request, metric: Metric | None = None) -> Response:
    return cached(request, FeatureCollection, load_or_404(queries.network, metric, what="Network"))


@router.get("/screening", response_model=Screening)
def screening(
    request: Request,
    method: queries.ScreeningMethod = "eb_excess",
    limit: int = Query(25, ge=1, le=1000),
    f_system: int | None = Query(None, ge=1, le=7),
) -> Response:
    return cached(request, Screening, load_or_404(queries.screening, method, limit, f_system, what="Network"))


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
    mode: Literal["ped", "bike"] | None = None,
    severity: str | None = Query(None, pattern=r"^[KABCOkabco](,[KABCOkabco])*$", description="KABCO, comma list"),
    year: int | None = Query(None, ge=2000, le=2100),
) -> Response:
    return cached(request, FeatureCollection, load_or_404(queries.vru, mode, severity, year, what="VRU crashes"))


@router.get("/vru/summary", response_model=VruSummary)
def vru_summary(request: Request) -> Response:
    return cached(request, VruSummary, load_or_404(queries.vru_summary, what="VRU crashes"))


@router.get("/fatal", response_model=FeatureCollection)
def fatal(request: Request) -> Response:
    return cached(request, FeatureCollection, load_or_404(store.load, "fatal_crashes.geojson", what="Fatal crashes"))
