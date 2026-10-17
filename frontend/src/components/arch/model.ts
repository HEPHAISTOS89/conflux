import type { IconName } from '../Icon';
import type { PlatformRun, PlatformStatus } from '../../lib/types';

/**
 * The architecture as data: node and edge geometry, what each component is, and how its live state
 * is read from /api/v1/platform/status. Geometry is in SVG user units (viewBox 0 0 VB_W VB_H).
 */

export type Flow = 'ingest' | 'curated' | 'api' | 'metrics' | 'ai' | 'plan';
export type Lane = 'live' | 'pilot';
export type NodeState = 'ok' | 'idle' | 'warn' | 'down' | 'pending' | 'planned';
export type EdgeStatus = 'live' | 'pending' | 'planned';

export const NW = 180, NH = 96;
const XS = [0, 245, 500, 755, 1010, 1265];
const C = (i: number) => XS[i];
export const ROW = { band: 40, r0: 116, r1: 248, r2: 380, cw: 512, pilotHead: 610, p0: 656, p1: 790 };
export const VB_W = 1440, VB_H = 900;

export interface NodeDef {
  id: string; lane: Lane; x: number; y: number; w?: number; h?: number; band?: boolean;
  title: string; service: string; icon: IconName; flow: Flow;
  role: string; spec: string; cost: string;
}

