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
- Repo is public (HEPHAISTOS89/roadscope-ai). Rebuild in place; keep git history.
- Owner granted full autonomy for design, backend, infra, 3D, animation and deploys. Never email the professors; flag irreversible AWS deletions; respect dataset licences.
- GitHub Actions disabled to save minutes; verify locally before deploys.

## Status (2026-10-17)
- Live: https://roadscope-ai-demo.vercel.app (Vercel project roadscope-ai-demo, team hephaistos1; root dir `frontend`, `/api` rewritten to API Gateway). Deploy via Vercel MCP `create_deployment` with gitSource (local CLI is logged into another account).
- AWS RoadScopeStack (us-east-2): HTTP API https://tkk01bgzfb.execute-api.us-east-2.amazonaws.com, Lambdas roadscope-api / roadscope-ingest, EC2 worker i-085be087cdef3df92 (self-stops), bucket roadscopestack-data666c94c7-bqgchgwzlg4p. Runbook: docs/DEPLOY.md.
- Pending on AWS account verification: CloudFront (`cdk deploy -c edge=cloudfront`) and Bedrock model access (analyst currently uses the deterministic fallback).
- Screening outcome is on-system CRIS ped/bike crashes 2021–2023 (SUM_CRASH_ is an SATP score, not a crash count).
