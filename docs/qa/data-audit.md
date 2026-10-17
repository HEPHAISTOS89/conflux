# Data audit — processed results vs displayed figures (2026-10-17)

Method: independent Python recomputation from `data/curated/` (no project code), compared with the API responses and with the rendered pages read by headless Chromium on the live host (https://conflux-safety.vercel.app) and on the local build after fixes.

## Figures checked

| Figure | Where shown | Independent value | Displayed | Result |
|---|---|---|---|---|
| Conflicts in 90 s | lab header, landing | 119 (file) | 119 | Pass |
| TTC ≤ 1.5 s events; rear-end / lane change; DRAC ≥ 3.4 m/s² | landing TTC instrument, SSM table | 31; 28 / 3; 22 | 31; 28 / 3; 22 | Pass |
| TTC ≤ 1.0 s | TTC instrument | 27 | 25 + 2 = 27 | Pass |
| Worst TTC | lab header | 0.14 s | 0.14 s | Pass |
| Crossing events PET ≤ 5 s; overlap flags | SSM table | 88; 17 | 88; 17 | Pass |
| Critical, excl. overlap and duplicate-pair artefacts | lab header, landing verdict | 51 critical − 17 overlap − 7 ghost pairs = 27 | 27 (after fix; was 25) | Fixed |
| Duplicate tracks | data health | 38 of 170 | 38 / 170 | Pass |
| Jumps, completeness, longest gap | data health | 10 tracks; 100.0 %; 0.0 s | same | Pass |
| Queue NB: vehicles, stopped share, max queue, back of queue | Queues and delay | 46, 46 %, 11, 36.3 m + length → 127 ft | 46, 46 %, 11, 127 ft (after fix; was 119) | Fixed |
| Queue SB | Queues and delay | 54, 67 %, 19, 230 ft | 54, 67 %, 19, 230 ft | Fixed |
| Inferred NS phase | landing signals, phase strip, queue chart | last NS discharge 46.1 s, first EW 55.8 s, last EW 87.8 s | NS green 6.8–45.7, yellow to 49.2, red after; EW green 50.2–90 | Pass (consistent with discharges) |
| Screening: flagged, top EB excess, ped/bike crashes, network rate | screening header, landing verdict | 27 / 395; US 84 1.55/yr; 110; 2.70 per 100 MVMT (per docs/qa/analysis.md) | same | Pass |
| On-system K+A | landing verdict | 43 | 43 | Pass |

## Defect found and fixed: body reference point
NGSIM `Local_X/Local_Y` is the **front-bumper centre** (NGSIM data dictionary). `pipeline/.../ngsim.py` keeps it (only centring on the intersection and smoothing) and `ssm.py` measures `gap = spacing − leader length` accordingly. The frontend drew every vehicle body **centred** on the point (scene.ts, engine.ts bodies + point cloud + pick, PlanView footprint), so each car sat half a length too far forward: queue heads overlapped the stop bar, and the two-circle live TTC, the duplicate test and the back-of-queue were off by len/2. Evidence in the data: the NB queue head (95th percentile of stopped fronts) is at y = −18.4 m while the derived band edge is at −14.5 m, i.e. fronts stop 3.9 m short of the cross street, which is exactly a stop bar plus a crosswalk; centred bodies would have put fronts inside the crosswalk.
Fix: `bodyCentre(x, y, h, len)` in `lib/lab/metrics.ts`, applied in every renderer and metric; queue back-of-queue uses front − length. Tests updated (71 pass).

## Pipeline SSM review (no defect)
A naive rear-end recomputation (same lane within 1.5 m, centre spacing minus half-lengths, TTC = gap / closing speed, ≥ 0.2 s) finds 56 pairs with TTC ≤ 1.5 s, of which 25 are the pipeline's pairs; the pipeline's 28 come from stricter, documented rules (gap ≥ 1 m, follower ≥ 2 m/s, ≥ 0.3 s contiguous, closing rate consistent with the change in spacing). The extra naive pairs are dominated by the duplicate tracks (654/636, 705/704, 831/830 …) and sub-metre gaps, which the pipeline rightly treats as NGSIM position artefacts. Naive minima (0.01–0.1 s) are therefore lower than the served minima (0.14–0.6 s) for the same reason.

## Hosting note
Production moved to https://conflux-safety.vercel.app during this audit (parallel rebrand). On the old host https://roadscope-ai-demo.vercel.app the `/api/*` rewrite now answers `308 → conflux-safety.vercel.app/api/…`; the browser does not complete the cross-origin chain, so the old host's pages show empty figures and "Trajectory replay unavailable". The new host serves every figure above correctly.
