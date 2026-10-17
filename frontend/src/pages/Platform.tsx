import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useApi } from '../lib/api';
import { nf } from '../lib/format';
import { reducedMotion, useReveal } from '../lib/motion';
import type { PlatformRun, PlatformStatus } from '../lib/types';
import '../styles/platform.css';

type Lane = 'Ingest' | 'Batch' | 'Serve';
type N = { id: string; x: number; y: number; t: string; s: string; lane: Lane };
const W = 212, H = 104;
const NODES: N[] = [
  { id: 'sched', x: 0, y: 34, t: 'EventBridge rule', s: 'Weekly ingest schedule', lane: 'Ingest' },
  { id: 'ingest', x: 262, y: 34, t: 'Lambda · ingest', s: 'ArcGIS + FARS pull, curate', lane: 'Ingest' },
  { id: 'cw', x: 786, y: 34, t: 'CloudWatch', s: 'Dashboard, alarms, logs', lane: 'Ingest' },
  { id: 'scheduler', x: 0, y: 204, t: 'EventBridge Scheduler', s: 'Monthly trajectory job', lane: 'Batch' },
  { id: 'ec2', x: 262, y: 204, t: 'EC2 batch worker', s: 'SSM-run, stops itself', lane: 'Batch' },
  { id: 's3', x: 524, y: 204, t: 'S3', s: 'raw/ and curated/ prefixes', lane: 'Batch' },
  { id: 'iam', x: 786, y: 204, t: 'IAM', s: 'Least-privilege role per job', lane: 'Batch' },
  { id: 'vercel', x: 0, y: 374, t: 'Vercel', s: 'Static frontend, /api proxy', lane: 'Serve' },
  { id: 'cf', x: 262, y: 374, t: 'API Gateway', s: 'HTTP API, 20 req/s throttle', lane: 'Serve' },
  { id: 'api', x: 524, y: 374, t: 'Lambda · API', s: 'FastAPI on Mangum', lane: 'Serve' },
  { id: 'bedrock', x: 786, y: 374, t: 'Bedrock', s: 'Ask: tool-using model', lane: 'Serve' },
];
const EDGES: { d: string; a: string; b: string; k?: 'mon' }[] = [
  { d: 'M212 86 H262', a: 'sched', b: 'ingest' },
  { d: 'M474 112 H630 V204', a: 'ingest', b: 's3' },
  { d: 'M474 58 H786', a: 'ingest', b: 'cw', k: 'mon' },
  { d: 'M212 256 H262', a: 'scheduler', b: 'ec2' },
  { d: 'M474 256 H524', a: 'ec2', b: 's3' },
  { d: 'M212 426 H262', a: 'vercel', b: 'cf' },
  { d: 'M474 426 H524', a: 'cf', b: 'api' },
  { d: 'M630 374 V308', a: 'api', b: 's3' },
  { d: 'M736 426 H786', a: 'api', b: 'bedrock' },
  { d: 'M736 398 H761 V112 H786', a: 'api', b: 'cw', k: 'mon' },
];
const LANES: [Lane, number][] = [['Ingest', 22], ['Batch', 192], ['Serve', 362]];

