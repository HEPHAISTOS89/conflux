# QA — Intersection lab (`/intersections/:id`)

2026-10-17. Headless Chrome for Testing 1234 (Playwright 1.63) on Apple M2 Pro, ANGLE Metal (real GPU), against
`vite` on :5173 with the local API on :8000. Scripts: an automated control audit (51 checks), an fps probe and a
layout sweep; screenshots reviewed by eye in motion. `npx tsc --noEmit`, `npm run build`, `npm test` (47 tests) pass.

## Controls (automated, real outcomes)

| Control | Expected | Observed | Result |
|---|---|---|---|
| Page header readouts | 119 conflicts; 34 critical excl. 17 overlap flags (same rule as landing) | Conflicts / 119 / Critical, excl. overlap / 34 / Worst TTC / 0.14 / s / Data completeness / 100.0 / % | Pass |
| Play | clock advances at 1× | 0 → 1.1 s after 1.1 s | Pass |
| Pause | clock holds | 1.1 held | Pass |
| Playback rate Select (¼–4×) | 2× doubles clock speed | 2.1 s in 1.0 s | Pass |
| Frame step buttons | ±0.1 s (one 10 Hz frame), pauses | 3.2 → 3.3 → 3.2 | Pass |
| Keys , and . | step one frame back/forward | 3.2 → 3.4 → 3.3 | Pass |
| Keys ← → (Shift) | ±0.1 s (±1 s) | 3.3 → 4.3 → 4.2 | Pass |
| Scrubber | seeks to the dragged time | t = 42.5 | Pass |
| Next risk event button | selects next conflict, seeks to its lead-in, writes ?conflict | ?conflict=0, t = 0 | Pass |
| Keys ] and [ | next / previous conflict | ?conflict=0 → ?conflict=1&t=6.2 → ?conflict=0 | Pass |
| Conflict table row | selects the pair, seeks to lead-in, opens inspector, writes ?conflict | ?conflict=5&t=9.4 · row "11.1 Rear-end 1.27 — 2.3" · inspector Conflict pair | Pass |
| Inspector pair extremes | min TTC / PET / max DRAC equal the table row | min TTC 1.27 s min PET — max DRAC 2.3 ft/s² | Pass |
| Conflict type filter (Select) | table narrows to the type; ?type written | 119 → 88 rows, ?conflict=5&t=9.4&type=crossing | Pass |
| Download conflicts as CSV | filtered rows, unit-suffixed headers | peachtree-10th-conflicts-crossing.csv: 88 rows; site,conflict_id,t_s,type,vehicle_a,vehicle_b,severity,ttc_min_s,pet_s,drac_max_ft_s2,overla | Pass |
| Download view as PNG | canvas composite + source caption | peachtree-10th-plan-t9.4.png 42797 bytes | Pass |
| Download time–space PNG | PNG of the diagram | peachtree-10th-time-space.png | Pass |
| Shortcuts button / Esc / ? | sheet opens; Esc closes; ? toggles | 1/0/1 | Pass |
| Plan view wheel zoom | view zooms about the pointer; Reset view appears | canvas changed: true, reset button: 1 | Pass |
| Reset view | eases back to the home framing; button hides | button hidden after reset | Pass |
| Plan view click on a vehicle | selects it; inspector; ?v written | ?v=909&t=20.0 · Vehicle | Pass |
| Esc | clears the selection | inspector 0 | Pass |
| Fullscreen button | Fullscreen API on the lab panel; F leaves | on=true (1440×900), off=true | Pass |
| F key | toggles fullscreen | on=true | Pass |
| Pseudo-fullscreen fallback (no API) | panel covers the viewport; Esc leaves | on=true 1440×900 | Pass |
| Key 3 / view switch | 3D view mounts; ?view=3d | ?t=20.0&view=3d | Pass |
| Camera mode Fly | eased switch, WASD look; ?cam=fly | aria-pressed true; view changed; ?t=20.0&view=3d&cam=fly | Pass |
| Camera mode Top | eased fly to overhead, then orthographic; ?cam=top | aria-pressed true; view changed; ?t=20.0&view=3d&cam=top | Pass |
| Camera mode Sensor | eased fly to the pole head (68° FOV); ?cam=sensor | aria-pressed true; view changed; ?t=20.0&view=3d&cam=sensor | Pass |
| Camera mode Orbit | eased tilt back to an oblique view; ?cam removed | aria-pressed true; view changed; ?t=20.0&view=3d | Pass |
| Camera mode Follow (no selection) | disabled with reason in title | disabled | Pass |
| Preset Overview | home composition (conflict zone centred, aspect-aware) | camera flew (view changed) | Pass |
| Preset Approach | NB approach lane view | camera flew (view changed) | Pass |
| Preset Conflict zone | oblique onto the conflict centroid / focus point | camera flew (view changed) | Pass |
| Preset Stop line | low view of the NB stop bar | camera flew (view changed) | Pass |
| Preset Sensor POV | sensor point of view | camera flew (view changed) | Pass |
| Fly: W held | camera moves forward | view changed while W held | Pass |
| Fly: arrow keys | move the camera; clock does not step | t held at 20 | Pass |
| C key | cycles camera mode | Fly → Top | Pass |
| Layers: Point cloud chip | point cloud ↔ vehicle bodies (lamps, shadows) | true → false | Pass |
| Table row → 3D | pair selected, camera frames the pair, near-miss banner | Near-miss at 10.9 s Replay from 3 angles | Pass |
| Follow (with selection) | chase camera behind the primary vehicle | aria-pressed true | Pass |
| Replay from 3 angles | angle 1 of 3 starts (chase A, chase B, overhead) | Angle 1 of 3 #893 chase Stop replay | Pass |
| Stop replay | replay ends, orbit restored | orbit | Pass |
| Minimap click | camera eases to the clicked ground point | view changed | Pass |
| Deep link ?conflict&view&cam&type | view, camera, filter and conflict restored | {"top":"Top","rows":28,"insp":"Conflict pair","filter":"Conflict typeRear-end"} | Pass |
| Repair: protocol switch | experiment description and table change | real 2D line-of-sight occlusion intervals from a v → seeded random gaps 0.5-5.0 s, 1-2 per track, ≥ 1.0 | Pass |
| Repair: truth switch | RMSE table changes | table changed | Pass |
| Repair: occluded track Select | path plot redraws | path changed | Pass |
| SSM panel | SSAM rows at TTC 1.5 s / PET 5.0 s, counts from backend | 1.5 s (SSAM)	28	3	22 / 5.0 s (SSAM)	88	71 | Pass |
| Site tabs | switch site, data reload, readouts update | http://localhost:5173/intersections/lankershim-main?view=3d&type=rear_end · Conflicts / 23 / Critical, excl. overlap / 1 / Worst TTC / 0.55  | Pass |
| Unknown site URL | error box with the API message | 404 Not Found — /intersections/nope: {"detail":"Intersection 'nope' not found (curated fil | Pass |
Console: no errors or warnings during the audit (the 404 of the unknown-site check is the expected API response).
Native browser Esc out of real fullscreen is browser chrome and not scriptable headless; the in-app F exit and the
pseudo-fullscreen Esc path are tested.

## Analysis (backend output vs UI vs SSAM)

| Check | Expected | Observed | Result |
|---|---|---|---|
| Detection thresholds | every rear-end / lane-change event TTC ≤ 1.5 s; every crossing event PET ≤ 5.0 s | 31 TTC events, max ≤ 1.5 s; 88 PET events, max ≤ 5.0 s (0 violations) | Pass |
| Severity bins | TTC ≤ 0.5 / 1.0 / 1.5 s; PET ≤ 1 / 2.5 / 5 s | 0 mismatches over 119 events | Pass |
| DRAC flag | DRAC ≥ 3.4 m/s² = 11.2 ft/s² | 22 events; SSM panel "22"; table shows ft/s² (×3.281) | Pass |
| Totals vs landing | 119 total; 34 critical excl. overlap over 90 s | header 119 / 34 (was 51: overlap flags were counted) | Pass (fixed) |
| SSM sensitivity rows | TTC 1.5 s: 28 rear-end, 3 lane change; PET 5.0 s: 88 crossing, 71 excl. overlap | identical to `/ssm` | Pass |
| Worst TTC readout | min TTC over events | 0.14 s = backend min | Pass |
| Inspector vs table | pair min TTC / PET / max DRAC equal the row | 1.27 s / — / 2.3 ft/s² for row 11.1 s | Pass |
| HUD PET vs table | same PET for a screened pair | was 5.1 s (closest-approach, 1.5 m zone) vs 2.92 s screened; HUD now shows the screened value, "≈" only for unscreened pairs | Pass (fixed) |
| Units | US units in the UI | ft, ft/s², mph; repair RMSE converted m → ft, ft/s (filter q, R stay SI, labelled) | Pass (fixed) |
| Time–space reference | stop line where vehicles stop | was drawn at the intersection centre (y = 0); now NB/SB stop bars from the queue head and the intersection box | Pass (fixed) |

## Road model (derived, not drawn by hand)

Carriageway, MUTCD markings (4 in lines, 10 ft dash / 30 ft gap, double yellow, 24 in stop bars) and stop bars come
from `lanes_geom` and observed positions (`frontend/src/lib/lab/road.ts`, 11 unit tests). Peachtree: lane width 2.9 m (9.5 ft),
box y −17…7 m, NB bar at the box edge, SB bar 1 m ahead of the queue head (6 437 stopped samples). Cross-street lanes
and crosswalks are not observable in NGSIM and are not drawn; the cross street fades out beyond the corridor.

## Motion

Rendering pose (`renderPose`): Catmull–Rom between 10 Hz samples, heading interpolated on the short arc and held
while stopped (< 0.6 m/s), 0.5 s fade where a track starts or ends inside the window, brake lamps from deceleration.
Over all Peachtree tracks at 60 Hz: RMS heading step per frame 7.04° → 1.55° (max 180° → 30°). Remaining spikes are
NGSIM position jumps (e.g. #705, 10 → 14 m/s in 0.1 s), left visible on purpose; Data health counts them.

## Performance (playback running, conflict selected)

| View | Viewport, DPR | Canvas px | fps (rAF) | p95 frame | Result |
|---|---|---|---|---|---|
| 3D point cloud | 1440×900, 2 | 1392×1200 | 119.9 | 9.3 ms | Pass |
| 3D vehicle bodies | 1440×900, 2 | 1392×1200 | 120.0 | 9.2 ms | Pass |
| 3D fullscreen | 1440×900, 2 | 2880×1608 | 119.8 | 9.3 ms | Pass |
| 3D phone | 390×844, 3 (capped 2) | 716×1200 | 119.7 | 9.3 ms | Pass |
| Plan view | 1440×900, 2 | 1392×1040 | 119.9 | 9.2 ms | Pass |
| Plan view phone | 390×844, 3 (capped 2) | 716×840 | 119.2 | 9.2 ms | Pass |

The display caps at 120 Hz. 12 draw calls per 3D frame; 0 draw calls/s when scrolled off screen or paused (counted
by wrapping WebGL2 draw calls). SwiftShader (CPU only, no GPU) gives 6–13 fps: compositor-bound, not a target;
adaptive resolution steps DPR down after two slow seconds. On-screen fps chip shows only while frames are drawn.

## Layout (1440 / 1280 / 1024 / 768 / 390, light + dark, rail expanded ≥ 1100, collapsed below)

No page-level horizontal scroll and no element outside its container at any width, plan and 3D, both themes. The only
overflow is the preset row inside its own scroller on ≤ 600 px containers (deliberate, edge-faded). Transport bar
is one row plus a full-width scrubber; it reflows by container width (≤ 640 px: view+tools / transport / scrubber).
3D overlays reflow by container query (icons-only camera modes ≤ 900 px, stacked phone layout ≤ 600 px), so the
same rules hold inline, in fullscreen and on phones. Lab CSS uses the spec type scale and radii (no size under 12 px
except the compass glyph).
