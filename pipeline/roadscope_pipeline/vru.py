"""Pedestrian / cyclist crashes (TxDOT CRIS via Active_Transportation_Crashes layer 1)."""
from __future__ import annotations

import datetime as dt

from .sources import COUNTY_BY_NAME, COUNTY_BY_NBR, county_slug

MODES = {"Ped": "ped", "Bike": "bike", "ES": "scooter"}  # ES = e-scooter rider
DOW = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]


def severity(code: str | None) -> str | None:
    """CRIS 'K - FATAL INJURY' … 'N - NOT INJURED' → KABCO letter (N → O); unknown → None."""
    c = (code or "").strip()[:1].upper()
    return {"K": "K", "A": "A", "B": "B", "C": "C", "N": "O", "O": "O"}.get(c)


def hour(t: str | None, light: str | None = None) -> int | None:
    """Clock hour 0–23. The layer has no 12 PM records but codes daylight crashes as "12:xx AM",
    so a 12 AM time reported in daylight is read as noon; dark 12 AM times stay at midnight."""
    try:
        h = dt.datetime.strptime(t.strip(), "%I:%M %p").hour
    except (AttributeError, ValueError):
        return None
    if h == 0 and (light or "").upper().startswith("1 - DAYLIGHT"):
        return 12
    return h


def _clean(v):
    return None if v in (None, "", " ", "No Data", "NO DATA", "Not Applicable") else v


def to_geojson(feats):
    out = []
    for f in feats:
        a = f["attributes"]
        lon, lat = a.get("Longitude"), a.get("Latitude")
        if lon is None or lat is None:
            continue
        mode = MODES.get(a.get("PedBikeES"))
        date = dt.datetime.fromtimestamp(a["Crash_Date"] / 1000, dt.timezone.utc).date() if a.get("Crash_Date") else None
        dow = (a.get("Day_of_Wee") or "").upper()
        nbr = COUNTY_BY_NAME.get((a.get("County") or "").strip().upper())
        if nbr is None:  # outside the SPAG counties (the layer query is already county-filtered)
            continue
        out.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]},
                    "properties": {
                        "id": str(a["Crash_ID"]), "date": date.isoformat() if date else None,
                        "hour": hour(a.get("Crash_Time"), a.get("Light_Cond")), "dow": DOW.index(dow) if dow in DOW else None,
                        "year": a.get("Crash_Year"), "severity": severity(a.get("Crash_Seve")), "mode": mode,
                        "pbcat": _clean(a.get("PBCAT_Bike") if mode == "bike" else a.get("PBCAT_Ped")),
                        "light": _clean(a.get("Light_Cond")), "speed_limit": a.get("Speed_Limi") if (a.get("Speed_Limi") or 0) > 0 else None,
                        "street": _clean(a.get("Street_Nam")), "on_system": a.get("On_System_") == "Yes",
                        "highway": _clean(a.get("Highway_Nu")), "intersection": _clean(a.get("Intersec_4")),
                        "contributing": _clean(a.get("Contributi")), "ka_count": a.get("KACount"),
                        "county": COUNTY_BY_NBR[nbr], "county_nbr": nbr, "county_id": county_slug(COUNTY_BY_NBR[nbr]),
                        "city": _clean(a.get("City")), "district": a.get("DIST_NM"),
                    }})
    return {"type": "FeatureCollection", "features": out}