export const NODES: NodeDef[] = [
  { id: 'iam', lane: 'live', band: true, x: 0, y: ROW.band, w: VB_W, h: 40, title: 'IAM', service: 'AWS IAM', icon: 'iam', flow: 'curated',
    role: 'Each component runs as its own role with only the actions and S3 prefixes it needs: the API reads curated/*, ingest writes raw/* and curated/*, the worker adds jobs/*, the scheduler may only start one instance.',
    spec: '4 roles · S3 prefix-scoped grants · Bedrock limited to one inference profile · scheduler trust bound to this account (aws:SourceAccount)',
    cost: 'No charge.' },
  { id: 'sched', lane: 'live', x: C(0), y: ROW.r0, w: 170, title: 'Weekly trigger', service: 'EventBridge', icon: 'schedule', flow: 'ingest',
    role: 'Fires the ingest Lambda every Monday so crash, AADT, roadway-inventory, speed and FARS extracts stay current.',
    spec: 'cron(0 8 ? * MON *) UTC · target retries 2', cost: 'Scheduled rules are free.' },
  { id: 'ingest', lane: 'live', x: C(1), y: ROW.r0, title: 'Lambda · ingest', service: 'AWS Lambda', icon: 'lambda', flow: 'ingest',
    role: 'Pulls TxDOT ArcGIS layers and NHTSA FARS, checksums each extract, then runs HSM screening and fits the NB SPF + Empirical Bayes; writes raw/ and curated/ objects and a run record.',
    spec: 'Python 3.13 · arm64 · 1024 MB · 15 min timeout · AWS SDK for pandas layer · DLQ (SQS) after 2 retries',
    cost: 'Billed per GB-second; a weekly run of ~10 s is a fraction of a cent.' },
  { id: 's3', lane: 'live', x: C(2), y: ROW.r1, title: 'S3 data lake', service: 'Amazon S3', icon: 'db', flow: 'curated',
    role: 'Single source of truth: raw/ extracts as fetched, curated/ outputs the API serves, runs/ records for every job, jobs/ bundle for the worker.',
    spec: 'SSE-S3 · versioned · public access blocked · TLS only · noncurrent versions expire after 30 d',
    cost: 'Storage is well under 1 GB; not metered on this page.' },
  { id: 'api', lane: 'live', x: C(3), y: ROW.r1, title: 'Lambda · API', service: 'FastAPI on Lambda', icon: 'lambda', flow: 'api',
    role: 'FastAPI on Mangum: screening, SPF/EB, corridor, intersection conflicts, VRU and this status endpoint, read from curated/ with ETags.',
    spec: 'Python 3.13 · arm64 · 1024 MB · 15 s timeout · JSON logs',
    cost: 'Billed per request and GB-second; the estimate below uses the p95 duration as an upper bound.' },
  { id: 'apigw', lane: 'live', x: C(4), y: ROW.r1, title: 'API Gateway', service: 'HTTP API', icon: 'gauge', flow: 'api',
    role: 'Public HTTPS front door for the API Lambda; Vercel rewrites /api/* here.',
    spec: 'Stage throttle 20 req/s, burst 40 · $default stage, auto-deploy',
    cost: 'US$1.00 per million requests.' },
  { id: 'vercel', lane: 'live', x: C(5), y: ROW.r1, w: 175, title: 'Dashboard', service: 'Vercel · React', icon: 'platform', flow: 'api',
    role: 'This portal: a static React build on Vercel’s edge, proxying /api to API Gateway.',
    spec: 'React 19 + Vite · app shell revalidated on every visit',
    cost: 'Hobby plan; no AWS cost.' },
  { id: 'cf', lane: 'live', x: C(4), y: ROW.r0, title: 'CloudFront', service: 'Amazon CloudFront', icon: 'edge', flow: 'api',
    role: 'Edge cache in front of an IAM-authenticated Lambda Function URL, replacing API Gateway once enabled.',
    spec: 'Defined in CDK (cdk deploy -c edge=cloudfront) · OAC · 300 s cache · Price Class 100 · awaiting AWS account verification',
    cost: 'Not deployed, so no cost yet.' },
  { id: 'scheduler', lane: 'live', x: C(0), y: ROW.r2, w: 170, title: 'Monthly trigger', service: 'EventBridge', icon: 'schedule', flow: 'ingest',
    role: 'Starts the batch worker on the 1st of each month through the EC2 StartInstances universal target.',
    spec: 'cron(0 9 1 * ? *) UTC · role may start only this instance', cost: 'First 14 million invocations per month are free.' },
  { id: 'ec2', lane: 'live', x: C(1), y: ROW.r2, title: 'EC2 batch worker', service: 'Amazon EC2', icon: 'ec2', flow: 'ingest',
    role: 'Rebuilds NGSIM trajectories, SSAM-style conflicts (TTC, PET) and the occlusion-repair evaluation, syncs them to curated/, writes a run record, then shuts itself down.',
    spec: 't4g.small · Amazon Linux 2023 arm64 · 12 GB gp3 encrypted · IMDSv2 · stops on shutdown + idle-CPU alarm backstop',
    cost: 'Billed only while running; the stopped volume costs about US$0.96 a month.' },
  { id: 'bedrock', lane: 'live', x: C(4), y: ROW.r2, title: 'Bedrock analyst', service: 'Amazon Bedrock', icon: 'bedrock', flow: 'ai',
    role: 'Answers questions on the Ask page by calling the API’s own tools. Until model access is granted, a deterministic in-Lambda analyst answers from the same tools.',
    spec: 'Claude Haiku 4.5 via the us. inference profile · awaiting AWS account verification · fallback active',
    cost: 'Zero while the fallback is active; rate-limited to 10 questions/min per client plus a daily cap.' },
  { id: 'cw', lane: 'live', band: true, x: 0, y: ROW.cw, w: VB_W, h: 44, title: 'CloudWatch', service: 'Amazon CloudWatch', icon: 'pulse', flow: 'metrics',
    role: 'Collects Lambda, API Gateway and EC2 metrics and JSON logs; the RoadScope dashboard and alarms watch errors, DLQ depth and an idle worker.',
    spec: 'Dashboard “RoadScope” · 4 alarms (API errors, ingest errors, DLQ depth, worker idle) · logs kept 14 d',
    cost: 'Within the Always Free tier (10 alarms, 3 dashboards).' },

  // Pilot design: what the roadside-LiDAR pedestrian-warning deployment would add. Nothing here runs.
  { id: 'sensor', lane: 'pilot', x: C(0), y: ROW.p0, w: 170, title: 'Roadside LiDAR', service: 'Field sensor', icon: 'sensor', flow: 'plan',
    role: 'Pole-mounted LiDAR at a mid-block or uncontrolled crosswalk, 10 Hz point clouds.',
    spec: 'Planned · needs site, mounting permit and power/backhaul', cost: 'Hardware is outside the AWS budget.' },
  { id: 'edgeu', lane: 'pilot', x: C(1), y: ROW.p0, title: 'Edge unit', service: 'Roadside computer', icon: 'scan', flow: 'plan',
    role: 'Background filtering, clustering, tracking and pedestrian classification on site; sends object lists, never raw point clouds.',
    spec: 'Planned · trajectories at 10 Hz with track confidence', cost: 'Upload of object lists only keeps transfer small.' },
  { id: 'beacon', lane: 'pilot', x: C(1), y: ROW.p1, title: 'Warning beacon', service: 'Local actuation', icon: 'alert', flow: 'plan',
    role: 'Triggers the pedestrian warning (e.g. an RRFB) from the edge unit, independent of the cloud.',
    spec: 'Planned · local loop, target under 100 ms', cost: 'No cloud dependency.' },
  { id: 'ps3', lane: 'pilot', x: C(2), y: ROW.p0, title: 'S3 · pilot/', service: 'Amazon S3', icon: 'db', flow: 'plan',
    role: 'Same bucket, new prefix for object lists and events, partitioned by site and hour.',
    spec: 'Planned · lifecycle to Glacier after the analysis window', cost: 'Scales with sites × hours.' },
  { id: 'health', lane: 'pilot', x: C(2), y: ROW.p1, title: 'Sensor health', service: 'CloudWatch metrics', icon: 'offline', flow: 'plan',
    role: 'Uptime, frame completeness and packet gaps per site, with an alarm when a sensor goes quiet.',
    spec: 'Planned', cost: 'A few custom metrics per site.' },
  { id: 'pconf', lane: 'pilot', x: C(3), y: ROW.p0, title: 'Lambda · conflicts', service: 'AWS Lambda', icon: 'lambda', flow: 'plan',
    role: 'Extracts PET, TTC and driver failure-to-yield events from each hour of trajectories.',
    spec: 'Planned · reuses the SSAM-style extractor already running on NGSIM', cost: 'Per-hour batches keep it in the free tier for a few sites.' },
  { id: 'papi', lane: 'pilot', x: C(4), y: ROW.p0, title: 'API · /pilot', service: 'Same FastAPI Lambda', icon: 'gauge', flow: 'plan',
    role: 'Site, hour and before/after endpoints with confidence intervals.',
    spec: 'Planned', cost: 'Same Lambda, same API.' },
  { id: 'pdash', lane: 'pilot', x: C(5), y: ROW.p0, w: 175, title: 'SPAG dashboard', service: '15-county view', icon: 'county', flow: 'plan',
    role: 'County-level view for the South Plains Association of Governments: yielding rate, conflicts per hour, sensor health.',
    spec: 'Planned', cost: 'Same Vercel deployment.' },
];
export const NODE = Object.fromEntries(NODES.map((n) => [n.id, n])) as Record<string, NodeDef>;

