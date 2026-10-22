# SPAG region: 15-county extension (2026-10-18)

The portal's analytical scope moves from Lubbock County to the fifteen counties of the South Plains
Association of Governments (SPAG), the planning region of the USDOT roadside-LiDAR pilot. Every sheet
defaults to the whole region; a Region control in the shell (rail on desktop, top bar on phones) selects one
county and writes it to the URL (`?county=<slug>`), so links, Back and copied URLs reproduce the view.

## County list (verified)
SPAG's own site states "a fifteen county region" without naming them; the roster comes from SPAG's profile at
the Texas Association of Regional Councils (txregionalcouncil.org/?p=158): Bailey, Cochran, Crosby, Dickens,
Floyd, Garza, Hale, Hockley, King, Lamb, Lubbock, Lynn, Motley, Terry, Yoakum. TxDOT county numbers, FIPS
codes and districts were read from TxDOT's `Texas_County_Boundaries` layer (12 counties in District 05
Lubbock; Dickens, King and Motley in District 25 Childress). TxDOT numbers are not the alphabetical
comptroller numbers (Garza 86, Hale 96, Hockley 111 differ by one), so `pipeline/roadscope_pipeline/sources.py`
carries all three identifiers per county.

## How each source is filtered
| Layer | Filter | County attribution |
|---|---|---|
| Segment_Crash__Results (one-mile segments) | region envelope (−103.07, 32.95, −99.98, 34.32) | midpoint point-in-polygon against the TxDOT county polygons; 721 envelope segments outside the fifteen counties dropped |
| TxDOT_AADT, Statewide Speed 2024 | region envelope | joined by route and DFO (no county needed) |
| Roadway Inventory 2024 | `CO IN (15 TxDOT numbers)`, 20 fields | `CO` |
| Active Transportation Crashes (CRIS) | `County IN (15 names)` | `County` field |
| FARS 2018–2023 | `STATE = 48 AND COUNTY IN (15 FIPS)` | FIPS → county |
| Texas_County_Boundaries | `CNTY_NBR IN (…)` | served simplified as `counties.geojson` with per-county roll-ups |

## Build (2026-10-18, `python -m roadscope_pipeline.build_network`)
Region: 4,121 segments, 4,090 screened (31 without an inventory/AADT match), 142 on-system ped/bike crashes
snapped (100 % of on-system points ≤ 5 m), 139 on screened segments; 354 CRIS VRU crashes (106 K+A; 142
on-system, 60 K+A); 461 FARS fatal crashes, 519 fatalities. Flagged (EB excess > 0): 54 of 4,090, 16 also
R/Rc > 1; top site US 84 DFO 69.0–70.0 (Lubbock), 1.57 excess crashes/yr.

| County | Segments | Screened | Flagged | Seg. crashes | K+A | VRU crashes | VRU K+A | On-system | FARS fatal |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Bailey | 226 | 226 | 2 | 2 | 0 | 3 | 0 | 2 | 8 |
| Cochran | 232 | 232 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| Crosby | 257 | 257 | 2 | 5 | 4 | 6 | 4 | 5 | 13 |
| Dickens | 204 | 204 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| Floyd | 328 | 328 | 0 | 0 | 0 | 1 | 1 | 0 | 8 |
| Garza | 187 | 187 | 2 | 2 | 1 | 2 | 1 | 2 | 17 |
| Hale | 389 | 389 | 5 | 7 | 5 | 14 | 4 | 6 | 31 |
| Hockley | 341 | 341 | 2 | 3 | 2 | 5 | 3 | 3 | 35 |
| King | 95 | 95 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| Lamb | 364 | 364 | 2 | 3 | 1 | 5 | 1 | 3 | 20 |
| Lubbock | 529 | 499 | 37 | 116 | 45 | 311 | 89 | 117 | 278 |
| Lynn | 313 | 313 | 0 | 1 | 1 | 1 | 1 | 1 | 11 |
| Motley | 169 | 169 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| Terry | 278 | 277 | 2 | 3 | 1 | 6 | 2 | 3 | 17 |
| Yoakum | 209 | 209 | 0 | 0 | 0 | 0 | 0 | 0 | 10 |

