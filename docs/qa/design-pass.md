# Design pass — Screening, Corridor, VRU, Brief, Methods, Platform, Ask, 404, Shell (2026-10-17)

Audit: headless Chromium (Playwright 1.63) at 1440 / 1024 / 390 px, dark and light, rail expanded and collapsed, every section scrolled into view. Screenshots: `docs/qa/design-pass/*.png`. Scope excludes the landing world and the intersection lab.

## The weakest fifteen (before)

| # | Where | Finding |
|---|---|---|
| 1 | Shell | Short sheets (Ask, 404) leave the colophon floating mid-viewport with dead ground below it. |
| 2 | Shell / base | No themed WebKit scrollbar (only `scrollbar-width`), no caret colour, so Chrome shows grey system scrollbars inside sage panels. |
| 3 | Screening | Ranked-table segment line (`69.01–70.01 · 6 ln · 45 mph`) wraps to three lines at 1440; numeric columns starve the name column. |
| 4 | Page header | Four full-width action buttons stack at 390 px (Screening, Brief), pushing the data below the fold. |
| 5 | Brief | `td.bar-c { display: flex }` breaks table-cell rendering: the row rule is missing under the Excess/yr column on every row. |
| 6 | VRU | Breakdown share axis labels collide ("all 28%" over "50%"); PNG/CSV exports use a bespoke button style instead of the shared control. |
| 7 | Platform | Guardrails is a same-size icon-card grid (anti-slop rule); six equal tiles for six one-line facts. |
| 8 | Platform / shared | Loading skeletons are one grey block; they do not match the table layout that replaces them. |
| 9 | Methods | MathML sub/superscripts render at 9 px (`mi` 9.07 px) — below the 12 px floor. |
| 10 | Methods | Metric catalogue is a same-size icon-card grid; section gaps of 72–120 px read as empty page. |
| 11 | 404 | Nine same-size icon cards; the only useful fact (the missing path) hides behind the info button. |
| 12 | Corridor | "No crash" scatter dots at 0.45 opacity of `--ink-3` are nearly invisible in dark mode. |
| 13 | Charts | CURE plot and bump chart are hover-only: no keyboard path to the point readouts. |
| 14 | Page header | Readouts do not tween when a filter changes (facility, year, severity): numbers jump. |
| 15 | Ask | Model-state Info is an orphan icon at the far right with no label before the first answer. |

## Before → after

| # | After |
|---|---|
| 1 | `.main` is a flex column at least one viewport tall; the colophon sits at the bottom of short sheets (Ask, 404 colophon bottom = viewport bottom at 900 px). |
| 2 | `base.css` (appended, tokens untouched): 10 px WebKit scrollbar in `--rule` with a transparent track, caret in `--accent`, selection tinted from the accent; the skeleton pulse stops under reduced motion. |
| 3 | Segment line and measurement cells no longer wrap; cell padding 8 px; table grid 1.2 fr : 1 fr. At 1440 the table is 598 px in a 598 px panel. Between 1101 and 1320 px the second comparison column (R/Rc or EB) is hidden and the segment line may wrap to two lines; below 1100 the table has the full row. |
| 4 | Below 640 px header actions share rows, two per line. |
| 5 | The bar sits in an inner `.bar-w` flex span; `td.bar-c` is a table cell again, so the row rule runs under every column. |
| 6 | Export buttons are the shared `.btn ghost sm`; share-axis tick labels within 40 px of the "all" marker are dropped. |
| 7 | Guardrails is one strip of six 42 px rows (icon · name · value), not six tiles. |
| 8 | `.skel-table` (a header line plus rows at real row height) replaces the single block on Platform's run table. |
| 9 | `:is(msub, msup, msubsup) > :not(:first-child) { font-size: max(12px, 0.72em) }`; equation panels at ≤ 520 px set 17 px so fraction parts stay ≥ 12 px. Minimum MathML size measured: 12 px at 1440 and 390. |
| 10 | Catalogue is a list of rows: name + abbreviation, formula, threshold on one line; Details folds under the row. Section gap `--s8`, page gap `--s7`. Deep-link target shows a 2 px accent edge. |
| 11 | 404 states the path on the page, then a plain list of the nine sheets with their one-line summaries and a ⌘K hint. |
| 12 | "No crash" dots and their key swatch at 0.7 opacity. |
| 13 | CURE plot is focusable: ← → Home End step through points and update the readout. Bump-chart labels are focusable buttons: focus shows the four ranks, Enter or Space selects the segment. Focus states drawn in the accent. |
| 14 | Header readouts tween 420 ms to the new value after a filter change (first value lands as is; stills under reduced motion). Measured on Screening: 27 → 23 (mid-tween) → 20 on a facility change. |
| 15 | The model Info button carries a label: "Model" before the first answer, then "Bedrock" or "Fallback". |

Also: selected table rows are tinted from the accent (hover stays `--raise`), so a selection reads differently from a hover; rows show a 2 px accent focus ring.

## Checks run (after)

- Headless Chromium sweep, 8 routes × 1440 / 1024 / 390 × dark / light, rail expanded and collapsed at 1440 (56 runs): no page-level horizontal scroll; no element wider than the viewport outside labelled scroll regions (`.t-scroll`, `.pf-scroll`, `.m-scroll`, `.vru-st-scroll`, `.ar-scroll`); no text clipped by a fixed height; no text below 12 px; console clean except MapLibre's WebGL driver performance notice on Screening ("GPU stall due to ReadPixels", a warning, not an error).
- Flows: CURE keyboard readout, bump-chart focus + Enter selection, facility change tweens the readouts, table-row hover moves nothing (bounding box identical), Brief bar cell renders as `table-cell` with its 1 px rule, Ask model button reads "Model", Ask colophon at the viewport bottom, Methods Details fold opens, Platform guardrail rows 42 px each, VRU with the rail collapsed has no horizontal scroll, narrow breakdown labels not clipped at 390.
- `npx tsc --noEmit` clean; `npm test` 7 files, 71 tests pass; `npm run build` passes.
- `impeccable detect --json frontend/src`: 0 findings.
- Screenshots: `docs/qa/design-pass/<page>-1440-dark.png`, `-1440-light.png`, `-1440-dark-collapsed.png`, `-390-dark.png` for screening, corridor, vru, brief, methods, platform, ask, notfound.

## Left for a later pass
- Native `title` tooltips remain on Platform cost lines, Brief prompt icons and guardrail rows; a themed, keyboard-reachable tooltip component would replace them.
- GSAP is installed but not used in these sheets; the FLIP re-rank, path tweens and comet loop are WAAPI/CSS/rAF.
