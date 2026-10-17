# Goal — the portal reviewers want to hire its author for

Owner brief (2026-10-17), verbatim intent, executed as a continuous test-and-surpass loop. Iterations are logged in docs/DESIGN_LOG.md.

## Audience
TransTech Lab (Prof. Hongchao Liu, Dr. Qiyang Luo): roadside LiDAR perception, trajectory extraction and repair under occlusion, proactive safety (near-misses, PET, TTC, failure-to-yield); USDOT roadside-LiDAR pedestrian-warning pilot with a dashboard for the 15 SPAG counties. Two audiences per screen: researchers (units, 10 Hz, provenance, uncertainty, methods) and county officials (verdict in 10 s). Verdict first, technical depth one click below. No text-heavy pages: KPIs, charts, maps, diagrams, icons, status chips.

## 1. 3D experience
Fullscreen (button + F, Esc, resize, HUD kept, state preserved). Modes: orbit (damped, limits), free-fly (WASD/arrows + mouse look, Shift faster), follow, top-down orthographic, sensor POV, animated presets (Crosswalk, Approach lane, Conflict zone, Sensor POV). Timeline: play/pause, scrub, 0.25–4×, 10 Hz frame stepping, jump to risk events. HUD: ID, class, speed, heading, acceleration, track confidence; live PET/TTC; toggles (trails, predicted paths, conflict zones, sensor FOV cone, point cloud); minimap + compass; `?` shortcut overlay. Near-miss moment: subtle slow-down, conflict point highlight, replay from three angles. 60 fps, instancing, pause when hidden, no-WebGL fallback.

## 2. Anticipated needs (go beyond)
Before/after and treated-vs-control with n and CIs; day/night and weather; peak-risk hours; speed histogram at the crosswalk; driver yielding-rate trend; sensor health (uptime, completeness, packet gaps); per-metric methodology (formula, threshold, citation, provenance observed/simulated/public); export CSV/PNG/deep link (filters, time, camera); one-page printable county summary; glossary on every term. Never fabricate: label simulated data, unfinished phases on a Roadmap page (done / in progress / prototype / planned).

## 3. Visual craft
Clear type scale, tabular numerals, monospace for measurements, controlled measure, crisp rendering. One icon library (Phosphor), dedicated icon per domain concept (sensor, pedestrian, vehicle, alert, offline site, county), no emoji. Section headers state what and why. Custom accessible inputs/selects/filters (keyboard, focus, searchable long lists, empty/loading/error/disabled). Charts with units, rich tooltips, event annotations, consistent light/dark palette. Living architecture diagram (LiDAR sensor → edge → S3 → EventBridge → Lambda → API → dashboard, + CloudWatch, Bedrock), continuously animated, particle rate ∝ volume, node red when offline, backlog drains on recovery, every node clickable (role, metrics, AWS service). Motion explains state changes, short, interruptible, transform/opacity, reduced-motion.

## 4. Loop (mandatory)
Pick weakest → improve → verify in a real browser (every page, button, select, filter, shortcut, 3D mode incl. fullscreen; 1440/1024/390, light/dark; motion; console; network; fps; a11y) → build + tests (+ tests for new logic: metrics, URL state) → critique twice (creative director, then TransTech researcher), score 0–10 on hierarchy, typography, icons, data clarity, technical accuracy, motion usefulness, 3D, accessibility, performance, polish, wow/anticipated needs → fix everything < 9 → "what would make this clearly better?" → implement → log.

## Stop criteria (all)
Every page and interactive element verified after the last change; every page ≥ 9 on every criterion; 3D flawless in fullscreen with all modes; ≥ 5 anticipated features a researcher would immediately use; build, tests, console clean, zero regressions; no further significant improvement found — the best version, and proud of it.
