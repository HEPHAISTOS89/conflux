"""Build curated network, corridors, VRU, FARS and SPF outputs.

    python -m roadscope_pipeline.build_network --out data/curated [--raw data/raw] [--refresh] [--no-fars]
"""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

from . import network, vru
from .arcgis import fetch_layer
from .counties import county_summary
from .sources import COUNTIES, REGION, update_manifest


def _write(path: Path, obj, compact=True) -> str:
    blob = json.dumps(obj, separators=(",", ":") if compact else None, indent=None if compact else 1).encode()
    path.write_bytes(blob)
    return hashlib.sha256(blob).hexdigest()


def build(out: Path, raw: Path, refresh=False, fars=True, spf_existing: dict | None = None) -> dict:
    out, raw = Path(out), Path(raw)
    out.mkdir(parents=True, exist_ok=True)
    layers, sources = {}, []
    for key in ("counties", "segment_crash", "aadt", "roadway_inventory", "speed_2024", "active_transportation_crashes"):
        layers[key], entry = fetch_layer(key, raw, refresh)
        sources.append(entry)
    if len(layers["counties"]) != len(COUNTIES):
        raise RuntimeError(f"expected {len(COUNTIES)} SPAG county polygons, got {len(layers['counties'])}")

    segs, idx, meta = network.build_segments(layers["segment_crash"], layers["aadt"], layers["roadway_inventory"],
                                             layers["speed_2024"], layers["active_transportation_crashes"], layers["counties"])
    spf = network.screen(segs, fitted=spf_existing)
    spf["diagnostics"].update(crash_field=meta["crash_field"], aadt=meta["aadt"], join=meta["join"])
    net = network.to_geojson(segs)
    corridors = network.build_corridors(segs, idx)
    vru_gj = vru.to_geojson(layers["active_transportation_crashes"])

    _write(out / "network.geojson", net)
    _write(out / "corridors.json", corridors)
    _write(out / "vru_crashes.geojson", vru_gj)
    _write(out / "spf.json", spf)  # compact: CURE arrays

    sev = Counter(f["properties"]["severity"] for f in vru_gj["features"])
    joined = [s for s in segs if s["rank"] is not None]
    fatal = None
    if fars:
        from . import fars as F
        fatal, fsrc = F.build(raw, refresh)
        _write(out / "fatal_crashes.geojson", fatal)
        sources += fsrc
    by_county = county_summary(segs, vru_gj["features"], fatal["features"] if fatal else None)
    _write(out / "counties.geojson", idx["counties"].to_geojson(by_county))
    metrics = {
        "region": {**REGION, "counties": len(COUNTIES), "segments_dropped_outside": meta["join"]["region"]["segments_dropped"]},
        "by_county": [by_county[n] for _, n, _, _ in COUNTIES],
        "segments": len(segs), "segments_screened": len(joined),
        "segments_with_crashes": sum(s["crashes_total"] > 0 for s in segs),
        "segment_crashes_total": sum(s["crashes_total"] for s in segs), "segment_crash_years": spf["crash_years"],
        "segment_crash_period": spf["crash_period"],
        "segment_crash_outcome": "on-system ped/bike/e-scooter CRIS crashes (all KABCO)",
        "spf_b0": round(spf["b0"], 4), "spf_b1": round(spf["b1"], 4), "spf_k": round(spf["k"], 4),
        "spf_site_types_fitted": sorted(t for t, v in spf["site_types"].items() if v["fitted"]),
        "aadt_ext_date": sorted(meta["aadt"]["ext_date"]),
        "join_quality": {g: {k: v[k] for k in ("segments", "pct_aadt_matched", "pct_inventory_matched", "crashes_matched")}
                         for g, v in meta["join"]["by_facility_group"].items()},
        "crash_points_matched_pct": meta["join"]["crash_points"]["pct_on_system_matched"],
        "corridors": len(corridors), "vru_crashes": len(vru_gj["features"]),
        "vru_ka": sev["K"] + sev["A"], "vru_by_severity": dict(sev),
        "vru_by_mode": dict(Counter(f["properties"]["mode"] for f in vru_gj["features"])),
    }
    if fatal:
        metrics.update(fatal_crashes=len(fatal["features"]), fatalities=sum(f["properties"]["fatals"] for f in fatal["features"]),
                       fatal_years="2018-2023")
    update_manifest(out / "manifest.json", sources, metrics)
    return metrics


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/curated")
    ap.add_argument("--raw", default="data/raw")
    ap.add_argument("--refresh", action="store_true", help="re-download sources instead of using the raw cache")
    ap.add_argument("--no-fars", action="store_true")
    a = ap.parse_args(argv)
    print(json.dumps(build(Path(a.out), Path(a.raw), a.refresh, not a.no_fars), indent=1))


if __name__ == "__main__":
    main()
