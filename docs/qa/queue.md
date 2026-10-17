# Intersection lab: queues and delay (2026-10-17)

## What was built
- `frontend/src/lib/lab/queue.ts` (pure, 9 vitest cases in `queue.test.ts`):
  - `queueProfile(tracks, dir, stopBarY, hz, duration)`: per 10 Hz frame, stopped vehicles (v < 0.5 m/s, HCM 7th ed. ch. 19 stopped-delay convention) upstream of the stop bar, and back of queue = distance from the bar to the rear bumper (centre − len/2) of the farthest stopped vehicle. Summary: max queue, time of max, max back of queue (m and ft), time-weighted mean queue, vehicles that stopped.
  - `stoppedDelay(tracks, dir, stopBarY, hz, approachM)`: per vehicle, stopped delay and an approximate control delay = travel time from the entry line (approachM upstream of the bar, or the first sample when the track starts inside the segment) to the bar minus the same distance at the 85th-percentile spot speed at the entry line (`spotSpeeds` from metrics.ts). Vehicles queued when the window opens or still upstream when it closes are kept and flagged `censored` (lower bound). Summary: mean stopped delay, mean control delay, stopped share, HCM 7th ed. Exhibit 19-8 LOS (A ≤ 10, B ≤ 20, C ≤ 35, D ≤ 55, E ≤ 80, F > 80 s/veh).
  - `approachReach`: the segment is capped at 60 m and shortened to what the NGSIM grid actually covers (90th percentile of first-seen distance − 1 m). Needed because the grid ends ~37 m south of the NB bar.
  - `phaseIntervals(plan, group)`: run-length intervals of the inferred lamp state for drawing; `signalGeometry(data)`: bars and cross-street middle from road.ts, the same geometry the 3D world uses for `inferSignals`.
- `frontend/src/components/lab/QueuePanel.tsx`: section "Queues and delay" (after Spot speeds, before Threshold sensitivity), wrapped in `ClockCtx.Provider`. SVG step chart of queue (veh) vs time for NB and SB with the inferred NS phase (green/red/yellow bands) behind; time cursor and live per-approach queue readout driven by `useClockFrame` (no React re-render per frame); click or drag on the chart seeks the shared clock. Table per approach: vehicles, stopped share, max queue, max back of queue ft (m in title), mean stopped delay, mean control delay (≥ when lower bounds are included), LOS. Info button holds the method, citations, per-approach segment / v85 / n, and the estimate caveat. CSV download of per-vehicle delays. The chart viewBox follows the container width so tick text never falls below 12 px.
- `frontend/src/components/Player.tsx`: optional `phases` prop → 4 px strip of inferred NS phase under the scrubber (title "Signal phase, inferred from flow (NS group)"), `--go` / `--stop` at 55 % opacity, `--caution` for yellow. Wired in `Intersection.tsx`, which computes the plan once (`signalGeometry` + `inferSignals`) for both the strip and the panel.
- `frontend/src/styles/intersection.css`: `.queue-*` and `.player-phase` rules, tokens only.

## Numbers observed, Peachtree St NE at 10th St NE (NGSIM, 90 s window)
Stop bars from behaviour: NB y = −17.4 m, SB y = 7.43 m. Inferred NS phase: red 0–6.8 s, green 6.8–45.7 s, yellow 45.7–49.2 s, red 49.2–90 s (one partial cycle).

| Approach | Vehicles | Stopped | Max queue | Back of queue | Mean stopped delay | Mean control delay | LOS |
|---|---|---|---|---|---|---|---|
| NB | 46 | 46 % | 11 veh (at 0.0 s; mean 4.8) | 119 ft (36.3 m) | 9.5 s | ≥ 12.8 s (n = 40; 21 lower bounds; segment 34 m; v85 22.2 mph from n = 9) | B |
| SB | 54 | 67 % | 19 veh (at 0.0 s; mean 7.1) | 222 ft (67.5 m) | 11.9 s | ≥ 16.0 s (n = 54; 33 lower bounds; segment 60 m; v85 31.3 mph from n = 33) | B |

Caveats shown in the Info panel: one 90 s sample, no controller log, a spot speed stands in for free-flow speed (biases delay low where the entry line is inside the deceleration zone), the NB free-flow proxy rests on 9 observations, and both approaches carry standing queues at both window edges, so the control delays are lower bounds. Nothing on the page is presented as a measured LOS.

## Checks (Playwright 1.63, Chromium, headless, dev server on :5174)
- 1440 × 1000 and 390 × 844: section renders with the numbers above; no console errors or page errors; `document.scrollWidth === innerWidth` (no horizontal overflow); the table scrolls inside its labelled region on 390.
- Clicking the chart at 60 % of the plot seeks the clock to 54.0 s (cursor label and Player readout agree).
- Space plays: cursor x advances and the live queue readout updates.
- Phase bands in the chart and the scrubber strip carry the same four intervals (red / green / yellow / red).
- Info panel opens with method, citations, per-approach segment and v85 and the estimate caveat.
- `npm test`: 71 passed (9 new). `npm run build`: ok. `npx tsc --noEmit`: one error in `src/lib/lab/road.ts` (`TrackT` not imported) from a concurrent edit by another engineer, not from these files.
- Screenshots: `docs/qa/queue-1440.png`, `docs/qa/queue-390.png`.

- Dark colour scheme with `prefers-reduced-motion: reduce`: panel visible (opacity 1), bands, lines and table legible, no console errors (screenshot kept in the session scratchpad only).

## Not verified
- Touch drag on the chart on a real device (pointer capture tested with a mouse only).
- Other intersections: only `peachtree-10th` is served; the panel skips an approach whose stop bar cannot be derived (fewer than 20 stopped samples).
