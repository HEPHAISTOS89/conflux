# RoadScope design specification

Working spec for every page. It lives here, never as text in the UI. Tokens are defined in
`frontend/src/styles/base.css`; components use tokens, not literals.

## Direction
An engineering instrument for one county: charcoal and sage ground, ink text, one action
accent, amber and the KABCO ramp reserved for data meaning. Density of a technical report,
not a marketing site. Every page leads with its answer (verdict, rank one, critical count),
then the evidence, then the method one click away.

## Typography
Family: Switzer variable (UI, headings, body). JetBrains Mono only for measurements
(speeds, times, distances, IDs, coordinates, formulas). No all-caps labels, no letter-spaced
mono eyebrows.

| Role | Token | Size / line-height | Weight |
|---|---|---|---|
| Display (landing H1 only) | `--step-display` | clamp 52–136 px / 0.95 | head |
| Page title (H1) | `--t-h1` | clamp(28 px, 2.2vw, 40 px) / 1.1, one line | head |
| Section title (H2) | `--t-h2` | 22 px / 1.2 | strong |
| Panel title (H3) | `--t-h3` | 18 px / 1.3 | strong |
| Lede | `--t-lede` | 18 px / 1.45, max 60ch | body |
| Body | `--t-body` | 16 px / 1.5, max 70ch | body |
| UI / table | `--t-ui` | 14 px / 1.4 | body/strong |
| Label / caption | `--t-label` | 13 px / 1.35 | body |
| Micro (chart ticks only) | `--t-micro` | 12 px / 1.2 | body |
| Big figure | `--t-fig` | 28 px / 1.05, tabular | head |

No size below 12 px. No half-pixel sizes. Numbers in tables use tabular figures.

## Spacing
4-px base: `--s1` 4, `--s2` 8, `--s3` 12, `--s4` 16, `--s5` 24, `--s6` 32, `--s7` 48, `--s8` 72.
Page gutter 16 px (≤ 640), 32 px (≤ 1100), 48 px above. Section gap `--s8`. Panel padding
`--s4` (compact) or `--s5`. Gap inside a control group `--s2`.

## Shape
Radii: `--r-s` 4 px (chips inside tables, bars), `--r-m` 8 px (controls, inputs, panels),
`--r-l` 12 px (cards, popovers, diagram nodes), `--r-pill` 999 px (status and provenance chips).
No other radii.

## Controls
Heights: `--ctl-s` 32 px (toolbar, chart export), `--ctl-m` 40 px (buttons, selects, inputs).
Touch targets ≥ 40 px on ≤ 640 px. Primary button: accent fill, accent-ink text. Secondary:
raise fill. Ghost: text with underline offset. One label per action across the portal:
"Download CSV", "Download PNG", "Copy link", "Open …".
States: hover = raise/paper-2 shift 120 ms; focus-visible = 2 px accent ring; pressed =
scale 0.97; disabled = 0.45 opacity plus `aria-disabled` and a reason in `title`;
busy = spinner icon + verb in progress ("Running…"), control disabled until settled.

## Icons
Phosphor, regular weight; duotone only in page-header badges. Sizes: 14 (inline in labels),
16 (buttons, nav, table actions), 20 (panel headers, diagram nodes), 24 (page header badge
icon at 44 px box). Icon and text share the label's cap-height centre.

## Navigation
Rail 232 px, collapsible to a 64 px icon rail (toggle at the top, `[` shortcut, state in
localStorage, tooltips with the label when collapsed); top bar with disclosure ≤ 1100 px. Item 40 px
tall, 16-px icon, 15 px label on one line. Active: one raise fill that slides between items, accent
icon. Hover: paper-2 fill. Rail holds navigation, Jump to (⌘K), theme and About the data only.

## Page header
Icon badge 36 px, title, one info button (lede and data source live in its panel, never inline),
compact readouts (22 px figures), actions. No ledes, source lines or chips on the page itself.
Provenance is a 6 px dot + word inside panels and tables; status is icon + one or two words.

## Colour roles
Ground `--paper`, panel `--sheet`, raised `--raise`, rule `--rule`, text `--ink/-2/-3`, action
`--accent`, state `--go/--caution/--stop`, severity `--sev-k…o`. Status never by colour alone:
icon + word. Simulation uses `--caution` with the word "Simulation". Planned/unverified
infrastructure uses dashed outlines and the word "Planned" or "Not deployed".

## Data display
Every figure: unit, source chip (Observed / Derived / Simulated / Public), method popover.
Tables: sticky header, tabular numbers, horizontal scroll inside a labelled container on
narrow screens, never page-level horizontal scroll. Long labels wrap; values never truncate.
Empty state: one line saying why and what to change. Error state: what failed, a Retry button.

## Motion
Durations 120 (hover), 160–240 (state), 400–600 (section entrance), signature canvases
continuous. Easing `--ease-out`. Motion explains data: flows follow volume, counters tween to
the new value, selection links views. Respect `prefers-reduced-motion` (stills, no tween).
rAF loops pause off-screen or in hidden tabs. 3D: 60 fps target, DPR ≤ 2.

## Layout robustness checklist
1440, 1280, 1024, 768, 390 widths; light and dark; rail expanded and collapsed; longest
real label; largest value; empty, loading, error states; no element wider than its container;
no text clipped by a fixed height.
