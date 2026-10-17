from __future__ import annotations
import os
from math import sin
from typing import Literal
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="RoadScope AI API", version="0.1.0", description="Evidence-first road safety intelligence demo API")
cors_origins = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "*").split(",") if origin.strip()]
if os.getenv("CORS_MODE") != "lambda":
    app.add_middleware(CORSMiddleware, allow_origins=cors_origins, allow_methods=["*"], allow_headers=["*"])

class Point(BaseModel):
    t: float = Field(ge=0)
    x: float
    y: float
    speed: float = Field(ge=0)
    heading: float

class Vehicle(BaseModel):
    id: str
    type: Literal["car", "truck", "motorcycle"]
    lane: int = Field(ge=1, le=4)
    color: str
    trajectory: list[Point]

class RiskEvent(BaseModel):
    id: str
    severity: Literal["low", "medium", "high", "critical"]
    kind: Literal["hard_brake", "near_miss", "lane_change", "speeding"]
    t: float
    vehicle_ids: list[str]
    score: float = Field(ge=0, le=1)
    description: str

class DataProvenance(BaseModel):
    mode: Literal["synthetic_fixture", "observed"]
    source_label: str
    source_url: str
    method: str
    limitations: list[str]

class VehicleSample(BaseModel):
    id: str
    type: Literal["car", "truck", "motorcycle"]
    lane: int
    color: str
    point: Point

class ScenarioFrame(BaseModel):
    scenario_id: str
    t: float
    duration_s: float
    vehicles: list[VehicleSample]
    active_events: list[RiskEvent]

class Scenario(BaseModel):
    id: str
    name: str
    location: str
    duration_s: float
    sample_rate_hz: float
    vehicle_count: int
    event_count: int
    provenance: str
    data_mode: Literal["synthetic_fixture", "observed"]
    coordinate_system: str
    distance_unit: Literal["m"]
    speed_unit: Literal["mph"]
    vehicles: list[Vehicle]
    events: list[RiskEvent]

class Summary(BaseModel):
    scenario_id: str
    vehicle_count: int
    event_count: int
    risk_index: float
    avg_speed_mph: float
    max_speed_mph: float
    high_risk_events: int
    data_quality: float

class ScenarioCard(BaseModel):
    id: str
    name: str
    location: str
    duration_s: float
    vehicle_count: int
    event_count: int
    provenance: str
    data_mode: Literal["synthetic_fixture", "observed"]

class ServiceMetadata(BaseModel):
    service: str
    version: str
    data_mode: Literal["synthetic_fixture", "observed"]
    provenance: str
    provenance_detail: DataProvenance


PROVENANCE = DataProvenance(
    mode="synthetic_fixture",
    source_label="FHWA NGSIM-inspired demonstration fixture",
    source_url="https://ops.fhwa.dot.gov/trafficanalysistools/ngsim.htm",
    method="Deterministic trajectories generated in application code for interface demonstration.",
    limitations=[
        "Not observed roadway data.",
        "Not suitable for safety decisions, research conclusions, or model validation.",
        "Replace with a reviewed licensed dataset before production use.",
    ],
)


def _trajectory(vehicle_no: int, lane: int, count: int = 90) -> list[Point]:
    base = 30 * vehicle_no + 8
    pts=[]
    for i in range(count):
        t=i/10
        x=base + 4.4*t + 0.35*sin(t/2 + vehicle_no)
        y=(lane-1)*3.6 + 0.12*sin(t + vehicle_no)
        speed=max(8.0, 28 + 4*sin(t/3 + vehicle_no) - (7 if vehicle_no==2 and 4.8<t<6.2 else 0))
        pts.append(Point(t=round(t,2), x=round(x,3), y=round(y,3), speed=round(speed,2), heading=0.0))
    return pts


