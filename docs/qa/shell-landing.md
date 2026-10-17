# QA — shell chrome and landing, Methods, Ask, Roadmap, 404

Run 2026-10-17 against the local dev stack (web :5173 → API :8000), headless Chromium (Playwright 1.63), 1440 × 900 unless stated; collapsed-rail checks at 1024 px, edge checks at 390 px. Script: scratchpad `audit.mjs` (each row is an automated assertion on the DOM, URL, clipboard, download or network, not a visual guess). 34/34 pass.

## Defects found and fixed during the audit

| Control | Defect | Fix |
|---|---|---|
| Glossary term (mouse) | Click toggled the tooltip that hover had just opened, so clicking a term closed it and its "Method" link could not be reached | Click only opens; Esc, outside press, blur and pointer-leave close (Term.tsx) |
| Glossary "Method" link | Pressing the link blurred the term and unmounted the tip before the click landed | mousedown inside the tip no longer blurs the term |
| ⌘K / "/" palette | Keys typed straight after the shortcut were lost (focus moved a frame late); Tab escaped the modal; Roadmap missing; active row could scroll out of view | Synchronous focus, Tab held in the dialog, Roadmap entry, active row kept in view |
| Select (corridor picker) | Space during type-ahead ("us 6") selected the current option; Esc before the list took focus did nothing; list could leave the viewport | Space selects only outside a type-ahead burst; Esc on the trigger; viewport fit and flip-up |
| MetricInfo / glossary / Select | Fixed left/right alignment: popovers ran off-screen near edges at 390 px | Shared useFloatFit: horizontal shift via CSS translate and flip above the anchor |
| Collapsed rail (≤ 1100 px) | Collapse happened at 960 px (spec: 1100); no Esc, page scrolled behind the menu, focus stayed on the button, icon-only button had no name at 390 px | Breakpoint 1100, labelled "Menu/Close" button, Esc closes and refocuses, scroll lock, focus to current item, search button in the top bar |
| Ask composer | Two clicks in one frame could send two requests (guard read React state); copy failures were silent; disabled controls gave no reason | Ref guard (one request verified), "Copy blocked by browser" message, title reasons, aria-busy |
| Ask status chip | "Rule-based fallback" did not say why | "Rule-based fallback · Bedrock not active", with the reason (AWS verification / daily cap) in its title |
| Landing verdict | K+A "on state roads" used all-roads KA (86) and "of 443" counted 48 unmatched segments | on_system.ka (43) and the screened total (395); NetworkRank states 395 screened, 48 unranked in grey |
| Map controls | MapLibre stylesheet loads after shell.css, so zoom/attribution stayed white in dark mode | Overrides moved to mapview.css (imported after maplibre-gl.css) |

## Results

