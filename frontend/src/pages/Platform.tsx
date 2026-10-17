import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/api';
import { nf } from '../lib/format';
import { reducedMotion, useReveal } from '../lib/motion';
import type { PlatformStatus } from '../lib/types';
import PageHeader from '../components/PageHeader';
import Select from '../components/Select';
import MetricInfo from '../components/MetricInfo';
import { Icon, type IconName } from '../components/Icon';
import FlowDiagram from '../components/arch/FlowDiagram';
import NodePanel from '../components/arch/NodePanel';
import { NODES, ago, deriveLive, finished, job, runSeconds, type Flow } from '../components/arch/model';
import '../styles/platform.css';

const FLOWS: { f: Flow; label: string }[] = [
  { f: 'ingest', label: 'Public data in' }, { f: 'curated', label: 'Curated data' }, { f: 'api', label: 'API requests' },
  { f: 'metrics', label: 'Metrics & logs' }, { f: 'ai', label: 'Analyst' }, { f: 'plan', label: 'Planned' },
];
const TARGETS = [
  { value: 'ingest', label: 'Lambda · ingest' }, { value: 'api', label: 'Lambda · API' }, { value: 's3', label: 'S3 data lake' }, { value: 'ec2', label: 'EC2 batch worker' },
] as const;
type Target = (typeof TARGETS)[number]['value'];
type Mode = { kind: 'sim' | 'replay'; phase: 'down' | 'draining' } | null;

const GUARDS: { icon: IconName; t: string; d: string }[] = [
  { icon: 'warning', t: 'Alarms', d: 'API errors, ingest errors, DLQ depth, idle worker' },
  { icon: 'gauge', t: 'Throttle', d: '20 req/s, burst 40; ETag + 300 s cache' },
  { icon: 'ask', t: 'Ask limits', d: '10/min per client + daily cap → 429' },
  { icon: 'ec2', t: 'Self-stopping EC2', d: 'one job, then shutdown; idle alarm backstop' },
  { icon: 'lambda', t: 'Concurrency', d: 'account cap of 10 Lambda executions' },
  { icon: 'iam', t: 'Budget', d: 'US$40/month AWS Budget outside the stack' },
];

