"""Source registry and manifest helper (shared with the trajectory pipeline)."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

ARCGIS = "https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services"
LUBBOCK_ENVELOPE = (-102.1, 33.45, -101.55, 33.75)
TXDOT_LICENCE = "© TxDOT — informational use; attribution and TxDOT disclaimer required"
FARS_LICENCE = "Public domain (US Government work, NHTSA FARS)"

LAYERS = {
    "segment_crash": {"path": "Segment_Crash__Results_9a0c7/FeatureServer/243", "where": "1=1", "envelope": True},
    "aadt": {"path": "TxDOT_AADT/FeatureServer/0", "where": "1=1", "envelope": True},
    "roadway_inventory": {"path": "Roadway_Inventory_2024/FeatureServer/0", "where": "CO=152", "envelope": False},
    "speed_2024": {"path": "TxDOT_Statewide_Speed_2024/FeatureServer/0", "where": "1=1", "envelope": True},
    "active_transportation_crashes": {"path": "Active_Transportation_Crashes_f8c8e/FeatureServer/1", "where": "1=1", "envelope": True},
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
