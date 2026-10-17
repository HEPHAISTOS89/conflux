"""Pure query functions over curated data, shared by the HTTP routers and the /ask tools."""
from __future__ import annotations

from collections import Counter
from typing import Any, Literal

from . import store

ScreeningMethod = Literal["frequency", "rate", "critical_ratio", "epdo", "eb_excess"]
METHOD_FIELD: dict[str, str] = {
    "frequency": "crashes_total",
    "rate": "rate_100mvmt",
    "critical_ratio": "crit_ratio",
    "epdo": "epdo",
    "eb_excess": "eb_excess",
}
NETWORK_METRICS = ("crashes_total", "rate_100mvmt", "crit_ratio", "epdo", "eb_excess", "aadt", "spf_pred", "eb_expected")
SEVERITIES = ("K", "A", "B", "C", "O")


def _num(v: Any) -> float:
    return float(v) if isinstance(v, (int, float)) else float("-inf")


def network(metric: str | None = None) -> dict[str, Any]:
    fc = store.load("network.geojson")
    if metric is None:
        return fc
    feats = [{**f, "properties": {**f["properties"], "value": f["properties"].get(metric)}} for f in fc["features"]]
    return {**fc, "metric": metric, "features": feats}


def screening(method: str = "eb_excess", limit: int = 25, f_system: int | None = None) -> dict[str, Any]:
    field = METHOD_FIELD[method]
    rows = [f["properties"] for f in store.load("network.geojson")["features"]]
    if f_system is not None:
        rows = [r for r in rows if r.get("f_system") == f_system]
    rows = sorted(rows, key=lambda r: _num(r.get(field)), reverse=True)
    items = [{**r, "screen_rank": i + 1, "score": r.get(field)} for i, r in enumerate(rows[:limit])]
    return {"method": method, "field": field, "f_system": f_system, "total": len(rows), "items": items}


def corridor(corridor_id: str) -> dict[str, Any] | None:
    key = corridor_id.lower()
    for c in store.load("corridors.json"):
        if str(c["id"]).lower() == key:
            return c
    return None


def vru(mode: str | None = None, severity: str | None = None, year: int | None = None) -> dict[str, Any]:
    fc = store.load("vru_crashes.geojson")
    feats = fc["features"]
    if mode:
        feats = [f for f in feats if f["properties"].get("mode") == mode]
    if severity:
        sev = set(severity.upper().split(","))
        feats = [f for f in feats if f["properties"].get("severity") in sev]
    if year is not None:
        feats = [f for f in feats if f["properties"].get("year") == year]
    return {**fc, "features": feats}


def vru_summary() -> dict[str, Any]:
    props = [f["properties"] for f in store.load("vru_crashes.geojson")["features"]]
    heat = [[0] * 24 for _ in range(7)]
    for p in props:
        h, d = p.get("hour"), p.get("dow")
        if isinstance(h, int) and isinstance(d, int) and 0 <= h < 24 and 0 <= d < 7:
            heat[d][h] += 1
    years = [p["year"] for p in props if isinstance(p.get("year"), int)]
    return {
        "total": len(props),
        "years": [min(years), max(years)] if years else [],
        "by_severity": {s: sum(1 for p in props if p.get("severity") == s) for s in SEVERITIES},
        "by_mode": dict(Counter(p.get("mode") for p in props if p.get("mode"))),
        "by_year": {str(k): v for k, v in sorted(Counter(years).items())},
        "by_light": dict(Counter(p.get("light") for p in props if p.get("light")).most_common()),
        "by_pbcat": dict(Counter(p.get("pbcat") for p in props if p.get("pbcat")).most_common(10)),
        "top_streets": dict(Counter(p.get("street") for p in props if p.get("street")).most_common(10)),
        "ka_total": sum(1 for p in props if p.get("severity") in ("K", "A")),
        "hour_dow": heat,
    }


def intersection(iid: str) -> dict[str, Any]:
    return store.load(f"intersections/{iid}.json")


def sliced_intersection(iid: str, t0: float | None, t1: float | None, stride: int) -> dict[str, Any]:
    data = intersection(iid)
    tracks = []
    for tr in data["tracks"]:
        pts = [p for p in tr["pts"] if (t0 is None or p[0] >= t0) and (t1 is None or p[0] <= t1)][::stride]
        if pts:
            tracks.append({**tr, "pts": pts})
    return {**data, "t0": t0, "t1": t1, "stride": stride, "tracks": tracks}


def conflicts(iid: str, ctype: str | None = None, max_ttc: float | None = None) -> list[dict[str, Any]]:
    rows = store.load(f"intersections/{iid}_conflicts.json")
    if ctype:
        rows = [r for r in rows if r.get("type") == ctype]
    if max_ttc is not None:
        rows = [r for r in rows if isinstance(r.get("ttc_min"), (int, float)) and r["ttc_min"] <= max_ttc]
    return rows


def intersections_index() -> list[dict[str, Any]]:
    out = []
    for iid in store.intersection_ids():
        d = intersection(iid)
        ts = [p[0] for tr in d["tracks"] for p in tr["pts"]]
        try:
            n_conf: int | None = len(store.load(f"intersections/{iid}_conflicts.json"))
        except store.MissingData:
            n_conf = None
        out.append({"id": d["id"], "name": d["name"], "source": d["source"], "hz": d["hz"], "bbox": d["bbox"],
                    "n_tracks": len(d["tracks"]), "t_start": min(ts) if ts else None,
                    "t_end": max(ts) if ts else None, "n_conflicts": n_conf})
    return out
