"""CLI: python -m roadscope_pipeline.trajectory.build --out data/curated"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from collections import Counter
from pathlib import Path

import numpy as np

from . import ngsim, repair, ssm

# int_id chosen from SODA group-by counts: the signalised intersection on each corridor with
# the most balanced four-approach volume (both cross-street directions present), so crossing
# conflicts (PET) exist alongside mainline rear-end/lane-change interactions.
SITES = [
    {"id": "lankershim-main", "location": "lankershim", "int_id": 2,
     "name": "Lankershim Blvd at Main St", "city": "Los Angeles, CA",
     "date": "2005-06-16 08:30-09:00 PDT"},
    {"id": "peachtree-10th", "location": "peachtree", "int_id": 1,
     "name": "Peachtree St NE at 10th St NE", "city": "Atlanta, GA",
     "date": "2006-11-08 12:45-13:00 / 16:00-16:15 EST"},
]
WINDOW_S = 90
HALF_X_FT, HALF_Y_FT = 200.0, 300.0   # ~61 m x 91 m around the intersection centre


def r2(a):
    return [round(float(v), 2) for v in a]


def build_site(site, out: Path, cache: Path):
    t0, t1, centre = ngsim.densest_window(site["location"], site["int_id"], WINDOW_S, cache)
    df = ngsim.fetch_zone(site["location"], t0, t1, centre, HALF_X_FT, HALF_Y_FT, cache)
    df = df.assign(int_id=(df.int_id == site["int_id"]).astype(int) * site["int_id"])
    tracks = ngsim.build_tracks(df, t0, centre)
    conflicts = ssm.all_conflicts(tracks)
    rep = repair.occlude_and_repair(tracks)
    xs = np.concatenate([t["x"] for t in tracks]); ys = np.concatenate([t["y"] for t in tracks])
    doc = {
        "id": site["id"], "name": site["name"],
        "source": {"dataset": "NGSIM Vehicle Trajectories (USDOT ITS DataHub)",
                   "url": ngsim.SODA, "location": site["location"], "int_id": site["int_id"],
                   "global_time_ms": [t0, t1], "centre_local_ft": [round(c, 2) for c in centre],
                   "processing": "ft->m, centred on intersection; Savitzky-Golay (15 frames, order 2) "
                                 "on x/y, v and a recomputed from smoothed derivatives"},
        "hz": ngsim.HZ, "window_s": WINDOW_S,
        "bbox": [r2([xs.min(), ys.min()]), r2([xs.max(), ys.max()])],
        "axes": "local metres; +y along corridor (northbound), +x across",
        "lanes_geom": ngsim.lanes_geom(tracks),
        "tracks": [{"id": t["id"], "cls": t["cls"], "len_m": t["len_m"], "w_m": t["w_m"],
                    "dir": t["dir"], "move": t["move"],
                    "pts": [[round(float(a), 1), *r2(b)] + [int(c)] for a, *b, c in
                            zip(t["t"], t["x"], t["y"], t["v"], t["a"], t["lane"])]}
                   for t in tracks],
    }
    out.mkdir(parents=True, exist_ok=True)
    for name, obj in ((f"{site['id']}.json", doc), (f"{site['id']}_conflicts.json", conflicts),
                      (f"{site['id']}_repair.json", rep)):
        (out / name).write_text(json.dumps(obj, separators=(",", ":")))
    by = Counter((c["type"], c["severity"]) for c in conflicts)
    return {"id": site["id"], "name": site["name"], "site": site["location"], "city": site["city"],
            "approach": "all approaches within 61 m x 91 m box", "window": [t0, t1],
            "recorded": site["date"], "s": WINDOW_S, "hz": ngsim.HZ, "tracks": len(tracks),
            "conflicts": len(conflicts),
            "summary": {"conflicts_by_type": dict(Counter(c["type"] for c in conflicts)),
                        "conflicts_by_type_severity": {f"{k[0]}:{k[1]}": v for k, v in sorted(by.items())},
                        "repair": rep["summary"]}}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/curated")
    ap.add_argument("--cache", default="data/raw/ngsim")
    a = ap.parse_args(argv)
    out = Path(a.out) / "intersections"
    index = [build_site(s, out, Path(a.cache)) for s in SITES]
    (out / "index.json").write_text(json.dumps(index, indent=1))
    man_p = Path(a.out) / "manifest.json"
    man = json.loads(man_p.read_text()) if man_p.exists() else {}
    sources = man.setdefault("sources", [])
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    for s, row in zip(SITES, index):
        raw = Path(a.cache) / f"{s['location']}_{row['window'][0]}_{row['window'][1]}_zone.json"
        entry = {"id": f"ngsim_{s['location']}", "url": ngsim.SODA,
                 "licence": "CC BY-SA 3.0 (USDOT ITS DataHub); attribution and share-alike",
                 "records": len(json.loads(raw.read_text())), "fetched_at": now,
                 "sha256": hashlib.sha256(raw.read_bytes()).hexdigest(),
                 "filter": f"location='{s['location']}', int_id={s['int_id']} zone, global_time {row['window']}",
                 "outputs": [f"intersections/{s['id']}{x}.json" for x in ("", "_conflicts", "_repair")]}
        sources[:] = [e for e in sources if e.get("id") != entry["id"]] + [entry]
        sources.sort(key=lambda e: e.get("id", ""))
    man_p.write_text(json.dumps(man, indent=1))
    print(json.dumps(index, indent=1))


if __name__ == "__main__":
    main()
