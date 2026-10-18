"""NGSIM intersection trajectories, surrogate-safety conflicts and occlusion repair."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Path, Query, Request, Response

from .. import queries, store
from ..http import cached, load_or_404
from ..models import Conflict, Intersection, IntersectionIndexItem, Repair

router = APIRouter(prefix="/intersections")
Id = Path(..., pattern=r"^[A-Za-z0-9_-]+$")


@router.get("", response_model=list[IntersectionIndexItem])
def index(request: Request) -> Response:
    return cached(request, list[IntersectionIndexItem], queries.intersections_index())


@router.get("/{iid}", response_model=Intersection)
def detail(
    request: Request,
    iid: str = Id,
    t0: float | None = None,
    t1: float | None = None,
    stride: int = Query(1, ge=1, le=100),
) -> Response:
    if t0 is not None and t1 is not None and t1 < t0:
        raise HTTPException(422, "t1 must be greater than or equal to t0")
    data = load_or_404(queries.sliced_intersection, iid, t0, t1, stride, what=f"Intersection '{iid}'")
    return cached(request, Intersection, data)


@router.get("/{iid}/conflicts", response_model=list[Conflict])
def conflicts(
    request: Request,
    iid: str = Id,
    type: Literal["rear_end", "crossing", "lane_change", "pedestrian", "yield"] | None = None,
    max_ttc: float | None = Query(None, gt=0, le=60),
) -> Response:
    rows = load_or_404(queries.conflicts, iid, type, max_ttc, what=f"Conflicts for intersection '{iid}'")
    return cached(request, list[Conflict], rows)


@router.get("/{iid}/repair", response_model=Repair)
def repair(request: Request, iid: str = Id) -> Response:
    data = load_or_404(store.load, f"intersections/{iid}_repair.json", what=f"Repair results for intersection '{iid}'")
    return cached(request, Repair, data)


@router.get("/{iid}/ssm")
def ssm(request: Request, iid: str = Id) -> Response:
    """Detection rules with citations, threshold sensitivity table and TTC–DRAC scatter."""
    data = load_or_404(store.load, f"intersections/{iid}_ssm.json", what=f"SSM summary for intersection '{iid}'")
    return cached(request, dict, data)