const ago = (iso?: string) => {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return iso;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const job = (r: PlatformRun) => (r.detail?.job as string | undefined) ?? (r.key.split('/').pop() ?? '');
const fin = (r: PlatformRun) => (r.detail?.finished_at as string | undefined) ?? r.last_modified;

export default function Platform() {
  const st = useApi<PlatformStatus>('/platform/status');
  const d = st.data;
  const local = d ? !d.on_aws : false;
  const fx = d?.metrics?.functions ?? {};
  const lastRun = (j: string) => d?.runs.find((r) => job(r) === j);

  const fnLine = (k: string): string | null => {
    const f = fx[k];
    if (!f) return null;
    const inv = f.invocations?.total, err = f.errors?.total, p95 = f.duration_p95_ms?.max_daily;
    return `${nf(inv)} inv · ${nf(err)} err · p95 ${nf(p95)} ms`;
  };
  const status: Record<string, string | null> = d ? {
    ingest: fnLine('ingest') ?? (lastRun('ingest') ? `Last run ${ago(fin(lastRun('ingest')!))}` : null),
    ec2: lastRun('trajectories') ? `Last run ${ago(fin(lastRun('trajectories')!))} · ${lastRun('trajectories')!.detail?.status ?? ''}` : null,
    s3: d.manifest?.generated_at ? `Manifest ${ago(d.manifest.generated_at)}` : null,
    api: fnLine('api') ?? (local ? 'Serving locally' : null),
    cw: d.metrics ? `${d.metrics.window_days}-day window` : null,
  } : {};
  const idle = st.loading ? 'Checking…' : local ? 'No local signal' : 'No data';

  // The data-flow pass runs once, when the diagram first comes into view.
  const figRef = useRef<HTMLDivElement>(null);
  const [flow, setFlow] = useState(false);
  useEffect(() => {
    const el = figRef.current;
    if (!el || reducedMotion()) { setFlow(true); return; }
    el.dataset.armed = '';
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setFlow(true); io.disconnect(); } }, { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const [hot, setHot] = useState<string | null>(null);
  const linked = (id: string) => !hot || hot === id || EDGES.some((e) => (e.a === hot && e.b === id) || (e.b === hot && e.a === id));

  const headRef = useReveal<HTMLElement>(), tablesRef = useReveal<HTMLDivElement>(), guardRef = useReveal<HTMLElement>();
  const sources = d?.manifest?.sources ?? [];
  const showRuns = st.loading || (d?.runs.length ?? 0) > 0;

  return (
    <div className="page platform">
      <header className="page-head pf-head" ref={headRef}>
        <h1 data-r="1">The AWS system behind the data</h1>
        <p data-r="2">Scheduled ingest into S3, a self-stopping EC2 trajectory worker, and a FastAPI Lambda behind API Gateway, each on its own IAM role.</p>
        {local && (
          <p className="pf-local" role="status" data-r="3">
            Local mode, reading <span className="num">{d!.data_source.replace(/^local:.*\/(data\/curated)$/, 'local:$1')}</span>. CloudWatch metrics and S3 run history exist only on AWS.
          </p>
        )}
      </header>

      {st.error && <div className="error-box">Platform status unavailable: {st.error}</div>}
      {d?.errors.length ? <div className="error-box">{d.errors.join('; ')}</div> : null}

      <section className="section pf-arch" aria-labelledby="pf-arch">
        <h2 id="pf-arch" className="sr-only">Architecture</h2>
        <div className="pf-fig" ref={figRef} data-flow={flow || undefined}>
          <div className="pf-svg" data-ui>
          <svg viewBox="-60 0 1060 500" role="img" aria-labelledby="pf-svg-t pf-svg-d" onMouseLeave={() => setHot(null)}>
            <title id="pf-svg-t">RoadScope AWS architecture</title>
            <desc id="pf-svg-d">
              An EventBridge rule triggers the ingest Lambda, which writes raw and curated objects to S3 and reports to CloudWatch.
              EventBridge Scheduler starts an EC2 batch worker that builds trajectories into S3. Vercel proxies API requests to
              an API Gateway HTTP API, which invokes the API Lambda; the API reads S3 and calls Bedrock for questions. IAM roles scope each component.
            </desc>
            <defs>
              <marker id="pf-ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0 0.5 L8 4 L0 7.5 z" fill="var(--ink-3)" />
              </marker>
            </defs>
            {LANES.map(([l, y]) => <text key={l} x={-60} y={y} className="pf-lane">{l}</text>)}
            {EDGES.map((e, i) => {
              const on = !!hot && (e.a === hot || e.b === hot);
              return (
                <g key={i} className="pf-e" data-dim={(hot && !on) || undefined} data-on={on || undefined}>
                  <path d={e.d} className={`pf-edge${e.k === 'mon' ? ' mon' : ''}`} markerEnd="url(#pf-ah)" />
                  {e.k !== 'mon' && <path d={e.d} pathLength={1} className="pf-pulse" style={{ animationDelay: `${300 + i * 110}ms` }} />}
                </g>
              );
            })}
            {NODES.map((n, i) => {
              const s = status[n.id];
              return (
                <g key={n.id} transform={`translate(${n.x} ${n.y})`}>
                  <g className="pf-node" style={{ '--i': i } as CSSProperties} data-live={s ? '' : undefined} data-dim={!linked(n.id) || undefined}
                    data-hot={hot === n.id || undefined} onMouseEnter={() => setHot(n.id)}>
                    <rect width={W} height={H} rx={10} />
                    <text x={16} y={30} className="pf-t">{n.t}</text>
                    <text x={16} y={53} className="pf-s">{n.s}</text>
                    <circle cx={21} cy={82} r={4} className="pf-dot" />
                    {s && <circle cx={21} cy={82} r={4} className="pf-ring" />}
                    <text x={34} y={87} className="pf-st num">{s ?? idle}</text>
                  </g>
                </g>
              );
            })}
          </svg>
          </div>
          <ol className="pf-list">
            {LANES.map(([l]) => (
              <li key={l}>
                <p className="pf-lane-h">{l}</p>
                <ul>
                  {NODES.filter((n) => n.lane === l).map((n) => (
                    <li key={n.id} data-live={status[n.id] ? '' : undefined}>
                      <b>{n.t}</b>
                      <span>{n.s}</span>
                      <em className="num">{status[n.id] ?? idle}</em>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          <div className="pf-key" aria-hidden="true">
            <span><svg width="28" height="8"><path d="M1 4 H27" className="pf-edge" /></svg>Data</span>
            <span><svg width="28" height="8"><path d="M2 4 H27" className="pf-edge mon" /></svg>Metrics and logs</span>
            <span><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="var(--accent)" /></svg>Live signal</span>
          </div>
        </div>
      </section>

      <div className={`pf-cols${showRuns ? '' : ' one'}`} ref={tablesRef}>
        {showRuns && (
          <section className="section" aria-labelledby="pf-runs" data-r="1">
            <h2 id="pf-runs">Pipeline runs</h2>
            {st.loading && <div className="skeleton pf-skel" />}
            {d && d.runs.length > 0 && (
              <div className="pf-scroll" data-ui>
                <table className="data">
                  <thead><tr><th>Run</th><th>Job</th><th>Status</th><th>Finished</th><th className="r">Seconds</th></tr></thead>
                  <tbody>
                    {d.runs.map((r) => (
                      <tr key={r.key}>
                        <td className="num">{r.detail?.run_id ?? r.key.split('/').pop()}</td>
                        <td>{job(r)}</td>
                        <td className={r.detail?.status === 'failed' ? 'pf-bad' : ''}>{r.detail?.status ?? '—'}</td>
                        <td className="num">{fin(r).replace('T', ' ').slice(0, 16)}</td>
                        <td className="r num">{nf(r.detail?.seconds as number | undefined, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        <section className="section" aria-labelledby="pf-fresh" data-r="2">
          <h2 id="pf-fresh">Data freshness</h2>
          {sources.length > 0 && (
            <div className="pf-scroll" data-ui>
              <table className="data">
                <thead><tr><th>Source</th><th className="r">Records</th><th>Fetched</th><th className="r">Age</th></tr></thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={s.id}>
                      <td>{s.id}</td>
                      <td className="r num">{nf(s.records)}</td>
                      <td className="num">{s.fetched_at.replace('T', ' ').slice(0, 16)}</td>
                      <td className="r num">{ago(s.fetched_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <section className="section pf-cost" aria-labelledby="pf-cost" ref={guardRef}>
        <h2 id="pf-cost" data-r="1">Cost guardrails</h2>
        <dl className="pf-guard" data-r="2">
          <div><dt>Error alarms</dt><dd>CloudWatch alarms on API errors, ingest errors and dead-letter queue depth.</dd></div>
          <div><dt>Throttling and caching</dt><dd>HTTP API throttled at 20 requests/s (burst 40); GET responses carry ETags and a 300 s Cache-Control. A CloudFront edge (<code>-c edge=cloudfront</code>) replaces it once AWS verifies the account.</dd></div>
          <div><dt>Ask limits</dt><dd>10 per minute per client plus a daily budget; beyond either, 429.</dd></div>
          <div><dt>Batch compute</dt><dd>The EC2 worker runs one job, then stops itself.</dd></div>
          <div><dt>Budget</dt><dd>Account-level AWS Budget (<code>roadscope-transtech-cap</code>, US$40 per month), kept outside the stack.</dd></div>
          <div><dt>Concurrency</dt><dd>Account Lambda concurrency limit of 10 caps simultaneous executions.</dd></div>
        </dl>
      </section>
    </div>
  );
}