def scenario_data() -> Scenario:
    colors=["#5eead4","#60a5fa","#fbbf24","#f472b6","#a78bfa"]
    vehicles=[Vehicle(id=f"V-{i+1:02d}", type="truck" if i==3 else "car", lane=(i%3)+1, color=colors[i], trajectory=_trajectory(i+1,(i%3)+1)) for i in range(5)]
    events=[
        RiskEvent(id="E-001",severity="high",kind="hard_brake",t=5.4,vehicle_ids=["V-02","V-03"],score=.86,description="Abrupt deceleration with short following gap"),
        RiskEvent(id="E-002",severity="medium",kind="lane_change",t=6.8,vehicle_ids=["V-04"],score=.54,description="Unsignalled lane transition"),
        RiskEvent(id="E-003",severity="critical",kind="near_miss",t=7.9,vehicle_ids=["V-02","V-05"],score=.94,description="Predicted time-to-collision below threshold"),
    ]
    return Scenario(id="ngsim-i80-demo",name="I-80 merge · evidence replay",location="Emeryville, CA",duration_s=8.9,sample_rate_hz=10,vehicle_count=len(vehicles),event_count=len(events),provenance="FHWA NGSIM-inspired synthetic fixture; replace with licensed source before production",data_mode="synthetic_fixture",coordinate_system="local road-aligned Cartesian coordinates",distance_unit="m",speed_unit="mph",vehicles=vehicles,events=events)

SCENARIO=scenario_data()

@app.get("/health")
def health(): return {"status":"ok","service":"roadscope-api","version":app.version}

@app.get("/", response_model=ServiceMetadata)
def metadata():
    return ServiceMetadata(service="roadscope-api", version=app.version,
        data_mode="synthetic_fixture", provenance=SCENARIO.provenance,
        provenance_detail=PROVENANCE)

@app.get("/api/v1/scenarios", response_model=list[ScenarioCard])
def scenarios():
    return [ScenarioCard(id=SCENARIO.id,name=SCENARIO.name,location=SCENARIO.location,
        duration_s=SCENARIO.duration_s,vehicle_count=SCENARIO.vehicle_count,
        event_count=SCENARIO.event_count,provenance=SCENARIO.provenance,
        data_mode=SCENARIO.data_mode)]

@app.get("/api/v1/scenarios/{scenario_id}", response_model=Scenario)
def scenario(scenario_id: str):
    if scenario_id != SCENARIO.id: raise HTTPException(404,"Scenario not found")
    return SCENARIO

@app.get("/api/v1/scenarios/{scenario_id}/summary", response_model=Summary)
def summary(scenario_id: str):
    if scenario_id != SCENARIO.id: raise HTTPException(404,"Scenario not found")
    speeds=[p.speed for v in SCENARIO.vehicles for p in v.trajectory]
    high_risk=sum(event.severity in {"high", "critical"} for event in SCENARIO.events)
    risk_index=round(sum(event.score for event in SCENARIO.events)/len(SCENARIO.events), 2)
    return Summary(scenario_id=scenario_id,vehicle_count=SCENARIO.vehicle_count,event_count=SCENARIO.event_count,risk_index=risk_index,avg_speed_mph=round(sum(speeds)/len(speeds),1),max_speed_mph=round(max(speeds),1),high_risk_events=high_risk,data_quality=.98)

@app.get("/api/v1/scenarios/{scenario_id}/events", response_model=list[RiskEvent])
def events(scenario_id: str, severity: str|None=Query(default=None)):
    if scenario_id != SCENARIO.id: raise HTTPException(404,"Scenario not found")
    allowed={"low","medium","high","critical"}
    if severity is not None and severity not in allowed:
        raise HTTPException(422, "severity must be low, medium, high, or critical")
    return [e for e in SCENARIO.events if severity is None or e.severity == severity]

@app.get("/api/v1/scenarios/{scenario_id}/vehicles", response_model=list[Vehicle])
def vehicles(scenario_id: str, stride: int = Query(default=1, ge=1, le=10)):
    if scenario_id != SCENARIO.id: raise HTTPException(404,"Scenario not found")
    return [vehicle.model_copy(update={"trajectory": vehicle.trajectory[::stride]}) for vehicle in SCENARIO.vehicles]

@app.get("/api/v1/scenarios/{scenario_id}/frame", response_model=ScenarioFrame)
def frame(scenario_id: str, t: float = Query(ge=0)):
    if scenario_id != SCENARIO.id: raise HTTPException(404,"Scenario not found")
    clamped=min(t, SCENARIO.duration_s)
    index=min(round(clamped * SCENARIO.sample_rate_hz), len(SCENARIO.vehicles[0].trajectory)-1)
    samples=[VehicleSample(id=vehicle.id,type=vehicle.type,lane=vehicle.lane,color=vehicle.color,point=vehicle.trajectory[index]) for vehicle in SCENARIO.vehicles]
    active=[event for event in SCENARIO.events if abs(event.t-clamped) <= .5]
    return ScenarioFrame(scenario_id=scenario_id,t=round(clamped,2),duration_s=SCENARIO.duration_s,vehicles=samples,active_events=active)