export interface EdgeDef { id: string; from: string; to: string; flow: Flow; status: EdgeStatus; p: number[] }

type Port = 'r' | 'l' | 't' | 'b';
function port(id: string, side: Port, off = 0): [number, number] {
  const n = NODE[id], w = n.w ?? NW, h = n.h ?? NH;
  if (side === 'r') return [n.x + w, n.y + h / 2 + off];
  if (side === 'l') return [n.x, n.y + h / 2 + off];
  if (side === 't') return [n.x + w / 2 + off, n.y];
  return [n.x + w / 2 + off, n.y + h];
}
/** Smooth cubic between two ports with tangents matching the port sides. */
function curve(a: [number, number], sa: Port, b: [number, number], sb: Port, k = 0.5): number[] {
  const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
  const hx = Math.max(36, dx * k), vy = Math.max(30, dy * k);
  const c1 = sa === 'r' ? [a[0] + hx, a[1]] : sa === 'l' ? [a[0] - hx, a[1]] : sa === 'b' ? [a[0], a[1] + vy] : [a[0], a[1] - vy];
  const c2 = sb === 'l' ? [b[0] - hx, b[1]] : sb === 'r' ? [b[0] + hx, b[1]] : sb === 't' ? [b[0], b[1] - vy] : [b[0], b[1] + vy];
  return [a[0], a[1], c1[0], c1[1], c2[0], c2[1], b[0], b[1]];
}
const E = (id: string, from: string, sa: Port, to: string, sb: Port, flow: Flow, status: EdgeStatus = 'live', oa = 0, ob = 0, to2?: [number, number]): EdgeDef =>
  ({ id, from, to, flow, status, p: curve(port(from, sa, oa), sa, to2 ?? port(to, sb, ob), sb) });
const cwTop = (x: number): [number, number] => [x, ROW.cw];