| Control | Expected | Observed | Result |
|---|---|---|---|
| Theme toggle (rail) | theme flips, stored, survives reload, map remounts | light→dark, stored=dark, after reload=dark, map canvas remounted=true | pass |
| ⌘K palette: open, search, ↓, Enter | opens focused, filters, navigates to 2nd hit | open=true focused=true hits=12 (CorridorUS 84 (Slaton Hwy / Clovis Rd)39.3 mi / SegmentUS 84 · DFO 69.0rank 1 · EB 1.55) selected="SegmentUS 84 · DFO 69.0rank 1 · EB 1.55" → /screening?seg=US0084-KG_01_070 | pass |
| Jump to… button + Esc | opens; Roadmap is searchable; Esc closes and focus returns to trigger | open=true roadmapHit=true closed=true focus=cmdk-trigger | pass |
| Palette: "/" opens, empty state, scrim click closes | opens; "No match" line; closes | slash=true empty="No match for “zzzz”." scrimClose=true | pass |
| Glossary term (TTC): focus, Esc, Method link | tooltip on focus, Esc hides, link opens /methods#m-ssm | tip=true esc=true → /methods#m-ssm | pass |
| MetricInfo popover (network measure) | opens in viewport; Esc closes + refocuses; outside click closes | open=true x=[257,617,1440] esc=true focusBack=true outside=true | pass |
| TTC threshold instrument | count + threshold line follow the step; arrow keys move | 1.5 s→31, 3.0 s→51 (TTC ≤ 3.0 s), ←→2.0s: 37 | pass |
| Network measure switch | pressed state moves; top five re-rank with new unit | pressed=Critical ratio; EB: 1.55/yr, 0.96/yr → crit: 2.82, 2.27 | pass |
| Top-five hover ↔ map highlight | row hover marks the row and the segment on the map | row data-on=true | pass |
| Map hover/click on a segment | hover links to list; click opens the segment in screening | → /screening?seg=SL0088-KG_02_012 | pass |
| Exposure pause/play | clock runs, stops when paused, resumes | Pause replay: 14.0→15.3; Play replay: 16.1→16.1; resumed→18.6 | pass |
| EB worked example | four computed steps; "Open segment" opens the rank-1 segment | 0.57 crashes / yr \| 3.00 crashes / yr \| w = 0.36 \| 1.55 excess / yr → /screening?seg=US0084-KG_01_070 | pass |
| Corridor picker (Select keyboard) + go | ↓ opens in view, ↓ Enter picks, focus returns; arrow opens that corridor | Corridor: US 84 → Corridor: US 62/82; listInView=true; focusBack=true; → /corridors/us-62-82 | pass |
| Select: Esc, outside click, type-ahead | closes; closes; type-ahead picks matching option | esc=true outside=true typeahead→Corridor: US 62/82 | pass |
| Every landing link | each internal link resolves to a real page | 11 links, broken: none | pass |
| Methods: Download catalogue / manifest CSV | CSV files with one row per metric / source | roadscope-metric-catalogue.csv 10 rows; roadscope-data-manifest.csv 13 rows | pass |
| Methods TOC anchor | scrolls section to top; TOC marks it current | #m-ssm top=24px, current=#m-ssm, url=#m-ssm | pass |
| Methods deep link on load | /methods#m-repair lands on the section | top=24px | pass |
| Metric family filter | filters cards to the family count | Network screening3 → 3 cards | pass |
| Metric card: copy link | clipboard holds a /methods#… deep link and the button confirms | clip=http://localhost:5173/methods#metric-crash-rate label="Copied" | pass |
| Metric card: Derivation anchor | jumps to its method section | hash=#m-screening | pass |
| Ask: ⌘Enter submit, loading, answer, status chip | disabled with reason when empty; busy verb + skeleton; answer with citations; chip states the fallback honestly | empty disabled=true title="Type a question first"; busy="Answering…" skeleton=true; answer="31 of 307 vulnerable-road-user crashes match (mode=ped, severity=K,A, light=NOT LIGHTED); …"; chip "Bedrock awaiting AWS account verification" → "Rule-based fallback ·  | pass |
| Ask: copy answer | clipboard holds Q, answer, citations, model; button confirms | "Copied" clip starts "Q: How many KA pedestrian crashes happen" has Cited=true | pass |
| Ask: example chip + duplicate-submit guard | double click in one frame sends one request | requests=1, turns=2 | pass |
| Ask: error + Retry | error says what failed with Retry; Retry re-asks and answers | error="Request failed. 503: Service unavailable (test)"; after retry newest turn answered=true | pass |
| Ask: Clear answers | removes all turns | turns=0 | pass |
| Roadmap card links | each "Open" arrow resolves | 9 links (/screening /methods /intersections /vru /platform /brief /ask), broken: none | pass |
| 404 page | names the path, lists every sheet, links work | h1="Page not found" path=/no-such-sheet links=10 → /roadmap | pass |
| Rail active state + skip link | active item marked aria-current; first Tab reaches skip link which focuses main | active=Pedestrians & cyclists\|page; tab→skip; enter→#main | pass |
| Collapsed rail (≤ 1100 px) disclosure | rail hidden; Menu opens with focus on current item and page scroll locked; Esc closes and refocuses; navigating closes | hidden=hidden; open=true focus="Pedestrians & cyclists" lock=hidden; esc→false focus=menu-btn; after nav /roadmap open=false | pass |
| Top bar search + theme | search opens palette; theme toggles | palette=true theme→dark | pass |
| MetricInfo near edges (390 px, TTC) | popover stays inside the viewport | [9, 367, 406, 780, 390, 800] | pass |
| Glossary tip near edge (390 px, DRAC) | tooltip stays inside the viewport | [78, 378, 390] | pass |
| Console during audit | no page errors (the deliberate 503 excluded) | none | pass |

Build gates: `npx tsc --noEmit` clean, `npm run build` ok, `npm test` 47/47.
