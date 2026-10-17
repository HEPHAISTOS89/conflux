# RoadScope — Lubbock Proactive Safety Portal · SPEC v1

Audience: TransTech Lab (Texas Tech) — roadside LiDAR perception, proactive safety (conflicts / near-crash), trajectory repair under occlusion (Luo 2025), LiDAR-calibrated VISSIM + Negative Binomial crash models (Igene, Luo et al. 2024), pedestrian failure-to-yield (USDOT 2026, SPAG region), TxDOT Lubbock District support. The portal answers *their* questions in *their* vocabulary.

## Product: modules (frontend routes)
| Route | Module | Core content |
|---|---|---|
| `/` | Atlas | Lubbock County network map coloured by crash density; true KPIs; the "story" in 3 beats (network → corridors → intersections). |
| `/screening` | Network screening (HSM Part B) | One-mile segments ranked by crash frequency, crash rate per 100 MVMT, critical-rate ratio, EPDO, EB excess expected crashes. Method switch, SPF plot, ranked table ↔ map. |
| `/corridors/:id` | Corridor profile | Straight-line diagram along DFO (TxDOT SLD style): lanes, speed limit, AADT, truck %, 2024 operating speed (AM/MD/PM), crashes per mile. Corridors: US-84, US-62/82 (19th St/Marsha Sharp), Loop 289, I-27, SH-114, FM 2255, 82nd St. |
| `/vru` | Vulnerable road users | Ped/bike crashes 2018+ (KABCO, PBCAT type, light, hour×day heatmap, corridor). Framed for failure-to-yield countermeasure siting. |
| `/intersections/:id` | Proactive safety lab | Real NGSIM trajectories (Lankershim / Peachtree signalised arterials, 10 Hz). 2D plan + 3D roadside-LiDAR view (pole sensor, FOV, point-cloud vehicles). Conflicts: TTC, PET, DRAC; rear-end/crossing classification. Occlusion repair demo: inject occlusion gaps → repair (constant-accel Kalman RTS smoother) → RMSE vs ground truth. |
| `/methods` | Methods & data | Equations, parameters, provenance, licences, limitations, references (incl. lab papers). |
| `/platform` | Platform | Live AWS architecture, pipeline runs, data freshness, CloudWatch metrics, costs guardrail. |
| `/ask` | Analyst (Bedrock) | Natural-language questions answered with tool calls on the API; cites tables. Deterministic fallback if Bedrock unavailable. |

## Data sources (verified 2026-10-17)
`B=https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services` (TxDOT, © TxDOT, informational, attribute + disclaimer)
- `Roadway_Inventory_2024/FeatureServer/0` `where=CO=152` (11,156) — HWY, STE_NAM, F_SYSTEM, NUM_LANES, SPD_MAX, AADT_TRUCKS, TRK_AADT_PCT, FRM_DFO, TO_DFO.
- `TxDOT_AADT/FeatureServer/0` Lubbock envelope `-102.1,33.45,-101.55,33.75` (5,785) — RTE_NM, AADT_CUR, BEGIN_DFO, END_DFO.
- `TxDOT_Statewide_Speed_2024/FeatureServer/0` envelope (2,738) — RIA_RTE_ID, FRM/TO_DFO, ALLSPEED, TRKSPEED, AM/MD/PM, ALLREFSPEED.
- `Segment_Crash__Results_9a0c7/FeatureServer/243` envelope (443) — RouteID, START_M, END_M, LEN_M, SUM_CRASH_, Crash_Rate.
- `Active_Transportation_Crashes_f8c8e/FeatureServer/1` envelope (307) — Crash_ID, Crash_Seve, Crash_Date/Time, Latitude/Longitude, PBCAT_Ped/Bike, PCount, BCount, KACount, Light_Cond, Speed_Limi, Street_Nam, Highway_Nu.
- FARS `https://static.nhtsa.gov/nhtsa/downloads/FARS/{Y}/National/FARS{Y}NationalCSV.zip`, ACCIDENT.csv STATE=48 COUNTY=303, 2018–2023 (public domain).
- NGSIM `https://data.transportation.gov/resource/8ect-6jqj.json` (SODA; CC BY-SA 3.0) — location `lankershim`/`peachtree`, 60–120 s windows.
All requests paginate (`resultOffset`, 2,000 max) and use `outSR=4326`.

## Curated data contract (`data/curated/`, also `s3://<bucket>/curated/`)
- `network.geojson` — LineString per segment: `{seg_id, route, name, f_system, lanes, speed_limit, aadt, truck_pct, len_mi, crashes_total, crash_years, rate_100mvmt, crit_rate, crit_ratio, epdo, spf_pred, eb_expected, eb_excess, rank}`.
- `corridors.json` — `[{id, name, routes[], len_mi, stations:[{dfo, lanes, speed_limit, aadt, truck_pct, speed_all, speed_am, speed_md, speed_pm, crashes_per_mi}], summary:{…}}]`.
- `vru_crashes.geojson` — Point: `{id, date, hour, dow, year, severity(K/A/B/C/O), mode(ped|bike), pbcat, light, speed_limit, street, on_system}`.
- `fatal_crashes.geojson` — Point: `{id, year, month, hour, fatals, route, light, weather}`.
- `spf.json` — `{form:"N=exp(b0)·AADT^b1·L", b0, b1, k(overdispersion), n, aic, by_class:{…}` (pooled ln-AADT model, kept for compatibility) `, outcome, crash_period, crash_years, site_types:{<Urban|Rural> <facility>:{segments, crashes, mean_rate, fitted, model_used, model:{spec, coef, se, k, k_convention, n, aic, …}|null, candidates, gof:{mad, pearson_chi2, df, chi2_df}, cure:{columns, points, pct_outside}, eb_weight_median}}, fallback, pooled_gof, system_gof, points, diagnostics:{overdispersion, crash_field, aadt, join}}`.
- `intersections/<id>.json` — `{id, name, source, hz, bbox, lanes_geom, tracks:[{id, cls, len_m, w_m, pts:[[t,x,y,v,a,lane]]}]}` (local metres).
- `intersections/<id>_conflicts.json` — `[{id, t, a, b, type(rear_end|crossing|lane_change), ttc_min, pet, drac_max, severity}]`.
- `intersections/<id>_repair.json` — `{tracks:[{id, gaps:[[t0,t1]], raw:[[t,x,y]], repaired:[[t,x,y]], rmse_m, speed_rmse}] , summary:{…}}`.
- `manifest.json` — `{generated_at, sources:[{id, url, licence, records, fetched_at, sha256}], metrics:{…}}`.

