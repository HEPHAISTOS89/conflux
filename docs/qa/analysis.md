# Data-analysis and control QA — Screening, Corridor, Brief, VRU (2026-10-17)

Evidence for the owner addendum §5. Independent recomputation: a scratch script with its own geometry (per-point cos-lat projection, vectorised point-to-polyline distance), its own NB2 refit (statsmodels `NegativeBinomial`, constant α, as a cross-check of the pipeline's per-mile-k scipy fit), and its own rate/critical-rate/EB code, compared field by field with the running API (`/api/v1`, local curated data after regeneration). Controls tested in headless Chromium (Playwright) against a local vite + FastAPI with route interception for error states.

## Findings and fixes

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | `/screening` ranked all 443 segments; the 48 without an inventory/AADT match (4 crashes) were appended with null measures, so every "of N" said 443 and the crash readout said 114 while the screened population is 395 / 110. Frequency ranks could include unscored segments. | wrong denominators on Screening, Brief, landing | `queries.screening` ranks only scored segments (`rank` set) and reports them in `unscreened`; Screening lede and Brief appendix name the 48. Test added. |
| 2 | Corridor `crashes_per_yr` summed rounded per-segment rates (US 84 9.98 instead of 10.00; US 62/82 6.97, Loop 289 4.97); station densities used the rounded rate too. | small numeric drift | pipeline uses integer counts / Y; summary gains `crashes_ka`, `seg_len_mi`, `crashes_per_mi_yr`. Test added. |
| 3 | Corridor headline "crash density" = crashes/yr ÷ number of segments (labelled per mile). | unit error (≈1–10 %) | uses `crashes_per_mi_yr` = crashes ÷ Y ÷ screened segment miles. |
| 4 | TxDOT Statewide Speed 2024 has no value above 65 mph (352 of 2,738 records exactly 65): a cap. On 70–75 mph roads "operating below posted" was an artefact, biasing the corridor operating-speed readout and the "operating − posted" scatter. | misleading | 65 read as "≥ 65"; capped stations posted > 65 excluded from operating-vs-posted figures (count shown); MetricInfo states the cap. |
| 5 | Corridor Spearman ρ treated 0.25-mi stations as independent though they share their segment's crash value (pseudo-replication). | overstated n | ρ computed per segment (mean station speed vs segment density); n shown as segments (stations). |
| 6 | VRU KA shares (light, speed, yield, peak window, overall) were computed after the KABCO severity filter, so hiding K or A silently changed every "KA share". | misleading under a control | KA shares ignore the severity filter; counts/map/CSV respect it; lede switches wording when the filter is on. |
| 7 | Darkness and posted speed are correlated; the separate light and speed charts could credit one with the other's effect. | unsupported attribution | new "Darkness and speed together" 2×2 with Wilson CIs and n; backend `severity_by_condition` drives a KA-by-condition table and two data-driven next steps in the Brief. |
| 8 | Landing verdict row says KA are on "state roads" but uses `/vru/summary.by_severity` (all roads: 86 KA; on-system is 43). | label error (file not owned here) | `/vru/summary.on_system = {total: 114, ka: 43}` added; landing owner should use it or relabel "all roads". |
| 9 | Brief verdict/readout said "state-system miles" for segments. | wording | "screened one-mile segments", readout unit "of 395 segments". |
| 10 | FARS `fetched_at` in the manifest was the build time, not the download time. | provenance | uses the cached zip's mtime. |
| 11 | Collector/Local facility: 2 crashes on 170 segments; ranks below the crash sites are ties near zero. | uninformative ranking | page shows a warning when the filtered group has < 10 crashes. |

Checked and correct (no change): no duplicate Crash_ID (307); CRIS `Crash_Date` is epoch ms at 00:00 UTC, so the UTC calendar date is the crash date (local-time conversion would shift all 307 a day back — verified against `Day_of_Wee`, 307/307 agree in UTC, 0/307 in UTC−6); `Crash_Year` = date year for all; noon fix (24 "12 AM" records, daylight ones → 12 h); no overlapping segment DFO ranges and DFO span = LEN_M on all 395 joined segments; all 114 on-system crash points lie ≤ 5 m from a segment; units (mi, veh/d, per 100 MVMT, crashes/yr, Y = 3) consistent; AADT count year is post-period (already disclosed in `spf.json → diagnostics.aadt`).

## (a) Calculation checks

| Metric | Independent | API | Result |
|---|---|---|---|
| On-system CRIS crash points snapped ≤ 5 m | 114 | 114 | match |
| Max snap distance of on-system points (m, ≤5) | True | True | match |
| Segments whose crash count differs | 0 | 0 | match |
| Segments whose K+A count differs | 0 | 0 | match |
| Duplicate Crash_ID in CRIS layer | 0 | 0 | match |
| Crash rate R = N·1e8/(365·Y·AADT·L), max \|Δ\| (per 100 MVMT, API rounded 0.1) | True | True | match |
| Critical rate Rc (site-type Ra, P=0.95 one-sided k=1.645), max \|Δ\| | True | True | match |
| Critical ratio R/Rc, max \|Δ\| (API rounded 0.01) | True | True | match |
| SPF μ (crashes/yr), max \|Δ\| (API rounded 0.01) | True | True | match |
| EB expected E with w = 1/(1+(k/L)·μ·Y), max \|Δ\| | True | True | match |
| EB excess E − μ, max \|Δ\| | True | True | match |
| Median EB weight w · Urban interstate/freeway | 1.0 | 1.0 | match |
| Median EB weight w · Urban principal arterial | 0.692 | 0.692 | match |
| Median EB weight w · Urban minor arterial | 0.986 | 0.986 | match |
| Median EB weight w · Urban collector/local | 0.978 | 0.978 | match |
| Median EB weight w · Rural interstate/freeway | 0.98 | 0.98 | match |
| Median EB weight w · Rural principal arterial | 0.982 | 0.982 | match |
| Median EB weight w · Rural minor arterial | 0.988 | 0.988 | match |
| Median EB weight w · Rural collector/local | 0.996 | 0.996 | match |
| Rank 1 segment (EB excess) | US0084-KG_01_070 | US0084-KG_01_070 | match |
| Ranks identical for all scored segments | 0 | 0 | match |
| NB2 refit β(ln AADT) · Urban interstate/freeway (statsmodels, const α) | 0.973 | 0.973 | match |
| NB2 refit k · Urban interstate/freeway | 0.0 | 0.0 | match |
| MAD · Urban interstate/freeway | 0.494 | 0.494 | match |
| Pearson χ²/df · Urban interstate/freeway | 1.379 | 1.379 | match |
| CURE % outside ±2σ* · Urban interstate/freeway | 1.7 | 1.7 | match |
| NB2 refit β(ln AADT) · Urban principal arterial (statsmodels, const α) | 1.068 | 1.071 | match |
| NB2 refit k · Urban principal arterial | 1.01 | 1.025 | match |
| MAD · Urban principal arterial | 0.786 | 0.786 | match |
| Pearson χ²/df · Urban principal arterial | 0.827 | 0.827 | match |
| CURE % outside ±2σ* · Urban principal arterial | 22.7 | 22.7 | match |
| NB2 refit β(ln AADT) · Urban minor arterial (statsmodels, const α) | -0.096 | -0.095 | match |
| NB2 refit k · Urban minor arterial | 0.136 | 0.139 | match |
| MAD · Urban minor arterial | 0.424 | 0.424 | match |
| Pearson χ²/df · Urban minor arterial | 1.051 | 1.051 | match |
| CURE % outside ±2σ* · Urban minor arterial | 12.7 | 12.7 | match |
| Screened segments (rank ≠ null) | 395 | 395 | match |
| Sites flagged EB excess > 0 | 27 | 27 | match |
| Confirmed (flagged and R/Rc > 1) | 6 | 6 | match |
| Σ EB excess over flagged (crashes/yr) | 5.54 | 5.54 | match |
| Ped/bike crashes on screened segments (3 yr) | 110 | 110.0 | match |
| Network ped/bike rate (per 100 MVMT) | 2.695 | 2.695 | match |
| Top value under critical_ratio | 2.82 | 2.82 | match |
| Top value under rate | 97.1 | 97.1 | match |
| Top value under frequency | 9 | 9.0 | match |
| f_system=3 filter count | 94 | 94 | match |
| Corridor us-84: ped/bike crashes 3 yr | 30 | 30 | match |
| Corridor us-84: crashes/yr | 10.0 | 10.0 | match |
| Corridor us-84: segment miles | 35.0 | 35.0 | match |
| Corridor us-84: density /mi/yr | 0.286 | 0.286 | match |
| Corridor us-84: stations inconsistent with their segment | 0 | 0 | match |
| Corridor us-62-82: ped/bike crashes 3 yr | 21 | 21 | match |
| Corridor us-62-82: crashes/yr | 7.0 | 7.0 | match |
| Corridor us-62-82: segment miles | 44.36 | 44.36 | match |
| Corridor us-62-82: density /mi/yr | 0.158 | 0.158 | match |
| Corridor us-62-82: stations inconsistent with their segment | 0 | 0 | match |
| Corridor loop-289: ped/bike crashes 3 yr | 15 | 15 | match |
| Corridor loop-289: crashes/yr | 5.0 | 5.0 | match |
| Corridor loop-289: segment miles | 26.07 | 26.07 | match |
| Corridor loop-289: density /mi/yr | 0.192 | 0.192 | match |
| Corridor loop-289: stations inconsistent with their segment | 0 | 0 | match |
| Corridor i-27: ped/bike crashes 3 yr | 7 | 7 | match |
| Corridor i-27: crashes/yr | 2.33 | 2.33 | match |
| Corridor i-27: segment miles | 17.03 | 17.03 | match |
| Corridor i-27: density /mi/yr | 0.137 | 0.137 | match |
| Corridor i-27: stations inconsistent with their segment | 0 | 0 | match |
| Corridor sh-114: ped/bike crashes 3 yr | 9 | 9 | match |
| Corridor sh-114: crashes/yr | 3.0 | 3.0 | match |
| Corridor sh-114: segment miles | 12.03 | 12.03 | match |
| Corridor sh-114: density /mi/yr | 0.249 | 0.249 | match |
| Corridor sh-114: stations inconsistent with their segment | 0 | 0 | match |
| Corridor fm-2255: ped/bike crashes 3 yr | 11 | 11 | match |
| Corridor fm-2255: crashes/yr | 3.67 | 3.67 | match |
| Corridor fm-2255: segment miles | 8.66 | 8.66 | match |
| Corridor fm-2255: density /mi/yr | 0.423 | 0.424 | match |
| Corridor fm-2255: stations inconsistent with their segment | 0 | 0 | match |
| Corridor fm-835: ped/bike crashes 3 yr | 5 | 5 | match |
| Corridor fm-835: crashes/yr | 1.67 | 1.67 | match |
| Corridor fm-835: segment miles | 10.79 | 10.79 | match |
| Corridor fm-835: density /mi/yr | 0.155 | 0.155 | match |
| Corridor fm-835: stations inconsistent with their segment | 0 | 0 | match |
| VRU crashes | 307 | 307 | match |
| VRU severity K | 42 | 42 | match |
| VRU severity A | 44 | 44 | match |
| VRU severity B | 120 | 120 | match |
| VRU severity C | 92 | 92 | match |
| VRU severity O | 9 | 9 | match |
| VRU KA | 86 | 86 | match |
| VRU KA on-system only | 43 | 43 | match |
| VRU by year | {'2021': 111, '2022': 88, '2023': 108} | {'2021': 111, '2022': 88, '2023': 108} | match |
| Crash_Date UTC weekday == Day_of_Wee (all) | 307 | 307 | match |
| API date == UTC date of Crash_Date (all) | 307 | 307 | match |
| Hour-of-week grid (168 cells) identical | [[1, 1, 0, 0, 1, 0, 1, 1, 1, 1, 0, 2, 3, 0, 0, 0, 5, 1, 4, 2, 4, 3, 1, 0], [1, 0, 1, 1, 0, 3, 1, 4, 3, 2, 0, 1, 0, 2, 3, 1, 2, 3, 4, 2, 3, 5, 1, 1], [1, 1, 0, 0 | [[1, 1, 0, 0, 1, 0, 1, 1, 1, 1, 0, 2, 3, 0, 0, 0, 5, 1, 4, 2, 4, 3, 1, 0], [1, 0, 1, 1, 0, 3, 1, 4, 3, 2, 0, 1, 0, 2, 3, 1, 2, 3, 4, 2, 3, 5, 1, 1], [1, 1, 0, 0 | match |
| Crashes at 12:00–12:59 after noon fix | 14 | 14 | match |
| Crashes at 00:00–00:59 after noon fix | 10 | 10 | match |

KA shares used on VRU/Brief (independent, Wilson 95 %):

| Group | n | KA | KA % | CI |
|---|---|---|---|---|
| Daylight | 151 | 21 | 13.9 | 9.3–20.3 |
| Dark, lighted | 90 | 32 | 35.6 | 26.4–45.9 |
| Dark, not lighted | 54 | 31 | 57.4 | 44.2–69.7 |
| Posted ≤ 35 mph | 139 | 17 | 12.2 | 7.8–18.7 |
| Posted ≥ 50 mph | 56 | 32 | 57.1 | 44.1–69.2 |
| All | 307 | 86 | 28.0 | 23.3–33.3 |
| Dark and posted ≥ 50 mph | 36 | 24 | 66.7 | 50–80 |
| Daylight and posted < 50 mph | 132 | 14 | 10.6 | 6–17 |

## (b) Control checklist

Headless Chromium 1440×900 unless stated; layout rows sweep 1440/1280/1024/768/390 × light/dark (overflow = any element outside the viewport not inside a scroll container, or page-level horizontal scroll).

| Page | Control | Expected | Observed | Result |
|---|---|---|---|---|
| Screening | Initial ranking | 395 screened rows, unscored excluded, lede names 48 unranked | 395 rows; lede: 395 one-mile on-system segments in Lubbock County, ranked by pedestrian and bicyclist crashes (48 more lack an inventory or AADT match and a | pass |
| Screening | Measure: Critical rate ratio | URL method=critical_ratio; first row = API rank 1 () | url method=critical_ratio; top row US 84; API US 84 69.007 | pass |
| Screening | Measure: Crash rate | URL method=rate; first row = API rank 1 () | url method=rate; top row FM 835; API FM 835 2 | pass |
| Screening | Measure: Crash frequency | URL method=frequency; first row = API rank 1 () | url method=frequency; top row US 84; API US 84 69.007 | pass |
| Screening | Measure: EB excess | URL method=eb_excess; first row = API rank 1 () | url method=eb_excess; top row US 84; API US 84 69.007 | pass |
| Screening | Facility = Principal arterial | rows = API count (94); URL group=; readouts recomputed | 94 rows; url method=eb_excess&group=Principal+arterial; readouts District TxDOT Lubbock County 152 · Lubbock Data build 2026-10-17 Sources TxDOT · NHTSA FA | pass |
| Screening | Facility = Collector/Local (sparse) | warning that ranks are ties near zero (2 crashes) | Only 2 crashes on 170 Collector/Local segments: below the crash-bearing sites, ranks are ties near zero and carry no inf | pass |
| Screening | Row click selects segment | URL seg=<id>; segment card opens with rank #3 | seg=US0084-KG_01_071; card: US 84 #3 Facility Principal arterial · 6 ln Posted / operating 45 / 31.8 mph AADT · trucks 12,711 ve | pass |
| Screening | J steps to next row | seg changes to rank 4 | seg=US0084-KG_01_069 | pass |
| Screening | Esc clears selection | seg removed, card closed | seg=null; card=0 | pass |
| Screening | URL round-trip (method, group, seg) | Crash rate pressed, Minor arterial, card for seg if in group | pressed=Crash rate; card=1 | pass |
| Screening | Map click selects segment | clicking a network line sets seg and scrolls table | hit=true seg=FM2255-KG_007 | pass |
| Screening | Download CSV | roadscope-screening-<method>-<group>.csv | roadscope-screening-eb_excess-all.csv | pass |
| Screening | Download PNG (map figure) | PNG file | roadscope-screening-eb_excess-all.png | pass |
| Screening | Copy link | clipboard = current URL, label Copied | http://localhost:5181/screening?seg=FM2255-KG_007 | pass |
| Screening | Rank-stability line click | selects that segment (seg in URL) | seg=FM2255-KG_007 | pass |
| Screening | SPF site-type switch | coefficient table and CURE change | 3 site types; tables differ=true | pass |
| Screening | API 500 → error → Retry | error box with Retry; Retry loads ranking without reload | err="Ranking unavailable: 500 Internal Server Error — /screening?"; rows after retry=395 | pass |
| Corridor | Headline density | crashes/yr ÷ segment miles = 0.286 | Crash density 0.29 /mi/yr Worst DFO 69.25 US 84 · 3.00/mi/yr Operating speed 46.5 mph · 55 posted · 68 stations | pass |
| Corridor | Click diagram pins station | URL at=ROUTE:DFO; readout shows DFO | at=US0084-KG:64; read=DFO 64.00 US 84 | pass |
| Corridor | → steps pinned station | at advances 0.25 mi | US0084-KG:64 → US0084-KG:64.25 | pass |
| Corridor | Reload keeps pinned station | readout shows same DFO | DFO 64.25 US 84 | pass |
| Corridor | Esc unpins | at removed; summary shown | at=null | pass |
| Corridor | Scatter axis: Operating − posted | x=delta in URL; ρ per segment; capped stations omitted note | url x=delta; ρ -0.11 n = 20 segments (68 stations) · 14 stations above posted; foot: Speed 2024, which reports no value above 65 mph; 64 stations posted above 6 | pass |
| Corridor | Corridor tab I-27 | route /corridors/i-27; title I-27 | http://localhost:5181/corridors/i-27?x=delta I-27 | pass |
| Corridor | Download CSV | stations CSV | roadscope-corridor-i-27-stations.csv | pass |
| Corridor | Download PNG (SLD) | PNG | roadscope-corridor-i-27-sld.png | pass |
| Corridor | Unknown corridor id | error box with Retry, no crash | Corridor unavailable: 404 Not Found — /corridors/nope: {"detail":"Corridor 'nope' not foun | pass |
| VRU | Year 2022 | crash count = 88 (CRIS 2022); URL year=2022 | 307 → 88; url year=2022 | pass |
| VRU | Toggle Cyclist off | count drops by 2022 cyclists; URL modes=bike | 66; url modes=bike&year=2022 | pass |
| VRU | Reload keeps filters | same count after reload | 66 | pass |
| VRU | Hide K severity | count = 307 − 42 = 265; KA shares unchanged (severity-independent) | count 265; finding before "Dark, unlit: 57.4% KA (n = 54) against 13.9% in daylight (n " after "Dark, unlit: 57.4% KA (n = 54) against 13.9% in daylight (n " | pass |
| VRU | Light row drill-down (Dark, not lighted) | count = 54; URL focus=light:dark-unlit; drill chip shown | 54; url focus=light%3Adark-unlit | pass |
| VRU | Esc clears drill-down | count back to 307 | 307 | pass |
| VRU | Darkness × speed strata | dark ≥50: 67% (n 36); day <50: 11% (n 132) | KA share of crashes by light condition (rows) and posted speed (columns), 95% Wilson intervals \| Light	Posted under 50 mph	Posted 50 mph or more \| Daylight	11 | pass |
| VRU | Heatmap cell click | URL cell=d-h; count = cell value | 3; url cell=4-17 | pass |
| VRU | Reset | all filters off, URL clean, 307 | 307 url= | pass |
| VRU | Yield source switch | URL yield=factor; cards recount | url yield=factor; Motorist failed to yield 42 24% of yield-coded 3 KA · 7.1% (CI 2–19%) Pedestrian | pass |
| VRU | Download CSV (crashes) | CSV | roadscope-vru-crashes-2021-2023.csv | pass |
| VRU | Hour-of-week PNG | PNG | roadscope-vru-hour-of-week-2021-2023.png | pass |
| VRU | Deep link ?year=2021&hide=O&focus=speed:50-55 | filters restored from URL | 16 drill="Posted 50–55 mph" | pass |
| Brief | Verdict figures | 27 of 395 flagged, 6 confirmed (same rule as Screening/landing) | 27 of 395 screened one-mile state-system segments have expected ped/bike crashes above the SPF prediction; 6 also exceed the critical rate. Highest EB excess: U | pass |
| Brief | KA by condition table | dark unlit 57% (n 54), ≥50 mph 57% (n 56) | KA share of VRU crashes by light condition and posted speed, with 95% Wilson intervals \| Condition	Crashes	KA	KA share · 95% CI \| Dark, not lighted	54	31	57%  | pass |
| Brief | Download CSV (flagged sites) | CSV | roadscope-lubbock-county-flagged-sites.csv | pass |
| Brief | Site link → Screening | opens /screening?seg=<rank 1> | http://localhost:5181/screening?seg=US0084-KG_01_070 | pass |
| Brief | Print brief (print CSS → PDF) | actions hidden; PDF renders | pdf 581386 bytes; no-print visible=false | pass |
| Layout | /screening @1440 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /corridors/us-62-82 @1440 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /vru @1440 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /brief @1440 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /screening @1280 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /corridors/us-62-82 @1280 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /vru @1280 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /brief @1280 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /screening @1024 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /corridors/us-62-82 @1024 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /vru @1024 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /brief @1024 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /screening @768 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /corridors/us-62-82 @768 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /vru @768 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /brief @768 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /screening @390 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /corridors/us-62-82 @390 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /vru @390 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /brief @390 light | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /screening @1440 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /corridors/us-62-82 @1440 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /vru @1440 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /brief @1440 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /screening @1280 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /corridors/us-62-82 @1280 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /vru @1280 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /brief @1280 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /screening @1024 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /corridors/us-62-82 @1024 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /vru @1024 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /brief @1024 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /screening @768 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /corridors/us-62-82 @768 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /vru @768 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /brief @768 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /screening @390 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /corridors/us-62-82 @390 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /vru @390 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| Layout | /brief @390 dark | no page-level horizontal scroll, no element past viewport | pageScroll=false  | pass |
| All | Console errors | none (excluding intentional 500/404 tests) | none | pass |

Not automated: rail collapsed state is the ≤ 1100 px top bar, covered by the 1024/768/390 rows; touch gestures; screen-reader announcement wording. The corridor ←/→ step needs the pin's effect to commit first; under software WebGL a key pressed < 300 ms after the click can be dropped (real browsers unaffected).

## Curated files changed (republish to S3)

- `data/curated/corridors.json` (finding 2/3: summary fields, station densities)
- `data/curated/manifest.json` (generated_at; FARS fetched_at)

`network.geojson`, `spf.json`, `vru_crashes.geojson`, `fatal_crashes.geojson` regenerate byte-identical. The shared dev API on :8000 was not restarted (no --reload); restart it to serve the backend changes.
