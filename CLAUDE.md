# RoadScope AI — TransTech Lab portal

## Goal
Win the Texas Tech TransTech Lab Graduate Assistant position (Prof. Hongchao Liu, Dr. Qiyang Luo; deadline 2026-12-01). The Vercel deployment is the showcase — no demo video. It must read as the work of a senior professional: civil/transportation engineering professors should admire both its technical rigor and its craft.

## Non-negotiables
- **Their vocabulary.** Research the lab's publications/projects first. Speak transportation engineering: traffic conflicts, surrogate safety measures (TTC, PET, DRAC), KABCO severity, AADT, corridors/segments, crash frequency, HSM/CMFs, US units.
- **Real public data** (TxDOT CRIS, TxDOT AADT/roadway inventory, NGSIM/highD, FARS…), provenance and licence shown everywhere. No fabricated numbers presented as real.
- **A complete, wired product, not a prototype.** Every control hits a real API; every number comes from a pipeline.
- **Every tech in the posting, genuinely used:** Python/FastAPI, React, S3, EC2, CloudFront, Lambda, EventBridge, IAM, Bedrock, CloudWatch.
- **Design rebuilt from scratch**, creative, no AI slop; motion serves reading the data. Use impeccable, taste/redesign, Emil Kowalski animation skills, GSAP, dataviz.
- **Verify in a real browser** at every step (flows, responsive, a11y, perf, console).
- Keep asking: *Is the portal complete? Would a civil-engineering professor recognise their discipline? Is this what they want from a GA?*

## Constraints
- AWS: $100 total credits, account 287785301961, region us-east-2. Budget alarm first; serverless-first; stop EC2 when idle; cheap Bedrock model + caching. Target < $30 through the deadline.
- Repo is public (HEPHAISTOS89/conflux, renamed from roadscope-ai). Rebuild in place; keep git history.
- Owner granted full autonomy for design, backend, infra, 3D, animation and deploys. Never email the professors; flag irreversible AWS deletions; respect dataset licences.
- GitHub Actions disabled to save minutes; verify locally before deploys.

## Status (2026-10-17)
- Live: https://conflux-safety.vercel.app (Vercel project conflux, formerly roadscope-ai-demo, team hephaistos1; root dir `frontend`, `/api` rewritten to API Gateway). Deploy via Vercel MCP `create_deployment` with gitSource (local CLI is logged into another account).
- AWS RoadScopeStack (us-east-2): HTTP API https://tkk01bgzfb.execute-api.us-east-2.amazonaws.com, Lambdas roadscope-api / roadscope-ingest, EC2 worker i-085be087cdef3df92 (self-stops), bucket roadscopestack-data666c94c7-bqgchgwzlg4p. Runbook: docs/DEPLOY.md.
- Pending on AWS account verification: CloudFront (`cdk deploy -c edge=cloudfront`) and Bedrock model access (analyst currently uses the deterministic fallback).
- Screening outcome is on-system CRIS ped/bike crashes 2021–2023 (SUM_CRASH_ is an SATP score, not a crash count).
- Study region (2026-10-18): the 15 SPAG counties (sources.COUNTIES), county filter `?county=<slug>` / API `county=`; default = whole region. Screened population 4,090 of 4,121 one-mile segments (31 unmatched), 139 crashes on screened segments; 54 flagged, 16 confirmed. Lubbock alone: 499 of 529 screened, 37 flagged, 116 crashes, 46 on-system K+A (the old Lubbock envelope had cut the county's edges: 395 / 27 / 110 / 43). SPFs are fitted once on the regional population; a county view filters the ranking. See docs/qa/spag-region.md.
- After the SPAG build the curated set in S3 is stale until `aws s3 sync data/curated s3://roadscopestack-data666c94c7-bqgchgwzlg4p/curated/` (then the ingest Lambda applies the regional SPFs).
- Peachtree critical conflicts: 27 (34 flagged minus 7 between a duplicate/ID-switched track and its host, lib/lab/quality.ts; overlap flags excluded). 38/170 tracks carry duplicate windows and are faded out of every view.
- NGSIM x,y is the front-bumper centre (pipeline keeps it; ssm.py gap = spacing − leader length). Renderers place the body `len` behind the point (`bodyCentre` in lib/lab/metrics.ts); never centre a body on the served point.
- Live host is now https://conflux-safety.vercel.app (rebrand by a parallel session; GitHub repo renamed to HEPHAISTOS89/conflux). The old roadscope-ai-demo host redirects, and its own /api rewrite 308s to the new host, so pages there show no data.
- On-demand ingest: POST /api/v1/ops/ingest (30-min cooldown + S3 lock, IAM scoped to the ingest ARN). First production run 2026-10-17 18:12 UTC, 20,708 records, 11.8 s.
- AWS CLI uses `aws login` sessions that expire; if `aws sts get-caller-identity` says expired, run `aws login` in a terminal tab and let the owner approve in the browser.

## Active goal
See docs/GOAL.md (owner brief, 2026-10-17) and log every iteration in docs/DESIGN_LOG.md.