export const EDGES: EdgeDef[] = [
  E('sched-ingest', 'sched', 'r', 'ingest', 'l', 'ingest'),
  E('ingest-s3', 'ingest', 'r', 's3', 't', 'ingest', 'live', 0, -40),
  E('scheduler-ec2', 'scheduler', 'r', 'ec2', 'l', 'ingest'),
  E('ec2-s3', 'ec2', 'r', 's3', 'b', 'ingest', 'live', 0, -40),
  E('s3-api', 's3', 'r', 'api', 'l', 'curated'),
  E('api-apigw', 'api', 'r', 'apigw', 'l', 'api', 'live', 6, 6),
  E('apigw-vercel', 'apigw', 'r', 'vercel', 'l', 'api', 'live', 6, 6),
  E('api-bedrock', 'api', 'b', 'bedrock', 'l', 'ai', 'pending', 40),
  E('api-cf', 'api', 't', 'cf', 'l', 'api', 'pending', 40),
  E('cf-vercel', 'cf', 'r', 'vercel', 't', 'api', 'pending', 0, 0),
  E('ingest-cw', 'ingest', 'r', 'cw', 't', 'metrics', 'live', 30, 0, cwTop(C(1) + NW + 20)),
  E('ec2-cw', 'ec2', 'b', 'cw', 't', 'metrics', 'live', -40, 0, cwTop(C(1) + NW / 2 - 40)),
  E('api-cw', 'api', 'b', 'cw', 't', 'metrics', 'live', -30, 0, cwTop(C(3) + NW / 2 - 30)),
  E('apigw-cw', 'apigw', 'r', 'cw', 't', 'metrics', 'live', 30, 0, cwTop(C(4) + NW + 20)),

  E('sensor-edgeu', 'sensor', 'r', 'edgeu', 'l', 'plan', 'planned'),
  E('edgeu-ps3', 'edgeu', 'r', 'ps3', 'l', 'plan', 'planned'),
  E('edgeu-beacon', 'edgeu', 'b', 'beacon', 't', 'plan', 'planned'),
  E('edgeu-health', 'edgeu', 'b', 'health', 'l', 'plan', 'planned', 50),
  E('ps3-pconf', 'ps3', 'r', 'pconf', 'l', 'plan', 'planned'),
  E('pconf-papi', 'pconf', 'r', 'papi', 'l', 'plan', 'planned'),
  E('papi-pdash', 'papi', 'r', 'pdash', 'l', 'plan', 'planned'),
];

// ---------- cubic Bézier helpers (pure, no DOM) ----------
export const pathD = (p: number[]) => `M${p[0]} ${p[1]} C${p[2]} ${p[3]} ${p[4]} ${p[5]} ${p[6]} ${p[7]}`;
export function bez(p: number[], t: number): [number, number] {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p[0] + b * p[2] + c * p[4] + d * p[6], a * p[1] + b * p[3] + c * p[5] + d * p[7]];
}
/** Arc-length lookup: N evenly spaced points along the curve, plus its length. */
export function lut(p: number[], n = 96): { pts: Float32Array; len: number } {
  const fine = 400, acc: number[] = [0], raw: [number, number][] = [bez(p, 0)];
  for (let i = 1; i <= fine; i++) {
    const q = bez(p, i / fine), r = raw[i - 1];
    raw.push(q); acc.push(acc[i - 1] + Math.hypot(q[0] - r[0], q[1] - r[1]));
  }
  const len = acc[fine], pts = new Float32Array((n + 1) * 2);
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * len;
    while (j < fine && acc[j + 1] < s) j++;
    const seg = acc[j + 1] - acc[j] || 1, f = Math.min(1, Math.max(0, (s - acc[j]) / seg));
    const a = raw[j], b = raw[Math.min(fine, j + 1)];
    pts[i * 2] = a[0] + (b[0] - a[0]) * f; pts[i * 2 + 1] = a[1] + (b[1] - a[1]) * f;
  }
  return { pts, len };
}

