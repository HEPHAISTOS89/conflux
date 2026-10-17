# Platform page QA (2026-10-17)

Scope: every control on `/platform`, the on-demand ingest endpoint, the outage simulation and the diagram layout.

How it was tested:
- **Unit**: `frontend` vitest (`components/arch/scenario.test.ts`, `components/arch/ingest.test.ts`), `backend/tests/test_ops.py` (11 tests: AWS-only 503, body refused, async invoke, cooldown from lock and run records, short cooldown after failure, conditional-write race, invoke failure releases the lock, rate limit, uncached run records + cache drop on a new ingest), `pipeline/tests/test_lambda_ingest.py` (running → succeeded record, manual vs schedule trigger).
- **Browser**: headless Chromium (Playwright 1.63) against a separate dev stack (vite on :5180 proxying to a second uvicorn on :8010 running the new backend; the shared :5173/:8000 servers were left alone). Script: 60 checks, 0 failures. AWS-mode rendering uses the real production `/platform/status` JSON captured from the API Gateway; the ingest success/failure/cooldown/timeout paths use scripted responses to the real endpoint contract (the local server itself is not on AWS and correctly refuses).
- **Layout**: 1440 dark, 1280 light, 1024 dark (rail collapsed), 768 light, 390 dark, live and with a simulation running and a node panel open: no page-level horizontal scroll, no node content outside its box (checked per child rect), axe-core: 0 violations in light and dark, live and simulated.
- **Not tested against production**: AWS CLI session expired (`aws login` needs the owner), so the stack was not deployed and no real ingest was triggered. `scripts/package_lambdas.sh` and `cdk synth` were run; the synthesized API role has `lambda:InvokeFunction` on the ingest function ARN only and read/write on `ops/*`.

