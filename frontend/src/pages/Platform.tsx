import { useEffect, useRef, useState } from 'react';
import { useApi } from '../lib/api';
import { nf } from '../lib/format';
import type { PlatformRun, PlatformStatus } from '../lib/types';
import '../styles/platform.css';

type N = { id: string; x: number; y: number; t: string; s: string };
const W = 200, H = 100;
const NODES: N[] = [
  { id: 'sched', x: 20, y: 30, t: 'EventBridge rule', s: 'Weekly ingest schedule' },
  { id: 'ingest', x: 270, y: 30, t: 'Lambda · ingest', s: 'ArcGIS + FARS pull, curate' },
  { id: 'cw', x: 780, y: 30, t: 'CloudWatch', s: 'Dashboard, alarms, logs' },
  { id: 'scheduler', x: 20, y: 200, t: 'EventBridge Scheduler', s: 'Monthly trajectory job' },
  { id: 'ec2', x: 270, y: 200, t: 'EC2 batch worker', s: 'SSM-run, stops itself' },
  { id: 's3', x: 525, y: 200, t: 'S3', s: 'raw/ and curated/ prefixes' },
  { id: 'iam', x: 780, y: 200, t: 'IAM', s: 'One least-privilege role per job' },
  { id: 'vercel', x: 20, y: 370, t: 'Vercel', s: 'Static frontend, /api proxy' },
  { id: 'cf', x: 270, y: 370, t: 'API Gateway', s: 'HTTP API, 20 req/s throttle' },
  { id: 'api', x: 525, y: 370, t: 'Lambda · API', s: 'FastAPI on Mangum' },
  { id: 'bedrock', x: 780, y: 370, t: 'Bedrock', s: 'Ask: tool-using model' },
];
const EDGES: { d: string; k?: 'mon' }[] = [
  { d: 'M220 80 H270' },
  { d: 'M470 105 H625 V200' },
  { d: 'M470 55 H780', k: 'mon' },
  { d: 'M220 250 H270' },
  { d: 'M470 250 H525' },
  { d: 'M220 420 H270' },
  { d: 'M470 420 H525' },
  { d: 'M625 370 V300' },
  { d: 'M725 420 H780' },
  { d: 'M690 370 V340 H880 V130', k: 'mon' },
];

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

  const figRef = useRef<HTMLDivElement>(null);
  const [flow, setFlow] = useState(false);
  useEffect(() => {
    const el = figRef.current;
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setFlow(true); io.disconnect(); } }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const sources = d?.manifest?.sources ?? [];

  return (
    <div className="page platform">
      <header className="page-head">
        <h1>The AWS system behind the data</h1>
        <p>
          Public sources are pulled on a schedule by a Lambda function, curated into S3, and served through API Gateway
          by a FastAPI Lambda. The trajectory build is too heavy for Lambda and runs on an EC2 worker that starts on a
          schedule, runs one job through Systems Manager and stops itself. Every role is scoped to the prefixes and
          actions its job needs.
        </p>
      </header>

      {st.error && <div className="error-box">Platform status unavailable: {st.error}</div>}
      {local && (
        <div className="panel pf-local" role="status">
          <strong>Local mode.</strong> The API is running outside AWS ({d!.data_source.replace(/^local:.*\/(data\/curated)$/, 'local:$1')}),
          so CloudWatch metrics and S3 run history are not available. Node status below shows what the local data can confirm.
        </div>
      )}
      {d?.errors.length ? <div className="error-box">{d.errors.join('; ')}</div> : null}

      <section className="section" aria-labelledby="pf-arch">
        <div className="section-head"><h2 id="pf-arch">Architecture</h2><p>Solid lines carry data; dashed lines carry metrics and logs</p></div>
        <div className="panel pf-fig" ref={figRef}>
          <svg viewBox="0 0 1000 490" role="img" aria-labelledby="pf-svg-t pf-svg-d" className={flow ? 'pf-flow' : ''}>
            <title id="pf-svg-t">RoadScope AWS architecture</title>
            <desc id="pf-svg-d">
              An EventBridge rule triggers the ingest Lambda, which writes raw and curated objects to S3 and reports to CloudWatch.
              EventBridge Scheduler starts an EC2 batch worker that builds trajectories into S3. Vercel proxies API requests to
              an API Gateway HTTP API, which invokes the API Lambda; the API reads S3 and calls Bedrock for questions. IAM roles scope each component.
            </desc>
            <defs>
              <marker id="pf-ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L8 4 L0 8 z" fill="var(--ink-2)" />
              </marker>
            </defs>
            <g className="pf-lane-labels">
              <text x="20" y="20">Ingest</text><text x="20" y="190">Batch</text><text x="20" y="360">Serve</text>
            </g>
            {EDGES.map((e, i) => (
              <g key={i}>
                <path d={e.d} className={`pf-edge ${e.k === 'mon' ? 'mon' : ''}`} markerEnd="url(#pf-ah)" />
                {e.k !== 'mon' && <path d={e.d} className="pf-dash" style={{ animationDelay: `${i * 90}ms` }} />}
              </g>
            ))}
            {NODES.map((n) => {
              const s = status[n.id];
              return (
                <g key={n.id} transform={`translate(${n.x} ${n.y})`} className="pf-node">
                  <rect width={W} height={H} rx={3} />
                  <text x={12} y={26} className="pf-t">{n.t}</text>
                  <text x={12} y={46} className="pf-s">{n.s}</text>
                  <line x1={12} x2={W - 12} y1={62} y2={62} className="pf-rule" />
                  <circle cx={17} cy={80} r={4} className={s ? 'pf-ok' : 'pf-na'} />
                  <text x={28} y={84} className={`pf-st ${s ? 'num' : ''}`}>{s ?? (st.loading ? 'Checking…' : local ? 'No local signal' : 'No data')}</text>
                </g>
              );
            })}
          </svg>
        </div>
      </section>

      <div className="pf-cols">
        <section className="section" aria-labelledby="pf-runs">
          <div className="section-head"><h2 id="pf-runs">Pipeline runs</h2><p>Newest first, from curated/runs/</p></div>
          {d && d.runs.length === 0 && <p className="muted">No run records{local ? ' in the local data directory. Runs are written by the ingest Lambda and the EC2 job when deployed.' : '.'}</p>}
          {st.loading && <div className="skeleton pf-skel" />}
          {d && d.runs.length > 0 && (
            <div className="pf-scroll">
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

        <section className="section" aria-labelledby="pf-fresh">
          <div className="section-head"><h2 id="pf-fresh">Data freshness</h2><p>Fetch time per source, from the manifest</p></div>
          {sources.length > 0 && (
            <div className="pf-scroll">
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

      <section className="section" aria-labelledby="pf-cost">
        <div className="section-head"><h2 id="pf-cost">Cost guardrails</h2></div>
        <dl className="pf-guard">
          <div><dt>Error alarms</dt><dd>CloudWatch alarms on API errors, ingest errors and ingest dead-letter queue depth.</dd></div>
          <div><dt>Throttling and caching</dt><dd>The HTTP API stage throttles at 20 requests/s (burst 40). GET responses carry ETags and a 300 s Cache-Control, so browsers and the Vercel edge revalidate instead of re-downloading. A CloudFront distribution with origin access control is defined in the stack (<code>-c edge=cloudfront</code>) and will replace the HTTP API once AWS completes account verification.</dd></div>
          <div><dt>Ask limits</dt><dd>Per-client rate limit (10 per minute) and a daily question budget; beyond either the endpoint returns 429.</dd></div>
          <div><dt>Batch compute</dt><dd>The EC2 worker runs for the duration of one job and shuts itself down, so idle hours cost nothing.</dd></div>
          <div><dt>Budget</dt><dd>An account-level AWS Budget (<code>roadscope-transtech-cap</code>, US$40 per month) tracks spend; it sits outside the stack so tearing the stack down never removes the guardrail.</dd></div>
          <div><dt>Concurrency</dt><dd>The account&rsquo;s Lambda concurrency limit is 10, which already caps simultaneous executions; reserving concurrency becomes meaningful once AWS raises the quota.</dd></div>
        </dl>
      </section>
    </div>
  );
}