## Methods (exact)
- Crash rate R = N·10⁸ / (365·Y·AADT·L) (per 100 MVMT).
- Critical rate Rc = Ra + k·√(Ra/M) + 1/(2M), k=1.645 (95%), M = exposure in 100 MVMT, Ra = class mean rate; ratio = R/Rc.
- EPDO: not computed (no sourced severity weights; `epdo` is null).
- Segment crash outcome: on-system ped/bike/e-scooter CRIS crashes (Active Transportation Crashes, 2021–2023, Y = 3) snapped ≤ 5 m to segments. `SUM_CRASH_` is an undocumented SATP injury-weighted ped/bike score (r ≈ 0.94 with those crashes), kept as `satp_crash_score` only (evidence in `spf.json → diagnostics.crash_field`).
- SPF: NB2 ML, ln μ = b0 + b1·ln AADT + Σ b_j x_j + ln L (x ∈ lanes, divided, posted speed; AIC-selected, ≤ 1 covariate per 10 crashes) per HSM-style site type (Roadway Inventory RU rural/urban × F_SYSTEM group); site types with < 30 segments or < 20 crashes use a pooled site-type model (ln AADT, urban, lanes, speed). k per mile, k_seg = k/L. EB: w = 1/(1+k_seg·μ_Y), E = w·μ_Y + (1−w)·N; excess = E − μ. Diagnostics: MAD, Pearson χ²/df, CURE (Hauer & Bamfo 1997, ±2σ*). Critical rate reference population = site type.
- SSM (FHWA SSAM defaults): TTC = gap/Δv when follower faster, detection TTC ≤ 1.5 s; PET over the shared swept-footprint zone (0.5 m raster), detection PET ≤ 5.0 s, simultaneous occupancy flagged; DRAC = Δv²/(2·gap) reported as a flag at ≥ 3.4 m/s² (11.2 ft/s², AASHTO 2018), not a detection criterion.
- Occlusion repair: remove 0.8–3 s windows on random tracks; constant-acceleration Kalman filter + RTS smoother over gaps; report position RMSE and speed RMSE vs held-out truth, plus linear-interp baseline.

## API (FastAPI, `/api/v1`)
`GET /health` · `/meta` (manifest) · `/network?metric=` (geojson) · `/screening?method=&limit=&f_system=` · `/spf` · `/corridors` · `/corridors/{id}` · `/vru?mode=&severity=&year=` · `/vru/summary` · `/fatal` · `/intersections` · `/intersections/{id}?t0=&t1=&stride=` · `/intersections/{id}/conflicts?type=&max_ttc=` · `/intersections/{id}/repair` · `/platform/status` (S3 manifest, last runs, CloudWatch metrics) · `POST /ask {question}` → `{answer, citations[], tool_calls[], model, fallback:bool}`.

## AWS (us-east-2, CDK Python, tags Project=RoadScope)
S3 lake (raw/, curated/; versioned, encrypted, private) · Lambda `ingest` (ArcGIS/FARS → raw → curated light transforms) on EventBridge weekly schedule · EC2 t4g.small batch worker for heavy NGSIM/SSM/repair jobs, started by EventBridge Scheduler, runs job from S3, self-stops (SSM Run Command) · Lambda API (FastAPI+Mangum) behind CloudFront (cache curated GETs) · Bedrock Converse (Claude Haiku 4.5) with tool use, IAM scoped to model ARN · CloudWatch dashboard, alarms (API 5xx, ingest failure, duration), structured JSON logs, DLQ on ingest · IAM least privilege per function · Budget alarm (exists: roadscope-transtech-cap $40/mo).

## Design direction — "Plan sheet / LiDAR night"
Engineering-drawing language: TxDOT plan-sheet title block, survey grid, DFO stationing ticks, hairline ink linework, sheet numbers. Light "paper" theme (warm off-white, ink navy, signal amber, KABCO severity ramp red→grey). Dark "LiDAR night" theme for the intersection lab (point clouds, intensity ramp). Type: a grotesk for UI + tabular mono for numbers; serif only for methods prose. Motion purposeful: stationing ticks drawing in, map camera flights between corridors, replay scrubbing, conflict pulses at TTC events, count-up only for KPIs once. Respect prefers-reduced-motion. No gradients/glow/emoji/decorative icons.

## Definition of done
Every module wired to live API; real data with provenance shown; tests (pipeline unit + API contract); AWS stack deployed and documented; Vercel production; browser-verified desktop/tablet/mobile, no console errors, a11y AA; README written as a research-grade technical report.
