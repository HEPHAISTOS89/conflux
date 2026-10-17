# DESIGN — RoadScope

Visual world: **signal-ops worksheet + time–space diagram**. The portal reads like an engineering instrument used by traffic engineers: distance and time are the two axes everything is drawn on; colour carries meaning (signal state, KABCO severity), never decoration. Source of truth: `frontend/src/styles/base.css` and `shell.css`.

## Colour (Restrained strategy)
| Token | Value | Role |
|---|---|---|
| `--paper` | `#f3f4f1` | page ground (cool field-sheet grey, not cream) |
| `--sheet` | `#fbfbf9` | panels, rail, map overlays |
| `--ink` / `--ink-2` / `--ink-3` | `#14171a` / `#3a4148` / `#5a636b` | text, linework; `--ink-3` ≥ 4.5:1 on paper |
| `--rule` / `--grid` | `#c5cac2` / `#dde0d9` | hairlines, graticules |
| `--caution` | `#c98a00` | the one live accent: time cursor, selection, conflicts |
| `--go` / `--stop` | `#1f7a4d` / `#b3261e` | signal state, SPF pooled curve |
| `--sev-k…o` | `#6e120d #b3261e #d4612a #d9a038 #98a1a7` | KABCO ramp, used identically in maps, tables, charts |
| `--night*` | `#0b0e11`… | only inside the roadside-LiDAR 3D view |

EB-excess map ramp: grey ≤ 0 → amber 0.5 → orange 1.5 → red 3 → deep red 4.5.

## Type
- **Overpass** (Highway Gothic lineage) — headings, 800/600.
- **Public Sans** (USWDS) — UI and body, 400/500/600, 15 px base.
- **Overpass Mono** — every number, axis tick and unit (`.num`, tabular). Never used as costume for prose.
- Display ≤ 48 px, tracking ≥ −0.02em, body measure ≤ 68ch.

## Space, shape, depth
4-px base scale (`--s1…--s8`), radius 4 px, 1-px rules; one soft shadow on floating map overlays only. Sections open with a heading over a 1-px ink rule; no eyebrows, no card grids.

## Components
Rail with title block (district, county, data build, sources) · segmented control `.seg` · `.btn` / `.btn.ghost` · `table.data` (sticky header, amber active row) · tab strip `.cor-tabs` · map overlays (legend, readout) · `Player` transport bound to a shared clock.

## Signature: the shared clock
`ClockCtx` (`lib/traj.ts`) drives plan view, LiDAR view, time–space diagram, vehicle readout and conflict list from one time value; scrubbing any of them moves all. Straight-line diagrams share a DFO cursor with their map marker.

## Motion
One authored moment per sheet: Atlas time–space diagram draws in once at 4× (≈22 s) then rests complete; conflict rings pulse on occurrence in plan view; platform data-flow dashes run once. Easing `cubic-bezier(.16,1,.3,1)`. `prefers-reduced-motion` renders end states immediately.

## Data-viz rules
Axes in real units (s, m, mph, veh/day, crashes/yr/mi); log scale only where stated (AADT); severity colour identical everywhere; implausible values (DRAC > 8 m/s²) flagged, not hidden; stand-in data labelled in place.