| # | Control / behaviour | Expected | Observed | Result |
|---|---|---|---|---|
| A1 | Run table (AWS data) | One row per S3 run record, Trigger and Records columns | 6 rows from production JSON | Pass |
| A2 | Replay recovery button | Shown only when a real failed → succeeded sequence exists | Shown (trajectories 07:11 failed, 07:16 succeeded) | Pass |
| A3 | Click a diagram node | Opens its panel | Lambda · API panel opens | Pass |
| A4 | URL | `?node=<id>` written | `?node=api` | Pass |
| A5 | Esc | Closes panel, clears `?node`, focus back on the node | As expected | Pass |
| A6 | Click the open node again | Toggles closed | Closed | Pass |
| A7 | Deep link `?node=s3` | Opens S3 panel on load | Opens | Pass |
| A8 | Panel close button | Closes, clears URL | As expected | Pass |
| A9 | `?node=nope` | Ignored | No panel | Pass |
| A10 | Keyboard Enter on a node (now a real `<button>`) | Opens panel | Opens | Pass |
| A11–A13 | Outage target Select: ArrowDown opens, ArrowDown+Enter picks, Esc closes and keeps focus | As stated | As stated | Pass |
| A14 | Console | No errors | Clean | Pass |
| B1–B2 | Simulate outage (S3) | Banner "Simulation", S3 node Down | As expected | Pass |
| B3 | Consequences follow the graph | API, API Gateway, Dashboard degraded; ingest and worker (writers) degraded | All five `warn` | Pass |
| B4–B5 | Header readouts | Stages up, Last ingest, API p95 switch to simulated values labelled "Simulation"; verdict chip says Simulation | 3 labels; "Simulation: S3 data lake down" | Pass |
| B6 | Alarms | Real alarm names and rules; api-errors stays OK for handled HTTP 500s | As expected | Pass |
| B7 | Queue counter | Failed requests = 7-day CloudWatch req/min × simulated minutes | 0.03 req/min → 0 after 15 min (honest at real traffic) | Pass |
| B8–B9 | Simulated clock | T+ advances 5 min per second; Last ingest grows | T+15 after 3 s; readout changed | Pass |
| B10 | Change target while active | Re-runs from T+0 on the new component | API Down, S3 back to live, T+5 | Pass |
| B11–B12 | API outage specifics | Bedrock node "Ask unavailable"; API p95 "—" | As expected | Pass |
| B13 | Node panel in simulation | Shows "Simulation: …" consequence and note | Shown | Pass |
| B14 | Restore service | Button "Restoring…" (disabled), queue draining | As expected | Pass |
| B15–B18 | After drain | Banner Live, readouts and verdict equal the pre-simulation values, no Down nodes, no badges, no sim panel | Identical strings | Pass |
| B19 | End simulation now | Immediate full reset | As expected | Pass |
| B20 | Ingest / EC2 scenarios | Ingest: errors alarm at once, DLQ alarm after the third attempt; EC2: one missed job, no alarm covers it | "Messages in DLQ 1 msg"; "Missed worker jobs 1 job" | Pass |
| B21–B22 | Replay recovery | Replays the recorded event with its run ids; button disabled while replaying | Run 20261017T071041Z → 20261017T071631Z | Pass |
| B23 | Simulation during replay | Cancels the replay | As expected | Pass |
| B24 | Replay end | Back to Live, can replay again | As expected | Pass |
| B25 | Console | Clean | Clean | Pass |
| C1 | Run ingest (ready) | Enabled | Enabled | Pass |
| C2 | Double click | One POST, button busy "Running…" | 1 POST | Pass |
| C3 | Running | Shows the run id from the server's "running" record + elapsed | "Run 20261017T130001Z running · 0:03" | Pass |
| C4 | Success | Only from a record with status succeeded; records, sources, seconds, run id | "20,712 records from 5 sources in 10.6 s" | Pass |
| C5 | Refresh | Run table shows the new run (manual, records) | Shown | Pass |
| C6–C7 | After success | Disabled, reason "Next run allowed in 30 min"; clicking sends nothing | As expected | Pass |
| C9 | Failed record | "Failed." with error + message + run id, never success | "RuntimeError: sanity gate failed…" | Pass |
| C10–C11 | 429 cooldown | Disabled, minutes from Retry-After, one request | "Next run allowed in 25 min" | Pass |
| C12 | Cooldown on load | From GET /ops/ingest | "Next run allowed in 15 min" | Pass |
| C13 | Invoke refused (502) | Error + Retry button | As expected | Pass |
| C14 | No record in 3 min | Timeout error, not success | "No run record appeared within 3 minutes…" | Pass |
| D1–D2 | Local server | AWS-only message, button disabled; `POST /api/v1/ops/ingest` → 503 `aws_only` | As expected | Pass |
| D3 | Local empty state | Run table explains local mode | As expected | Pass |
| E1–E2 | Status endpoint error | Error box with Retry; Retry recovers | As expected | Pass |
| L1 | Diagram labels (1280) | No title/subtitle/chip outside its node | All nodes size from content and wrap; 0 spills at 5 widths | Pass |
| L2 | Edge labels | Never cover a node | Labels that would overlap a node are hidden (figures stay in each node panel) | Pass |
| L3 | Contrast | WCAG AA | axe 0 violations (light warn/ok text darkened on this page) | Pass |
| P1 | Production: cdk deploy + one real ingest | New run record with status succeeded; data endpoints answer | **Not run: AWS session expired** | Blocked |

## Server-side guards (POST /api/v1/ops/ingest)
- No request body accepted (400). Per-client token bucket, 3/min (429).
- Not on AWS → 503 `aws_only`; nothing is faked.
- Cooldown: 30 min after an accepted trigger or a running/succeeded ingest, 5 min after a failed one (Lambda's own async retries run at +1 and +3 min). 429 + `Retry-After`.
- Duplicate protection: lock object `ops/ingest-trigger.json` written with an S3 conditional write (`If-Match` / `If-None-Match`) before the invoke; a lost race is refused. A failed invoke marks the lock `invoke_failed` so a retry is allowed.
- `lambda.invoke(InvocationType="Event")`; the ingest Lambda writes a `running` run record at start and rewrites it as `succeeded`/`failed` (with `trigger`, `requested_at`, `records`, `seconds`).
- `/platform/status` is `no-store`, reads run records uncached, and drops the API container's 10-minute data cache when a new succeeded ingest appears.