// ---------- reading live state ----------
const hrs = (iso?: string, now = Date.now()) => (iso ? (now - Date.parse(iso)) / 3.6e6 : NaN);
export const ago = (iso?: string, now = Date.now()) => {
  const h = hrs(iso, now);
  if (!Number.isFinite(h)) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} d ago`;
};
export const compact = (v: number) => (v >= 1e4 ? `${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}k` : v.toLocaleString('en-US', { maximumFractionDigits: 0 }));
const fmtShort = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).replace(',', '');
const fmtUtc = (d: Date) => `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${String(d.getUTCHours()).padStart(2, '0')}:00 UTC`;

/** Next fire of cron(0 8 ? * MON *): Mondays 08:00 UTC. */
export function nextWeekly(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8));
  const add = (1 - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + add);
  if (d <= now) d.setUTCDate(d.getUTCDate() + 7);
  return d;
}
/** Next fire of cron(0 9 1 * ? *): the 1st of each month, 09:00 UTC. */
export function nextMonthly(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 9));
  if (d <= now) d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

export const job = (r: PlatformRun) => (r.detail?.job as string | undefined) ?? '';
export const finished = (r: PlatformRun) => (r.detail?.finished_at as string | undefined) ?? r.last_modified;
const runStart = (r: PlatformRun) => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(r.detail?.run_id ?? ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
};
/** Job wall time: the run record's own seconds, else finished_at minus the run id timestamp. */
export const runSeconds = (r: PlatformRun): number | null => {
  const s = r.detail?.seconds;
  if (typeof s === 'number') return s;
  const v = (Date.parse(finished(r)) - runStart(r)) / 1000;
  return Number.isFinite(v) && v >= 0 ? v : null;
};

export interface Recovery { job: string; node: string; failed: PlatformRun; recovered: PlatformRun; minutes: number }
const JOB_NODE: Record<string, string> = { ingest: 'ingest', trajectories: 'ec2' };

/** Most recent real failed → succeeded sequence for any job, from the run records. */
export function findRecovery(runs: PlatformRun[]): Recovery | null {
  const asc = [...runs].sort((a, b) => Date.parse(finished(a)) - Date.parse(finished(b)));
  let best: Recovery | null = null;
  for (let i = 0; i < asc.length; i++) {
    if (asc[i].detail?.status !== 'failed') continue;
    const j = job(asc[i]);
    const next = asc.slice(i + 1).find((r) => job(r) === j);
    if (next?.detail?.status === 'succeeded' && JOB_NODE[j]) {
      best = { job: j, node: JOB_NODE[j], failed: asc[i], recovered: next,
        minutes: Math.max(1, Math.round((Date.parse(finished(next)) - Date.parse(finished(asc[i]))) / 60000)) };
    }
  }
  return best;
}

export interface NodeLive { state: NodeState; chip: string; metrics: [string, string][]; source: string; sub?: string }
export interface EdgeLive { volume: number | null; label: string; rate: number; speed: number }
export interface CostLine { item: string; basis: string; usd: number }
export interface Live {
  local: boolean; nodes: Record<string, NodeLive>; edges: Record<string, EdgeLive>;
  recovery: Recovery | null; cost: { total: number; lines: CostLine[]; metered: boolean };
  readouts: { up: number; of: number; lastIngestH: number | null; p95: number | null };
  verdict: { s: 'ok' | 'warn' | 'down' | 'idle'; text: string };
}

/** Comets per second and px/s from a volume; log-scaled so 3 runs and 80k records both read. */
export const rateOf = (v: number | null) => (v == null || v <= 0 ? 0 : Math.min(2.6, 0.32 + 0.46 * Math.log10(1 + v)));
export const speedOf = (v: number | null) => 64 + 22 * Math.log10(1 + Math.max(0, v ?? 0));

const PRICE = { lambdaGbS: 0.0000133334, lambdaReq: 0.2e-6, httpReq: 1e-6, t4gSmallH: 0.0168, gp3GbMo: 0.08 };

export function deriveLive(d: PlatformStatus | undefined, nowMs = Date.now()): Live {
  const now = new Date(nowMs);
  const local = d ? !d.on_aws : false;
  const runs = d?.runs ?? [];
  const fx = d?.metrics?.functions ?? {};
  const win = d?.metrics?.window_days ?? 7;
  const sources = d?.manifest?.sources ?? [];
  const traj = sources.filter((s) => s.id.startsWith('ngsim'));
  const pub = sources.filter((s) => !s.id.startsWith('ngsim'));
  const sum = (xs: { records: number }[]) => xs.reduce((a, s) => a + s.records, 0);
  const pubRec = pub.length ? sum(pub) : null, trajRec = traj.length ? sum(traj) : null;
  const latest = (j: string) => runs.filter((r) => job(r) === j).sort((a, b) => Date.parse(finished(b)) - Date.parse(finished(a)))[0];
  const inWin = (j: string) => runs.filter((r) => job(r) === j && hrs(finished(r), nowMs) <= win * 24).length;
  const m = (f: string, k: 'invocations' | 'errors' | 'duration_p95_ms'): number | null => {
    const x = fx[f]?.[k];
    if (!x) return null;
    return (k === 'duration_p95_ms' ? x.max_daily : x.total) ?? null;
  };
  const apiInv = m('api', 'invocations'), apiErr = m('api', 'errors'), apiP95 = m('api', 'duration_p95_ms');
  const ingInv = m('ingest', 'invocations'), ingErr = m('ingest', 'errors'), ingP95 = m('ingest', 'duration_p95_ms');
  const li = latest('ingest'), lt = latest('trajectories');
  const cwSrc = `CloudWatch GetMetricData, last ${win} d`;
  const nodes: Record<string, NodeLive> = {};
  const set = (id: string, v: NodeLive) => { nodes[id] = v; };
  const wk = nextWeekly(now), mo = nextMonthly(now);

  set('iam', { state: 'ok', chip: '4 roles · least privilege', metrics: [['Roles', 'API, ingest, worker, scheduler'], ['Scope', 'S3 prefixes per role']], source: 'Stack definition (infra/cdk)' });
  set('sched', { state: 'ok', chip: `Next ${fmtShort(wk)}`,
    metrics: [['Next run', fmtUtc(wk)], ['Last fired', li ? ago(finished(li), nowMs) : '—']], source: 'Cron expression in the stack; last run from S3 run records' });
  set('scheduler', { state: 'ok', chip: `Next ${fmtShort(mo)}`,
    metrics: [['Next run', fmtUtc(mo)], ['Last worker job', lt ? ago(finished(lt), nowMs) : '—']], source: 'Cron expression in the stack; last job from S3 run records' });

  // Ingest Lambda
  {
    const failed = li?.detail?.status === 'failed';
    const met: [string, string][] = [];
    if (ingInv != null) met.push([`Invocations (${win} d)`, compact(ingInv)]);
    if (ingErr != null) met.push([`Errors (${win} d)`, compact(ingErr)]);
    if (ingP95 != null) met.push(['p95 duration', `${(ingP95 / 1000).toFixed(1)} s`]);
    if (li) met.push(['Last run', `${li.detail?.status ?? '—'} · ${ago(finished(li), nowMs)}`]);
    if (pubRec != null) met.push(['Records per run', compact(pubRec)]);
    const chip = failed ? `Failed · ${ago(finished(li), nowMs)}`
      : ingInv != null ? `${compact(ingInv)} runs · p95 ${((ingP95 ?? 0) / 1000).toFixed(1)}s`
      : li ? `OK · ${ago(finished(li), nowMs)}`
      : pub.length ? `Fetched ${ago(pub.map((s) => s.fetched_at).sort().at(-1), nowMs)}` : 'No run recorded';
    set('ingest', { state: failed ? 'down' : (ingErr ?? 0) > 0 ? 'warn' : li || ingInv != null || pub.length ? 'ok' : 'idle', chip, metrics: met,
      source: ingInv != null ? `${cwSrc}; run record ${li?.detail?.run_id ?? ''}` : local ? 'Local manifest (data/curated)' : 'S3 run records' });
  }
  // EC2 worker
  {
    const failed = lt?.detail?.status === 'failed';
    const running = lt?.detail?.status === 'running';
    const secs = lt ? runSeconds(lt) : null;
    const met: [string, string][] = [['Instance state', running ? 'running' : lt ? 'stopped (self-stops after each job)' : '—']];
    if (lt) met.push(['Last job', `${lt.detail?.status ?? '—'} · ${ago(finished(lt), nowMs)}`]);
    if (secs != null) met.push(['Job wall time', `${Math.round(secs)} s`]);
    if (trajRec != null) met.push(['NGSIM rows per job', compact(trajRec)]);
    met.push(['Jobs in run history', String(runs.filter((r) => job(r) === 'trajectories').length)]);
    set('ec2', { state: failed ? 'down' : running ? 'ok' : 'idle',
      chip: failed ? `Failed · ${ago(finished(lt), nowMs)}` : running ? 'Running a job' : lt ? `Idle · ran ${ago(finished(lt), nowMs)}` : traj.length ? `Built ${ago(traj[0].fetched_at, nowMs)}` : 'Stopped',
      metrics: met, source: 'S3 run records (instance state inferred: the worker stops itself after every job)' });
  }
  set('s3', { state: d?.manifest ? 'ok' : 'idle',
    chip: d?.manifest ? `${sources.length} src · ${compact(sum(sources))} rows` : 'Manifest missing',
    metrics: [['Sources', String(sources.length)], ['Records (curated)', sources.length ? compact(sum(sources)) : '—'], ['Manifest written', ago(d?.manifest?.generated_at, nowMs)], ['Location', d?.data_source?.replace(/^local:.*\/(data\/curated)$/, 'local: $1') ?? '—']],
    source: 'curated/manifest.json' });
  {
    const met: [string, string][] = [];
    if (apiInv != null) met.push([`Invocations (${win} d)`, compact(apiInv)], [`Errors (${win} d)`, compact(apiErr ?? 0)], ['p95 duration (worst day)', `${Math.round(apiP95 ?? 0)} ms`]);
    else met.push(['Mode', local ? 'Local uvicorn, no CloudWatch' : 'No metrics returned']);
    set('api', { state: (apiErr ?? 0) > 0 ? 'warn' : 'ok',
      chip: apiInv != null ? `${compact(apiInv)} req · p95 ${Math.round(apiP95 ?? 0)}ms` : local ? 'Serving locally' : 'Serving',
      metrics: met, source: apiInv != null ? cwSrc : 'This request' });
  }
  set('apigw', { state: local ? 'idle' : 'ok',
    chip: local ? 'Bypassed locally' : `${apiInv != null ? compact(apiInv) : '—'} req · cap 20/s`,
    metrics: [['Throttle', '20 req/s, burst 40'], [`Requests (${win} d)`, apiInv != null ? `${compact(apiInv)} (= API Lambda invocations)` : '—']],
    source: local ? 'Dev server proxies /api straight to uvicorn' : 'Stage settings; requests counted from Lambda invocations' });
  set('vercel', { state: 'ok', chip: local ? 'Vite dev server' : 'Deployment live', metrics: [['You are here', local ? 'localhost' : 'roadscope-ai-demo.vercel.app']], source: 'This page' });
  set('cf', { state: 'pending', sub: 'Awaiting AWS verification', chip: 'Defined in CDK', metrics: [['Status', 'In CDK, not deployed'], ['Enable with', 'cdk deploy -c edge=cloudfront']], source: 'Stack definition' });
  set('bedrock', { state: 'pending', sub: 'Awaiting AWS verification', chip: 'Fallback active', metrics: [['Model', 'Claude Haiku 4.5 (inference profile)'], ['Answers now from', 'Deterministic analyst in the API Lambda']], source: 'Deployment record (docs/DEPLOY.md)' });
  set('cw', { state: d?.metrics ? 'ok' : 'idle', chip: d?.metrics ? `Dashboard + 4 alarms · ${win}-day window` : local ? 'AWS only · not in local mode' : 'Metrics unavailable',
    metrics: [['Dashboard', 'RoadScope'], ['Alarms', 'API errors ≥ 5/5 min, ingest errors ≥ 1, DLQ ≥ 1, worker idle 1 h'], ['Log retention', '14 days']], source: d?.metrics ? cwSrc : 'Stack definition' });
  for (const n of NODES) if (n.lane === 'pilot') set(n.id, { state: 'planned', chip: 'Planned', metrics: [], source: 'Design only' });

  // Edges
  const ingVol = ingInv ?? (inWin('ingest') || null);
  const trajJobs = inWin('trajectories') || null;
  const ed = (vol: number | null, label: string): EdgeLive => ({ volume: vol, label, rate: rateOf(vol), speed: speedOf(vol) });
  const edges: Record<string, EdgeLive> = {
    'sched-ingest': ed(ingVol, ingVol ? `${compact(ingVol)}|runs/${win}d` : '|weekly'),
    'ingest-s3': ed(pubRec, pubRec ? `${compact(pubRec)}|records / run` : ''),
    'scheduler-ec2': ed(trajJobs, trajJobs ? `${trajJobs}|jobs/${win}d` : '|monthly'),
    'ec2-s3': ed(trajRec, trajRec ? `${compact(trajRec)}|NGSIM rows / job` : ''),
    's3-api': ed(apiInv, apiInv != null ? `${compact(apiInv)}|reads/${win}d` : local ? '|local reads' : ''),
    'api-apigw': ed(apiInv, apiInv != null ? `${compact(apiInv)}|resp/${win}d` : ''),
    'apigw-vercel': ed(apiInv, local ? '|Vite proxy' : ''),
    'api-bedrock': ed(null, 'fallback|in-Lambda analyst'),
    'api-cf': ed(null, ''), 'cf-vercel': ed(null, 'defined|not deployed'),
    'ingest-cw': ed(ingInv, ''), 'ec2-cw': ed(trajJobs, ''), 'api-cw': ed(apiInv, ''), 'apigw-cw': ed(local ? null : apiInv, ''),
  };
  if (local && apiInv == null) edges['s3-api'] = { ...edges['s3-api'], rate: 0.5, speed: 70 };
  for (const e of EDGES) if (e.status === 'planned') edges[e.id] = ed(null, '');

  // Monthly cost estimate (list prices, us-east-2, before credits and free tier)
  const scale = 30 / win;
  const lines: CostLine[] = [];
  const lam = (inv: number | null, p95: number | null) => (inv ?? 0) * ((p95 ?? 0) / 1000) * 1 * PRICE.lambdaGbS * scale + (inv ?? 0) * PRICE.lambdaReq * scale;
  const metered = apiInv != null || ingInv != null;
  if (metered) {
    lines.push({ item: 'Lambda (API + ingest)', basis: `invocations × p95 duration × 1 GB × $${PRICE.lambdaGbS}/GB-s, ×${scale.toFixed(1)} to 30 d`, usd: lam(apiInv, apiP95) + lam(ingInv, ingP95) });
    lines.push({ item: 'HTTP API requests', basis: '$1.00 per million', usd: (apiInv ?? 0) * PRICE.httpReq * scale });
  }
  const jobS = lt ? runSeconds(lt) : null;
  lines.push({ item: 'EC2 t4g.small', basis: jobS != null ? `1 scheduled job/month × ${Math.round(jobS)} s × $${PRICE.t4gSmallH}/h (boot excluded)` : 'runs only during the monthly job', usd: ((jobS ?? 0) / 3600) * PRICE.t4gSmallH });
  lines.push({ item: 'EBS gp3, 12 GB', basis: `12 GB × $${PRICE.gp3GbMo}/GB-month, billed while stopped`, usd: 12 * PRICE.gp3GbMo });
  lines.push({ item: 'CloudWatch', basis: '4 alarms, 1 dashboard: inside Always Free', usd: 0 });
  lines.push({ item: 'Bedrock', basis: 'fallback active, no model calls', usd: 0 });
  const total = lines.reduce((a, l) => a + l.usd, 0);

  const liveIds = NODES.filter((n) => n.lane === 'live' && !['cf', 'bedrock'].includes(n.id)).map((n) => n.id);
  const down = liveIds.filter((id) => nodes[id].state === 'down');
  const warn = liveIds.filter((id) => nodes[id].state === 'warn');
  const up = liveIds.filter((id) => ['ok', 'idle'].includes(nodes[id].state)).length;
  const verdict: Live['verdict'] = !d ? { s: 'idle', text: 'Checking…' }
    : down.length ? { s: 'down', text: `${down.map((id) => NODE[id].title).join(', ')} failing` }
    : warn.length ? { s: 'warn', text: `Errors on ${warn.map((id) => NODE[id].title).join(', ')}` }
    : local ? { s: 'idle', text: 'Local mode · no AWS signal' }
    : { s: 'ok', text: 'All running stages nominal' };
  const lastIngestH = li ? hrs(finished(li), nowMs) : pub.length ? hrs(pub.map((s) => s.fetched_at).sort().at(-1), nowMs) : null;

  return { local, nodes, edges, recovery: findRecovery(runs), cost: { total, lines, metered },
    readouts: { up, of: liveIds.length, lastIngestH: lastIngestH != null && Number.isFinite(lastIngestH) ? lastIngestH : null, p95: apiP95 },
    verdict };
}