export default function Platform() {
  const st = useApi<PlatformStatus>('/platform/status');
  const d = st.data;
  const live = useMemo(() => deriveLive(d), [d]);
  const [motion, setMotion] = useState(() => !reducedMotion());
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setMotion(!mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // The open component is part of the URL (?node=api), so a link can point a colleague at one stage.
  const [params, setParams] = useSearchParams();
  const nodeParam = params.get('node');
  const selected = nodeParam && NODES.some((n) => n.id === nodeParam) ? nodeParam : null;
  const setSelected = useCallback((u: string | null | ((s: string | null) => string | null)) => {
    setParams((p) => {
      const cur = p.get('node');
      const next = typeof u === 'function' ? u(cur) : u;
      const q = new URLSearchParams(p);
      if (next) q.set('node', next); else q.delete('node');
      return q;
    }, { replace: true });
  }, [setParams]);
  const [selFrom, setSelFrom] = useState<'diagram' | 'list'>('diagram');
  const lastNode = useRef<string | null>(null);
  const select = useCallback((id: string) => { lastNode.current = id; setSelFrom('diagram'); setSelected((s) => (s === id ? null : id)); }, [setSelected]);
  const selectFromList = (id: string) => { lastNode.current = null; setSelFrom('list'); setSelected((s) => (s === id ? null : id)); };
  const close = useCallback(() => {
    setSelected(null);
    const id = lastNode.current;
    if (id) requestAnimationFrame(() => document.querySelector<SVGGElement>(`.ar-svg [data-node="${id}"]`)?.focus());
  }, [setSelected]);

  // Outage replay (real event from the run records) and the labelled local simulation share one mechanism.
  const [target, setTarget] = useState<Target>('ingest');
  const [down, setDown] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [backlog, setBacklog] = useState(0);
  const timers = useRef<number[]>([]);
  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  useEffect(() => clearTimers, []);
  useEffect(() => {
    if (mode?.phase === 'draining' && (backlog === 0 || !motion)) {
      const t = window.setTimeout(() => setMode(null), motion ? 1200 : 2500);
      return () => clearTimeout(t);
    }
  }, [mode, backlog, motion]);
  const simOn = mode?.kind === 'sim' && mode.phase === 'down';
  const toggleSim = () => {
    clearTimers();
    if (simOn) { setDown(null); setMode({ kind: 'sim', phase: 'draining' }); }
    else { setDown(target); setMode({ kind: 'sim', phase: 'down' }); }
  };
  const rec = live.recovery;
  const replay = () => {
    if (!rec) return;
    clearTimers();
    setDown(rec.node); setMode({ kind: 'replay', phase: 'down' });
    timers.current.push(window.setTimeout(() => { setDown(null); setMode({ kind: 'replay', phase: 'draining' }); }, 6000));
  };
  const loadedAt = useMemo(() => (d ? new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : ''), [d]);
  const hhmm = (iso: string) => iso.replace(/.*T(\d{2}:\d{2}).*/, '$1');

  const headRef = useReveal<HTMLDivElement>(), lowerRef = useReveal<HTMLDivElement>();
  const runs = d?.runs ?? [];
  const sources = d?.manifest?.sources ?? [];
  const r = live.readouts;

  return (
    <div className="page platform">
      <div ref={headRef}>
        <PageHeader
          icon="platform"
          title="Platform"
          lede="AWS pipeline that refreshes the crash, AADT and trajectory data on this portal, plus the planned roadside-LiDAR pilot lane."
          source={d ? <>Live from <span className="measure">/api/v1/platform/status</span>{d.on_aws ? ' · CloudWatch + S3 run records' : ' · local mode'}</> : 'Reading platform status…'}
          readouts={[
            { label: 'Stages up', value: d ? r.up : null, unit: `/ ${r.of}`, tone: live.verdict.s === 'down' ? 'alert' : 'accent' },
            { label: 'Last ingest', value: r.lastIngestH, unit: 'h ago', digits: r.lastIngestH != null && r.lastIngestH < 10 ? 1 : 0 },
            { label: 'API p95', value: r.p95, unit: 'ms' },
            { label: <>Monthly est.</>, value: d ? live.cost.total : null, unit: 'US$', digits: 2 },
          ]}
          actions={<span className="status" data-s={live.verdict.s}><Icon name={live.verdict.s === 'down' ? 'fail' : live.verdict.s === 'ok' ? 'ok' : 'info'} size={15} weight="fill" />{live.verdict.text}</span>}
        />
      </div>

      {live.local && (
        <p className="pf-local" role="status"><Icon name="info" size={16} />Local mode: CloudWatch metrics and S3 run history are AWS-only. Lambda rates, run table and recovery replay appear on the deployed portal.</p>
      )}
      {st.error && <div className="error-box">Platform status unavailable: {st.error}</div>}
      {d?.errors.length ? <div className="error-box">{d.errors.join('; ')}</div> : null}

      <section className="section ar" aria-labelledby="ar-h">
        <div className="ar-head">
          <div>
            <h2 id="ar-h">Architecture</h2>
            <p className="ar-why">Moving dots scale with volume per link (runs, records, requests; log scale). Select a component for its metrics.</p>
          </div>
          <div className="ar-ctl">
            {rec && (
              <button type="button" className="btn ghost" onClick={replay} disabled={mode?.kind === 'replay'}>
                <Icon name="reset" size={16} />Replay recovery
              </button>
            )}
            <Select<Target> compact label="Outage at" icon="offline" value={target} options={[...TARGETS]} onChange={(v) => { setTarget(v); if (simOn) setDown(v); }} />
            <button type="button" className={`btn ${simOn ? '' : 'ghost'} ar-simbtn`} aria-pressed={simOn} onClick={toggleSim}>
              <Icon name={simOn ? 'play' : 'warning'} size={16} />{simOn ? 'Restore service' : 'Simulate outage'}
            </button>
          </div>
        </div>

        <ul className="ar-legend" aria-label="Flow colours">
          {FLOWS.map((x) => <li key={x.f} data-flow={x.f}><i />{x.label}</li>)}
          <li className="ar-lg-state"><span className="ar-sw" data-s="down" />Down</li>
          <li className="ar-lg-state"><span className="ar-sw" data-s="idle" />Idle</li>
        </ul>

        <div className="ar-banner" role="status" aria-live="polite" data-kind={mode?.kind ?? 'live'}>
          {!mode && (
            <><b>Live</b><span>{d ? <>Read at <span className="measure">{loadedAt}</span> local time. Bedrock and CloudFront: defined in CDK, awaiting AWS account verification. Pilot lane: planned, not deployed.</> : 'Reading platform status…'}</span></>
          )}
          {mode?.kind === 'sim' && (
            <><b>Simulation</b><span>{mode.phase === 'down'
              ? `${NODES.find((n) => n.id === down)?.title} down in this browser only; upstream items queue.${motion ? '' : ' Queues are not animated with reduced motion.'}`
              : `Service restored; backlog drains at an accelerated rate${motion && backlog ? ` (${backlog} left)` : ''}.`} Live AWS state is unchanged.</span></>
          )}
          {mode?.kind === 'replay' && rec && (
            <><b>Replay</b><span>Recorded event: the {rec.job} job failed at {hhmm(finished(rec.failed))} UTC (run <span className="measure">{rec.failed.detail?.run_id}</span>) and succeeded {rec.minutes} min later (run <span className="measure">{rec.recovered.detail?.run_id}</span>). Compressed to 6 s.{mode.phase === 'draining' ? ' Backlog draining.' : ''}</span></>
          )}
        </div>

        <div className="ar-fig" data-panel={selected ? '' : undefined}>
          <div className="ar-scroll" tabIndex={-1}>
            <FlowDiagram live={live} down={down} downLabel={mode?.kind === 'replay' ? 'Failed · queueing' : 'Down (sim) · queueing'} selected={selected} onSelect={select} motion={motion} onBacklog={setBacklog} />
          </div>
          <p className="ar-pan"><Icon name="arrow" size={14} />Scroll sideways for the full diagram<span className="ar-pan-m">, or use the list below</span>.</p>
          {selected && selFrom === 'diagram' && <NodePanel key={selected} id={selected} live={live} data={d} simulated={down === selected} onClose={close} />}
        </div>

        <div className="ar-list">
          {(['live', 'pilot'] as const).map((lane) => (
            <div key={lane} className="ar-lgroup">
              <p className="ar-lh">{lane === 'live' ? 'Deployed' : 'Pilot, planned'}</p>
              <ul>
                {NODES.filter((n) => n.lane === lane).map((n) => {
                  const s = live.nodes[n.id];
                  const state = down === n.id ? 'down' : s?.state;
                  return (
                    <li key={n.id}>
                      <button type="button" data-state={state} data-flow={n.flow} aria-pressed={selected === n.id} onClick={() => selectFromList(n.id)}>
                        <span className="ar-li-ico"><Icon name={n.icon} size={18} weight="duotone" /></span>
                        <span className="ar-li-t"><b>{n.title}</b><small>{s?.sub ?? n.service}</small></span>
                        <span className="ar-li-c measure">{s?.chip}</span>
                      </button>
                      {selected === n.id && selFrom === 'list' && <NodePanel id={n.id} live={live} data={d} simulated={down === n.id} onClose={() => setSelected(null)} />}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <div className="pf-lower" ref={lowerRef}>
        <section className="section pf-wide" aria-labelledby="pf-runs" data-r="1">
          <h2 id="pf-runs">Pipeline runs</h2>
          <p className="pf-why">One S3 run record per job, failures included.</p>
          {st.loading && <div className="skeleton pf-skel" />}
          {d && runs.length === 0 && <p className="pf-empty"><Icon name="info" size={16} />No run records in local mode.</p>}
          {runs.length > 0 && (
            <div className="pf-scroll" data-ui>
              <table className="data">
                <thead><tr><th>Run</th><th>Job</th><th>Status</th><th>Finished (UTC)</th><th className="r">Wall time</th></tr></thead>
                <tbody>
                  {runs.map((x) => {
                    const s = x.detail?.status as string | undefined, secs = runSeconds(x);
                    return (
                      <tr key={x.key}>
                        <td className="measure">{x.detail?.run_id ?? x.key.split('/').pop()}</td>
                        <td><span className="pf-job"><Icon name={job(x) === 'trajectories' ? 'ec2' : 'lambda'} size={15} />{job(x) === 'trajectories' ? 'EC2 trajectories' : 'Lambda ingest'}</span></td>
                        <td><span className="status" data-s={s === 'failed' ? 'down' : s === 'succeeded' ? 'ok' : 'idle'}><Icon name="dot" size={8} weight="fill" />{s ?? '—'}</span></td>
                        <td className="measure">{finished(x).replace('T', ' ').slice(0, 16)}</td>
                        <td className="r measure">{secs != null ? `${nf(secs, secs < 60 ? 1 : 0)} s` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="section" aria-labelledby="pf-fresh" data-r="2">
          <h2 id="pf-fresh">Data freshness</h2>
          <p className="pf-why">Records per source in the curated manifest; licence on hover.</p>
          {sources.length > 0 && (
            <div className="pf-scroll" data-ui>
              <table className="data">
                <thead><tr><th>Source</th><th className="r">Records</th><th className="r">Fetched</th></tr></thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={s.id}>
                      <td><span className="pf-srcid" title={s.licence}>{s.id}</span></td>
                      <td className="r measure">{nf(s.records)}</td>
                      <td className="r measure">{ago(s.fetched_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="section pf-costsec" aria-labelledby="pf-cost" data-r="3">
          <div className="pf-costhead">
            <h2 id="pf-cost">Monthly cost estimate</h2>
            <MetricInfo align="right" spec={{
              name: 'Monthly cost estimate', provenance: 'derived', unit: 'US$ / 30 days',
              formula: <>Σ (metered usage × list price), scaled from the {d?.metrics?.window_days ?? 7}-day CloudWatch window to 30 days</>,
              source: 'CloudWatch Lambda invocations and p95 duration; S3 run records for EC2 job time; AWS list prices, us-east-2',
              note: 'Upper bound for Lambda (p95 duration for every call). Excludes S3 storage (< 1 GB), data transfer, and free-tier and credit offsets.',
            }} />
          </div>
          <p className="pf-total"><span className="measure">US$ {live.cost.total.toFixed(2)}</span><small>per month at current traffic · budget alarm at US$40</small></p>
          <ul className="pf-costs">
            {live.cost.lines.map((l) => (
              <li key={l.item}><span>{l.item}</span><small>{l.basis}</small><span className="measure">{l.usd < 0.01 && l.usd > 0 ? '< 0.01' : l.usd.toFixed(2)}</span></li>
            ))}
          </ul>
          {!live.cost.metered && <p className="pf-empty"><Icon name="info" size={16} />Lambda and API lines need CloudWatch; local mode shows fixed costs only.</p>}
        </section>

        <section className="section" aria-labelledby="pf-guard" data-r="4">
          <h2 id="pf-guard">Guardrails</h2>
          <ul className="pf-guards">
            {GUARDS.map((g) => <li key={g.t}><Icon name={g.icon} size={20} weight="duotone" /><b>{g.t}</b><span>{g.d}</span></li>)}
          </ul>
        </section>
      </div>
    </div>
  );
}
