"""Source registry, study region and manifest helper (shared with the trajectory pipeline)."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

ARCGIS = "https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services"
TXDOT_LICENCE = "© TxDOT — informational use; attribution and TxDOT disclaimer required"
FARS_LICENCE = "Public domain (US Government work, NHTSA FARS)"

# Study region: the fifteen counties of the South Plains Association of Governments (SPAG), the
# planning region of the USDOT roadside-LiDAR pilot. Membership checked 2026-10-18 against SPAG's
# profile (txregionalcouncil.org/?p=158: "Counties Served: Bailey, Cochran, Crosby, Dickens, Floyd,
# Garza, Hale, Hockley, King, Lamb, Lubbock, Lynn, Motley, Terry, Yoakum"); county numbers, FIPS codes
# and TxDOT districts read from TxDOT's Texas_County_Boundaries layer (CNTY_NBR, FIPS_ST_CNTY_CD,
# DIST_NBR). Twelve counties are in the Lubbock District (05); Dickens, King and Motley are in the
# Childress District (25). TxDOT county numbers are NOT the alphabetical comptroller numbers
# (Garza 86, Hale 96, Hockley 111 differ by one).
COUNTIES = [
    # name, TxDOT county number (Roadway Inventory CO), FIPS state+county, TxDOT district
    ("Bailey", 9, "48017", 5), ("Cochran", 40, "48079", 5), ("Crosby", 54, "48107", 5),
    ("Dickens", 63, "48125", 25), ("Floyd", 78, "48153", 5), ("Garza", 86, "48169", 5),
    ("Hale", 96, "48189", 5), ("Hockley", 111, "48219", 5), ("King", 135, "48269", 25),
    ("Lamb", 140, "48279", 5), ("Lubbock", 152, "48303", 5), ("Lynn", 153, "48305", 5),
    ("Motley", 173, "48345", 25), ("Terry", 223, "48445", 5), ("Yoakum", 251, "48501", 5),
]
COUNTY_BY_NBR = {n: name for name, n, _, _ in COUNTIES}
COUNTY_BY_NAME = {name.upper(): n for name, n, _, _ in COUNTIES}
COUNTY_NBR_BY_FIPS = {int(f[2:]): n for _, n, f, _ in COUNTIES}  # FARS COUNTY = 3-digit FIPS county code
REGION = {"id": "spag", "name": "South Plains (SPAG), 15 counties"}
# Union of the fifteen county extents (TxDOT County_Boundaries, 4326: −103.065, 32.959, −99.991, 34.314), padded.
REGION_ENVELOPE = (-103.07, 32.95, -99.98, 34.32)


def county_slug(name: str) -> str:
    return name.lower().replace(" ", "-")


_NBRS = ",".join(str(n) for _, n, _, _ in COUNTIES)
_NAMES = ",".join(f"'{name.upper()}'" for name, *_ in COUNTIES)
# Roadway Inventory carries 150 fields; the build reads these (keeps 27k records at ~10 MB instead of ~70 MB).
RI_FIELDS = ("OBJECTID,RIA_RTE_ID,FRM_DFO,TO_DFO,CO,DI,HSYS,HWY,F_SYSTEM,RU,UAN,MED_TYPE,NUM_LANES,SPD_MAX,"
             "ADT_CUR,ADT_YEAR,TRK_AADT_PCT,STE_NAM,CITY,LEN_SEC")

# Layers without a county field (segment results, AADT, speed) are pulled for the region envelope and the
# segment results are then kept only where the segment midpoint lies in a SPAG county polygon (network.py).
# Layers with a county field are filtered by it: Roadway Inventory CO (TxDOT number), CRIS crashes County (name).
LAYERS = {
    "counties": {"path": "Texas_County_Boundaries/FeatureServer/0", "where": f"CNTY_NBR IN ({_NBRS})", "envelope": False,
                 "out_fields": "CNTY_NM,CNTY_NBR,FIPS_ST_CNTY_CD,DIST_NBR"},
    "segment_crash": {"path": "Segment_Crash__Results_9a0c7/FeatureServer/243", "where": "1=1", "envelope": True},
    "aadt": {"path": "TxDOT_AADT/FeatureServer/0", "where": "1=1", "envelope": True},
    "roadway_inventory": {"path": "Roadway_Inventory_2024/FeatureServer/0", "where": f"CO IN ({_NBRS})", "envelope": False,
                          "out_fields": RI_FIELDS},
    "speed_2024": {"path": "TxDOT_Statewide_Speed_2024/FeatureServer/0", "where": "1=1", "envelope": True},
    "active_transportation_crashes": {"path": "Active_Transportation_Crashes_f8c8e/FeatureServer/1",
                                      "where": f"County IN ({_NAMES})", "envelope": False},
}

FARS_YEARS = range(2018, 2024)
FARS_URL = "https://static.nhtsa.gov/nhtsa/downloads/FARS/{y}/National/FARS{y}NationalCSV.zip"


def layer_url(key: str) -> str:
    return f"{ARCGIS}/{LAYERS[key]['path']}"


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def update_manifest(path: Path, sources: list[dict] | None = None, metrics: dict | None = None) -> dict:
    """Merge source entries (keyed by id) and metric keys into manifest.json.

    Other pipelines call this too, so existing entries not mentioned are kept.
    """
    path = Path(path)
    manifest = json.loads(path.read_text()) if path.exists() else {}
    existing = manifest.get("sources", [])
    if isinstance(existing, dict):  # tolerate {id: entry} form; SPEC uses a list
        existing = [{"id": k, **v} for k, v in existing.items()]
    by_id = {s["id"]: s for s in existing}
    for s in sources or []:
        by_id[s["id"]] = s
    manifest["sources"] = sorted(by_id.values(), key=lambda s: s["id"])
    manifest["metrics"] = {**manifest.get("metrics", {}), **(metrics or {})}
    manifest["generated_at"] = now_iso()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2))
    return manifest
