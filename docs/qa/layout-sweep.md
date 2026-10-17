# QA — layout sweep, every route

Run 2026-10-17, local dev stack, headless Chromium (Playwright 1.63). 13 routes (`/`, `/screening`, `/corridors`, `/corridors/us-84`, `/vru`, `/intersections`, `/intersections/peachtree-10th`, `/brief`, `/methods`, `/platform`, `/roadmap`, `/ask`, a 404) × 8 widths (1440, 1366, 1280, 1200, 1100, 1024, 768, 390) × light and dark = 208 page states, each checked with the rail closed and, at ≤ 1100 px, again with the menu open. Every page is scrolled through first so reveal animations settle.

Automated checks per state (DOM measurement of every visible text node): page-level horizontal scroll; text outside the viewport; text under the rail; text clipped by an `overflow: hidden/clip` ancestor (x or y); text leaving its filled card/panel; ellipsis truncation; computed font size < 12 px; console errors. Horizontal scrollers that are deliberate are listed separately with whether they are labelled and keyboard-focusable (spec: "horizontal scroll inside a labelled container"). Screenshots of my pages at 1440/1200/1024/390 in both themes were also reviewed by eye.

## Before (first sweep, 1440/1100/390 dark) → fixed

| Page | Width × theme | Defect | Status |
|---|---|---|---|
| Landing hero | ~1000–1300, narrow panes | Caption absolutely positioned over the canvas: overlapped trails, clipped at the stage's left edge in narrow panes | Fixed: caption is its own grid row inside the stage at every width (atlas.css) |
| Landing hero | 1200 (any 1101–1250) | "Lubbock County" ran past its column and was cut by the masked line (`white-space: nowrap` + vw sizing) | Fixed: size in container units (8.2cqi of the copy band), wrapping allowed as a fallback |
| Landing HUD | all | Labels 10.8 px | Fixed: 12 px (`--t-micro`) |
| Landing caption chip | 1101+ | Provenance chip stretched to fill the row | Fixed |
| All pages using `.measure` | all | Mono measurements rendered at 11.96 px in 13 px contexts (and half-pixel sizes everywhere) | Fixed: rounded to whole px, 12 px floor (components.css) |
| Methods | all | `<sub>` in captions 11.7 px | Fixed: sub/sup floor 12 px (base.css) |
| Methods | all | Five horizontally scrolling tables unlabelled | Fixed: `role=region`, label, focusable |
| Collapsed rail | ≤ 1100 | Theme row duplicated in the menu, titleblock stretched full width | Fixed |
| Map controls | dark | Zoom buttons and attribution white on the dark basemap | Fixed (mapview.css after maplibre-gl.css) |
| Page header source line | 1440 | Icon wrapped onto its own line above long source text | Fixed |
| Methods TOC | all | Contents links carried the global prose underline | Fixed |

## After (final sweep, 208 states)

No page-level horizontal scroll, no text off-screen or under the rail, no text below 12 px, no ellipsis truncation, no console errors on any route at any width or theme. Remaining findings, all in pages owned by other agents (reported, not edited):

| Page | Width × theme | Finding | Owner |
|---|---|---|---|
| `/intersections`, `/intersections/peachtree-10th` | 390, both | "overlap" flag chip clipped horizontally by its table cell (`span.flag` inside `td`) | Intersection lab |
| `/brief` | 390, both | Three tables (`.sheet-table`, two `table.app-t`) scroll horizontally without a label or keyboard focus | Brief |
| `/screening` | 1024–1440, both | `.scr-table-wrap` scrolls horizontally (labelled) but is not keyboard-focusable; at 1440 the EB-excess column sits past the panel edge until scrolled | Screening |
| `/platform` | 1024–1280, both | Architecture figure `.ar-scroll` scrolls horizontally without a label or focus | Platform |
| `/platform` | during sweep | Transient render errors while its owner was editing (`arch/model.ts` missing export `NH`; `simOn is not defined`); gone in the final sweep | Platform |

Deliberate, labelled and focusable scrollers (pass): Methods tables (≤ 1440 for the repair table), `/vru` station table at 390, `/platform` lower table at 390.
