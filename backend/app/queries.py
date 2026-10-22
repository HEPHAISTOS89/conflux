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


# ---------- region / county dimension ----------
class UnknownCounty(LookupError):
    """The county filter names no county of the study region."""


def counties() -> dict[str, Any]:
    """County polygons with per-county roll-ups (curated/counties.geojson), ordered by name."""
    fc = store.load("counties.geojson")
    return {**fc, "features": sorted(fc["features"], key=lambda f: f["properties"]["name"])}


def county_list() -> list[dict[str, Any]]:
    return [f["properties"] for f in counties()["features"]]


def resolve_county(county: str | None) -> dict[str, Any] | None:
    """Accept a county slug ('hale'), name ('Hale') or TxDOT county number ('96'); None = whole region."""
    if county is None or county.strip() == "" or county.strip().lower() in ("all", "spag", "region"):
        return None
    key = county.strip().lower()
    for c in county_list():
        if key in (c["id"], c["name"].lower(), str(c.get("county_nbr"))):
            return c
    raise UnknownCounty(county)


def in_county(props: dict[str, Any], c: dict[str, Any] | None) -> bool:
    return c is None or props.get("county_id") == c["id"] or props.get("county_nbr") == c.get("county_nbr")


def _county_fields(c: dict[str, Any] | None) -> dict[str, Any]:
    return {"county": c["id"] if c else None, "county_name": c["name"] if c else None}


def network(metric: str | None = None, county: str | None = None) -> dict[str, Any]:
    fc = store.load("network.geojson")
    c = resolve_county(county)
    feats = [f for f in fc["features"] if in_county(f["properties"], c)]
    if metric is not None:
        feats = [{**f, "properties": {**f["properties"], "value": f["properties"].get(metric)}} for f in feats]
    return {**fc, "metric": metric, **_county_fields(c), "features": feats}


def screening(method: str = "eb_excess", limit: int = 25, f_system: int | None = None, county: str | None = None) -> dict[str, Any]:
    """Rank the screened population under one HSM Part B measure.

    The population is the same for every measure: segments the pipeline could score (``rank`` set,
    i.e. AADT and a site type joined). Unscored segments (no inventory/AADT match) are reported in
    ``unscreened`` instead of being ranked last, so counts and "of N" figures agree across measures
    and pages. Ties keep the EB rank order (stable sort on the EB-ranked list).

    ``county`` subsets the region (SPFs, EB and critical rates stay those of the regional population;
    only the ranking is restricted, so a county rank is a position within that county).
    """
    field = METHOD_FIELD[method]
    c = resolve_county(county)
    allrows = [f["properties"] for f in store.load("network.geojson")["features"] if in_county(f["properties"], c)]
    if f_system is not None:
        allrows = [r for r in allrows if r.get("f_system") == f_system]
    rows = sorted((r for r in allrows if r.get("rank") is not None), key=lambda r: r["rank"])
    out = [r for r in allrows if r.get("rank") is None]
    rows = sorted(rows, key=lambda r: _num(r.get(field)), reverse=True)
    items = [{**r, "screen_rank": i + 1, "score": r.get(field)} for i, r in enumerate(rows[:limit])]
    return {"method": method, "field": field, "f_system": f_system, **_county_fields(c), "total": len(rows), "items": items,
            "unscreened": {"segments": len(out), "crashes": sum(int(r.get("crashes_total") or 0) for r in out),
                           "reason": "no Roadway Inventory / AADT match (no site type or exposure)"}}


def corridor(corridor_id: str) -> dict[str, Any] | None:
    key = corridor_id.lower()
    for c in store.load("corridors.json"):
        if str(c["id"]).lower() == key:
            return c
    return None


