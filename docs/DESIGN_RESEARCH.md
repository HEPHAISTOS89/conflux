# Design research synthesis (2026-10-17)

Three parallel reference studies (landing pages; geospatial analysis tools; 3D/LiDAR/trajectory viewers), read from live pages and documentation. Observed facts carry their source in the agents' reports; this file records only the decisions taken for RoadScope and what each one is checked against (Prismora anti-slop floor, taste-skill house rules).

| Decision | Evidence (observed) | RoadScope application | Guard |
|---|---|---|---|
| The product performs on the first screen | Linear shows real records; Stripe/Mapbox embed working fragments | Atlas: live TTC threshold control driving real Peachtree conflicts; rank-one segment panel | No fake dashboards (D20, D28) |
| One easing, short durations, press feedback | Linear/Vercel/Stripe/Mapbox each use one ease-out curve; `:active scale(.97)` on Linear | `--ease-out`, 110–250 ms, scale .97 on controls | No scattered motion (D25) |
| Motion and hover are opt-in | Stripe/Linear `prefers-reduced-motion` blocks; Vercel `(hover:hover)` | Reduced-motion branches; hover rules gated for real pointers | F08 |
| One token set, light and dark | Vercel/Linear `data-theme` on `<html>` + system | `data-theme` with system default and a remembered switch; map tiles and chart palettes follow | C09 |
| Every number shows its provenance | Stripe's method note on its live figure | Glossary terms link to Methods; data build date in the rail | F01 |
| Two-way table ↔ map selection | Felt table view; kepler.gl interactions | Screening row ↔ segment, conflict row ↔ vehicles in every view | — |
| Command palette and shortcuts | Felt ⌘K, `/`, `?`, Esc | ⌘K / `/` jump to sheet, corridor, segment, intersection | — |
| Legend as layer control | Felt legend toggles / Alt-isolate | KABCO and PBCAT chips filter the VRU map | — |
| Export keeps state | kepler.gl CSV/PNG/share | CSV of filtered tables, share URL with selection | — |
| One shared selection across 3D, 2D, timeline, table | Foxglove `$selected_id`; Rerun selection model | Intersection lab selection store; conflict click seeks and selects both road users | — |
| Pick on instanced boxes, not points | three.js Raycaster `instanceId` on InstancedMesh | Invisible instanced boxes for picking; point cloud stays visual | — |
| Camera presets + follow | Foxglove follow modes; Segments.ai top view | Top, sensor POV, oblique, follow-selected | — |
| Conflict marks on the timeline | TraViA annotation bars; Ouster PET bands | Severity ticks on the scrubber; −3 s/+2 s replay loop | — |

Rejected as category clichés: logo strips and stat walls (F01/D21), bento grids (D07), fake terminal chrome (D13/D28), borrowing another product's typeface and curve wholesale (D11).
