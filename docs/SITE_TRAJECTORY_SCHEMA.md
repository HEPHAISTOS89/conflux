# Site trajectory feed — input schema (v1.0)

The portal ingests a site's trajectory feed (roadside LiDAR, drone or any tracker) from one folder and turns it into the curated intersection format that every lab view reads. The converter is `pipeline/roadscope_pipeline/trajectory/site.py`; it runs locally (`python -m roadscope_pipeline.trajectory.site --site data/sites/<id> --out data/curated`) and inside the ingest Lambda when the same folder is dropped under `s3://<bucket>/sites/<site_id>/`.

A site folder holds exactly two files:

| File | Content |
|---|---|
| `site.json` | Site metadata, units, reference point, intersection box, crosswalk polygons, source and licence |
| `tracks.csv` or `tracks.json` | One row (CSV) or one point (JSON) per road user per 10 Hz frame |

## 1. `tracks.csv`

| Column | Type | Unit | Required | Meaning |
|---|---|---|---|---|
| `site_id` | string | | yes | Must equal `site.json → id` on every row |
| `track_id` | string or integer | | yes | Stable identity of one road user for the whole recording |
| `class` | enum | | yes | `pedestrian`, `bicycle`, `motorcycle`, `car`, `truck`, `bus` |
| `t` | number | s | yes | Time from the recording start, **on the 10 Hz grid** (multiples of 0.1 s, tolerance ± 0.02 s) |
| `x`, `y` | number | m or ft (`site.json → units`) | yes | Position in the site's local plane, +y along the main road, +x across it |
| `length`, `width` | number | same as x, y | vehicles | Bounding-box length and width; defaults by class when blank (`pedestrian` 0.5 × 0.5 m, `bicycle` 1.8 × 0.6, `motorcycle` 2.0 × 0.8, `car` 4.5 × 1.8, `truck` 8.0 × 2.5, `bus` 12.0 × 2.6) |
| `heading` | number | degrees | no | Direction of travel, **clockwise from +y** (0 = northbound, 90 = eastbound). When blank, heading is taken from the velocity vector and held through stops |
| `lane` | integer | | no | Lane number on the approach (1 = kerb lane). When blank, lanes are binned from the lateral offset at 3.5 m (11.5 ft) per lane |

Rows may arrive in any order. A track with internal gaps of up to 0.5 s is interpolated; a longer gap splits the track and the longest run is kept; tracks shorter than 1.5 s are dropped and reported.

`tracks.json` carries the same data as `{"tracks": [{"id", "class", "length", "width", "lane", "pts": [[t, x, y], …] or [[t, x, y, heading], …]}]}`.

## 2. `site.json`

```json
{
  "schema": "conflux-site/1.0",
  "id": "lubbock-19th-university",
  "name": "19th St at University Ave",
  "city": "Lubbock, TX",
  "hz": 10,
  "units": "m",
  "reference": "centre",
  "recorded": "2026-03-04 07:30-07:31 CST",
  "window": [0, 90],
  "origin": [0, 0],
  "rotate_deg": 0,
  "box": [[-12, -14], [12, 14]],
  "crosswalks": [
    {"id": "N", "polygon": [[-12, 14], [12, 14], [12, 17], [-12, 17]]}
  ],
  "source": {
    "dataset": "TransTech Lab roadside LiDAR, site 3",
    "url": "https://…",
    "licence": "Research use within the USDOT pilot",
    "citation": "…"
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | `[a-z0-9-]+`; becomes the URL `/intersections/<id>` and the S3 prefix `sites/<id>/` |
| `name`, `city` | yes | Shown on the lab tabs and the Atlas |
| `hz` | yes | Must be 10 |
| `units` | yes | `m` or `ft` for x, y, length, width, box and crosswalks |
| `reference` | yes | What x, y locate on a vehicle: `front_bumper` (as NGSIM) or `centre` (bounding-box centre, as most LiDAR trackers). Pedestrians are always a point. The curated output is **always front-bumper**, so every renderer places a body `length` behind the point |
| `recorded` | yes | Local date and time of the recording |
| `window` | no | `[t0, t1]` in seconds to keep (default: whole feed, capped at 300 s for the Lambda path) |
| `origin`, `rotate_deg` | no | Translation subtracted and rotation (counter-clockwise, degrees) applied to every coordinate so that the intersection sits at (0, 0) with the main road along +y |
| `box` | yes | Intersection box `[[x0, y0], [x1, y1]]` after origin/rotation: frames inside it carry lane 0 and define the crossing-conflict zone (PET) |
| `crosswalks` | no | Polygons (≥ 3 vertices, after origin/rotation). Required for pedestrian PET and the failure-to-yield indicator |
| `source` | yes | `dataset`, `url`, `licence` and `citation`; shown with every number derived from the site |

## 3. What the converter produces

`curated/intersections/<id>.json` (tracks at 10 Hz as `[t, x, y, v, a, lane]` in metres, front-bumper reference, Savitzky–Golay smoothed positions with speed and acceleration from the smoothed derivatives), `<id>_conflicts.json` (TTC, PET, DRAC, pedestrian PET and failure-to-yield events), `<id>_ssm.json` (rules, citations, threshold sensitivity), optionally `<id>_repair.json` (occlusion-repair benchmark, local runs only), and an updated `index.json`. The curated file keeps `crosswalks`, `box`, `classes` and `source` so the lab can draw the crosswalks and show the licence.

Validation failures (wrong units, off-grid timestamps, unknown classes, missing crosswalks for a feed with pedestrians) stop the run with a message that names the row; nothing is published.