def vru(mode: str | None = None, severity: str | None = None, year: int | None = None, county: str | None = None) -> dict[str, Any]:
    fc = store.load("vru_crashes.geojson")
    c = resolve_county(county)
    feats = [f for f in fc["features"] if in_county(f["properties"], c)]
    if mode:
        feats = [f for f in feats if f["properties"].get("mode") == mode]
    if severity:
        sev = set(severity.upper().split(","))
        feats = [f for f in feats if f["properties"].get("severity") in sev]
    if year is not None:
        feats = [f for f in feats if f["properties"].get("year") == year]
    return {**fc, **_county_fields(c), "features": feats}


def vru_summary(county: str | None = None) -> dict[str, Any]:
    c = resolve_county(county)
    props = [f["properties"] for f in store.load("vru_crashes.geojson")["features"] if in_county(f["properties"], c)]
    heat = [[0] * 24 for _ in range(7)]
    for p in props:
        h, d = p.get("hour"), p.get("dow")
        if isinstance(h, int) and isinstance(d, int) and 0 <= h < 24 and 0 <= d < 7:
            heat[d][h] += 1
    years = [p["year"] for p in props if isinstance(p.get("year"), int)]
    return {
        **_county_fields(c),
        "total": len(props),
        "years": [min(years), max(years)] if years else [],
        "by_severity": {s: sum(1 for p in props if p.get("severity") == s) for s in SEVERITIES},
        "by_mode": dict(Counter(p.get("mode") for p in props if p.get("mode"))),
        "by_year": {str(k): v for k, v in sorted(Counter(years).items())},
        "by_light": dict(Counter(p.get("light") for p in props if p.get("light")).most_common()),
        "by_pbcat": dict(Counter(p.get("pbcat") for p in props if p.get("pbcat")).most_common(10)),
        "top_streets": dict(Counter(p.get("street") for p in props if p.get("street")).most_common(10)),
        "by_county": dict(Counter(p.get("county") for p in props if p.get("county")).most_common()),
        "ka_total": sum(1 for p in props if p.get("severity") in ("K", "A")),
        # on-system subset = the crashes the network screening uses
        "on_system": {"total": sum(1 for p in props if p.get("on_system")),
                      "ka": sum(1 for p in props if p.get("on_system") and p.get("severity") in ("K", "A"))},
        "hour_dow": heat,
        "severity_by_condition": severity_by_condition(props),
    }


def _light(p: dict[str, Any]) -> str:
    s = (p.get("light") or "").upper()
    return "day" if "DAYLIGHT" in s else "dark_unlit" if "NOT LIGHTED" in s else "dark_lit" if "DARK, LIGHTED" in s else \
        "dark_unknown" if "DARK" in s else "other"


# Groups a lighting / speed-management programme acts on; KA = K + A crash severity (CRIS, as recorded).
CONDITIONS: tuple[tuple[str, str, Any], ...] = (
    ("dark_unlit", "Dark, not lighted", lambda p: _light(p) == "dark_unlit"),
    ("dark_lit", "Dark, lighted", lambda p: _light(p) == "dark_lit"),
    ("day", "Daylight", lambda p: _light(p) == "day"),
    ("speed_ge50", "Posted 50 mph or more", lambda p: (p.get("speed_limit") or 0) >= 50),
    ("speed_le35", "Posted 35 mph or less", lambda p: 0 < (p.get("speed_limit") or 0) <= 35),
    ("dark_ge50", "Dark and posted 50 mph or more", lambda p: _light(p).startswith("dark") and (p.get("speed_limit") or 0) >= 50),
    ("day_le45", "Daylight and posted under 50 mph", lambda p: _light(p) == "day" and 0 < (p.get("speed_limit") or 0) < 50),
)


def severity_by_condition(props: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for key, label, test in CONDITIONS:
        hit = [p for p in props if test(p)]
        out.append({"key": key, "label": label, "n": len(hit), "ka": sum(1 for p in hit if p.get("severity") in ("K", "A"))})
    return out


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


def fatal(county: str | None = None) -> dict[str, Any]:
    fc = store.load("fatal_crashes.geojson")
    c = resolve_county(county)
    return {**fc, **_county_fields(c), "features": [f for f in fc["features"] if in_county(f["properties"], c)]}
