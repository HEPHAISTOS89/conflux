"""County attribution: TxDOT county polygons → point-in-polygon lookup, per-county roll-ups, boundary GeoJSON."""
from __future__ import annotations

from collections import Counter

import numpy as np

from .sources import COUNTIES, COUNTY_BY_NBR, county_slug


class CountyIndex:
    """Point-in-polygon over the TxDOT County_Boundaries features (ArcGIS rings, lon/lat).

    Even–odd ray casting, vectorised per ring with numpy; a bounding-box test first so a point is
    tested against the one or two counties whose extent contains it.
    """

    def __init__(self, feats):
        self.items = []
        for f in feats:
            a = f["attributes"]
            rings = [np.asarray(r, float) for r in (f.get("geometry") or {}).get("rings", []) if len(r) >= 4]
            if not rings:
                continue
            allpts = np.vstack(rings)
            self.items.append({"nbr": int(a["CNTY_NBR"]), "name": a["CNTY_NM"], "fips": a.get("FIPS_ST_CNTY_CD"),
                               "district": a.get("DIST_NBR"), "rings": rings,
                               "bbox": (allpts[:, 0].min(), allpts[:, 1].min(), allpts[:, 0].max(), allpts[:, 1].max())})
        self.items.sort(key=lambda c: c["name"])

    @staticmethod
    def _inside(ring: np.ndarray, x: float, y: float) -> bool:
        x0, y0 = ring[:-1, 0], ring[:-1, 1]
        x1, y1 = ring[1:, 0], ring[1:, 1]
        cross = (y0 > y) != (y1 > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            xi = x0 + (y - y0) * (x1 - x0) / (y1 - y0)
        return bool(np.sum(cross & (x < xi)) % 2)

    def lookup(self, lon: float, lat: float):
        """County record containing the point, or None (outside every SPAG county)."""
        for c in self.items:
            b = c["bbox"]
            if b[0] <= lon <= b[2] and b[1] <= lat <= b[3] and sum(self._inside(r, lon, lat) for r in c["rings"]) % 2:
                return c
        return None

    def to_geojson(self, by_nbr: dict, tol_m: float = 60.0):
        """Simplified county polygons with per-county roll-ups (``by_nbr``: county number → summary dict)."""
        from .network import douglas_peucker  # local import: network imports this module

        feats = []
        for c in self.items:
            rings = [[[round(x, 4), round(y, 4)] for x, y in douglas_peucker([list(p) for p in r], tol_m)] for r in c["rings"]]
            rings = [r for r in rings if len(r) >= 4]
            feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": rings},
                          "properties": {"id": county_slug(c["name"]), "name": c["name"], "county_nbr": c["nbr"], "fips": c["fips"],
                                         "district": c["district"], "bbox": [round(v, 4) for v in c["bbox"]],
                                         **by_nbr.get(c["nbr"], {})}})
        return {"type": "FeatureCollection", "features": feats}


def county_summary(segs, vru_feats, fatal_feats=None) -> dict[int, dict]:
    """Per-county counts: segments (all / screened / flagged), snapped crashes and K+A, CRIS VRU crashes and
    K+A (all roads and on-system), FARS fatal crashes. Keyed by TxDOT county number; every SPAG county present."""
    out = {n: {"segments": 0, "segments_screened": 0, "segments_flagged": 0, "segment_crashes": 0, "segment_crashes_ka": 0,
               "segment_miles": 0.0, "vru_crashes": 0, "vru_ka": 0, "vru_on_system": 0, "vru_on_system_ka": 0,
               "vru_by_mode": Counter(), "fatal_crashes": None}
           for _, n, _, _ in COUNTIES}
    for s in segs:
        c = out.get(s.get("county_nbr"))
        if c is None:
            continue
        c["segments"] += 1
        c["segment_miles"] += s["len_mi"]
        c["segment_crashes"] += s["crashes_total"]
        c["segment_crashes_ka"] += s["crashes_ka"]
        if s.get("rank") is not None:
            c["segments_screened"] += 1
            if (s.get("eb_excess") or 0) > 0:
                c["segments_flagged"] += 1
    for f in vru_feats:
        p = f["properties"]
        c = out.get(p.get("county_nbr"))
        if c is None:
            continue
        ka = p.get("severity") in ("K", "A")
        c["vru_crashes"] += 1
        c["vru_ka"] += ka
        c["vru_by_mode"][p.get("mode") or "unknown"] += 1
        if p.get("on_system"):
            c["vru_on_system"] += 1
            c["vru_on_system_ka"] += ka
    if fatal_feats is not None:
        for c in out.values():
            c["fatal_crashes"] = 0
        for f in fatal_feats:
            c = out.get(f["properties"].get("county_nbr"))
            if c is not None:
                c["fatal_crashes"] += 1
    for n, c in out.items():
        c["segment_miles"] = round(c["segment_miles"], 2)
        c["vru_by_mode"] = dict(c["vru_by_mode"])
        c["name"] = COUNTY_BY_NBR[n]
        c["id"] = county_slug(c["name"])
    return out