Lubbock County changes against the previous build (443 segments, 395 screened, 110 crashes, 43 on-system K+A):
the old Lubbock envelope (33.45–33.75 N) cut the county's northern and southern edges; the county polygon now
holds all 529 segments, and routes that cross the county line match inventory records on both sides, so
499 are screened and 116 crashes land on them (46 on-system K+A). FARS Lubbock stays 278.

## HSM / EB validity
SPFs are refit once on the regional population (n = 4,090 screened segments, 139 crashes; pooled ln-AADT model
k = 3.30/mi). Three urban site types carry their own NB2 model (urban interstate/freeway 63 segments / 29
crashes, ln AADT + lanes, k at the lower bound; urban principal arterial 103 / 60, ln AADT + posted speed,
k = 1.13; urban minor arterial 102 / 31, ln AADT + lanes, k = 0.33). Five site types fall to the pooled
site-type fallback: urban collector/local (45 / 0), rural interstate/freeway (42 / 4), rural principal arterial
(300 / 9), rural minor arterial (664 / 3), rural collector/local (2,771 / 3). Critical-rate reference
populations are the regional site types. A county view filters the ranked list only; the Methods page states
the new n and this rule ("County ranks are positions in the regional ranking"). Corridor sheets stay Lubbock
County profiles (`county_id` on each corridor; stations stop at the county line).

## API
`county=<slug | name | TxDOT number>` on `/network`, `/screening`, `/vru`, `/vru/summary`, `/fatal`; `all`,
`spag` or omitted = region; unknown county → 404 listing `/counties`. New `/counties` returns the polygons
with roll-ups. Responses carry `county` and `county_name`; `/screening` keeps the regional `rank` and adds the
in-scope `screen_rank`. The Ask tools accept `county` and the fallback router detects county names. Lambda
responses are gzipped (regional `network.geojson` 3.0 MB → 239 KB); `/screening` accepts `limit` ≤ 5000.

## Verified (dev server, in-app Chromium, 2026-10-18)
- 1440 × 900 dark: Screening region (4,090 rows, 54 / 4,090 flagged, 139 crashes, 1.42 /100 MVMT; county per
  row), Region control → Bailey (URL `?county=bailey`, rail links carry it, 226 rows, 2 flagged), `/vru?county=hale`
  (14 crashes, 4 KA, scope pill), `/brief?county=hale` (title "Hale County ped/bike safety brief", 5 flagged of
  389, verdict), landing `?county=lubbock` (37 of 499, US 84 1.57/yr, 46 K+A, ranked network 499 segments ·
  494 mi, links carry the county), `/brief` region (54 / 16, worst US 84 (Lubbock County)).
- 375 × 812 (mobile preset) dark and light: top-bar Region control with the 16-option listbox inside the
  viewport, no horizontal overflow after the top-bar fix (the Menu button had been pushed off screen).
- Console: no errors or warnings on any page. `tsc`, 76 vitest (5 new for the URL state), 68 backend
  (4 new), 32 pipeline (3 new) pass; `vite build` passes.
- Headless Chromium screenshots: `docs/qa/spag/`.

## Not done / to flag
- Not deployed. The curated set must be synced to S3 (`curated/`) before the next deploy; until then the live
  API serves the Lubbock-only build and the weekly ingest Lambda would apply the stored Lubbock SPFs to the
  regional data. The ingest run now downloads ~40 MB and processes 4,121 segments (local build 65 s); the
  Lambda keeps its 15-minute timeout and 1,024 MB.
- The 4,090-row ranked table is rendered in full; it scrolls inside its panel and FLIP only animates rows in
  view, but a virtualised list would be lighter on phones.
