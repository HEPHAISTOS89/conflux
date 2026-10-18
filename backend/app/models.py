"""Pydantic response models mirroring the curated data contract (docs/SPEC.md)."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


class Open(BaseModel):
    model_config = ConfigDict(extra="allow")


class Feature(Open):
    type: Literal["Feature"]
    geometry: dict[str, Any] | None
    properties: dict[str, Any]


class FeatureCollection(Open):
    type: Literal["FeatureCollection"]
    features: list[Feature]


class Health(BaseModel):
    status: str
    version: str
    data_source: str


class Source(Open):
    id: str
    url: str | None = None
    licence: str | None = None
    records: int | None = None
    fetched_at: str | None = None
    sha256: str | None = None


class Manifest(Open):
    generated_at: str
    sources: list[Source]
    metrics: dict[str, Any] = {}


class Segment(Open):
    seg_id: str | int
    route: str | None = None
    name: str | None = None
    f_system: int | None = None
    lanes: float | None = None
    speed_limit: float | None = None
    aadt: float | None = None
    truck_pct: float | None = None
    len_mi: float
    crashes_total: float
    crash_years: float | None = None
    rate_100mvmt: float | None = None
    crit_rate: float | None = None
    crit_ratio: float | None = None
    epdo: float | None = None
    spf_pred: float | None = None
    eb_expected: float | None = None
    eb_excess: float | None = None
    rank: int | None = None
    screen_rank: int
    score: float | None = None


class Screening(BaseModel):
    method: str
    field: str
    f_system: int | None
    total: int
    items: list[Segment]
    unscreened: dict[str, Any] = {}


class Spf(Open):
    form: str
    b0: float
    b1: float
    k: float
    n: int
    aic: float | None = None
    by_class: dict[str, Any] = {}


class Station(Open):
    dfo: float


class Corridor(Open):
    id: str
    name: str
    routes: list[str]
    len_mi: float
    stations: list[Station]
    summary: dict[str, Any] = {}


class CorridorSummary(Open):
    id: str
    name: str
    routes: list[str]
    len_mi: float
    n_stations: int
    summary: dict[str, Any] = {}


class VruSummary(BaseModel):
    total: int
    years: list[int]
    by_severity: dict[str, int]
    by_mode: dict[str, int]
    by_year: dict[str, int]
    by_light: dict[str, int]
    by_pbcat: dict[str, int]
    top_streets: dict[str, int]
    ka_total: int
    on_system: dict[str, int] = {}
    severity_by_condition: list[dict[str, Any]] = []
    hour_dow: list[list[int]]


class IntersectionIndexItem(BaseModel):
    id: str
    name: str
    source: Any
    hz: float
    bbox: list[Any]
    n_tracks: int
    t_start: float | None
    t_end: float | None
    n_conflicts: int | None


class Track(Open):
    id: str | int
    cls: str
    len_m: float | None = None
    w_m: float | None = None
    pts: list[list[Any]]


class Intersection(Open):
    id: str
    name: str
    source: Any
    hz: float
    bbox: list[Any]
    lanes_geom: Any = None
    tracks: list[Track]
    t0: float | None = None
    t1: float | None = None
    stride: int = 1


class Conflict(Open):
    id: str | int
    t: float
    a: str | int
    b: str | int
    type: Literal["rear_end", "crossing", "lane_change", "pedestrian", "yield"]
    ttc_min: float | None = None
    pet: float | None = None
    drac_max: float | None = None
    severity: Any = None


class RepairTrack(Open):
    id: str | int
    gaps: list[list[float]]
    raw: list[list[float]]
    repaired: list[list[float]]
    rmse_m: float | None = None
    speed_rmse: float | None = None


class Repair(Open):
    tracks: list[RepairTrack]
    summary: dict[str, Any] = {}


class AskRequest(BaseModel):
    question: str


class ToolCall(BaseModel):
    name: str
    input: dict[str, Any]
    ok: bool


class AskResponse(BaseModel):
    answer: str
    citations: list[str]
    tool_calls: list[ToolCall]
    model: str
    fallback: bool


class PlatformStatus(BaseModel):
    on_aws: bool
    data_source: str
    manifest: dict[str, Any] | None
    runs: list[dict[str, Any]]
    metrics: dict[str, Any] | None
    errors: list[str]
