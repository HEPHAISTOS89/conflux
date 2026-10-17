import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { nf } from '../lib/format';
import { reducedMotion, useReveal } from '../lib/motion';
import type { PlatformStatus } from '../lib/types';
import PageHeader from '../components/PageHeader';
import Select from '../components/Select';
import MetricInfo from '../components/MetricInfo';
import { Icon, type IconName } from '../components/Icon';
import FlowDiagram from '../components/arch/FlowDiagram';
import NodePanel from '../components/arch/NodePanel';
import IngestControl from '../components/arch/IngestControl';
import { getStatus } from '../components/arch/ingest';
import { NODES, ago, deriveLive, finished, job, runSeconds, type Flow } from '../components/arch/model';
import { SIM_MIN_PER_S, SIM_OFF, TARGETS, scenarioView, simReduce, type Target } from '../components/arch/scenario';
import '../styles/platform.css';

const FLOWS: { f: Flow; label: string }[] = [
  { f: 'ingest', label: 'Public data in' }, { f: 'curated', label: 'Curated data' }, { f: 'api', label: 'API requests' },
  { f: 'metrics', label: 'Metrics & logs' }, { f: 'ai', label: 'Analyst' }, { f: 'plan', label: 'Planned' },
];

/** Platform status, read uncached so the ingest control and Retry always see the server's current state. */
function usePlatformStatus() {
  const [s, setS] = useState<{ data?: PlatformStatus; error?: string; loading: boolean }>({ loading: true });
  const reload = useCallback(async () => {
    const d = await getStatus();
    setS({ data: d, loading: false });
    return d;
  }, []);
  const retry = useCallback(() => {
    setS((x) => ({ ...x, loading: true, error: undefined }));
    reload().catch((e: Error) => setS((x) => ({ ...x, loading: false, error: e.message })));
  }, [reload]);
  useEffect(() => { retry(); }, [retry]);
  return { ...s, reload, retry };
}

const GUARDS: { icon: IconName; t: string; d: string }[] = [
  { icon: 'warning', t: 'Alarms', d: 'API errors, ingest errors, DLQ depth, idle worker' },
  { icon: 'gauge', t: 'Throttle', d: '20 req/s, burst 40; ETag + 300 s cache' },
  { icon: 'ask', t: 'Ask limits', d: '10/min per client + daily cap → 429' },
  { icon: 'ec2', t: 'Self-stopping EC2', d: 'one job, then shutdown; idle alarm backstop' },
  { icon: 'lambda', t: 'Concurrency', d: 'account cap of 10 Lambda executions' },
  { icon: 'iam', t: 'Budget', d: 'US$40/month AWS Budget outside the stack' },
];

export default function Platform() {
  const st = usePlatformStatus();
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
    if (id) requestAnimationFrame(() => document.querySelector<HTMLElement>(`.ar-canvas [data-node="${id}"]`)?.focus());
  }, [setSelected]);

  // Outage simulation (pure reducer in ./scenario, one simulated clock) and replay of a real recorded failure.
  const [target, setTarget] = useState<Target>('ingest');
  const [sim, dispatch] = useReducer(simReduce, SIM_OFF);
  const api = d?.metrics?.functions?.api?.invocations?.total as number | undefined;
  const reqPerMin = d?.on_aws && api != null ? api / ((d.metrics?.window_days ?? 7) * 1440) : null;
  useEffect(() => {
    if (sim.phase === 'off') return;
    const id = window.setInterval(() => dispatch({ type: 'tick', minutes: SIM_MIN_PER_S, reqPerMin: reqPerMin ?? 0 }), sim.phase === 'down' ? 1000 : 450);
    return () => clearInterval(id);
  }, [sim.phase, reqPerMin]);
  const view = useMemo(() => scenarioView(sim, live, reqPerMin), [sim, live, reqPerMin]);

  const rec = live.recovery;
  const [replay, setReplay] = useState<'down' | 'draining' | null>(null);
  const timers = useRef<number[]>([]);
  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  useEffect(() => clearTimers, []);
  const startReplay = () => {
    if (!rec) return;
    clearTimers();
    dispatch({ type: 'reset' });
    setReplay('down');
    timers.current.push(window.setTimeout(() => setReplay('draining'), 6000));
    timers.current.push(window.setTimeout(() => setReplay(null), 6000 + (motion ? 2600 : 2500)));
  };
  const startSim = (t: Target) => { clearTimers(); setReplay(null); dispatch({ type: 'start', target: t }); };
  const simDown = sim.phase === 'down', restoring = sim.phase === 'restoring';
  const toggleSim = () => { if (simDown) dispatch({ type: 'restore' }); else if (!restoring) startSim(target); };
  const changeTarget = (v: Target) => { setTarget(v); if (simDown) startSim(v); };
  const down = replay === 'down' && rec ? rec.node : simDown ? sim.target : null;
  const overrides = view?.impacts;
  const badges = view ? { [view.target]: view.queue.draining ? `draining ${view.queue.value}` : `${view.queue.value} ${view.queue.unit}` } : undefined;
  const simTag = (label: string) => (view ? <>{label}<i className="pf-simtag">Simulation</i></> : label);
  const loadedAt = useMemo(() => (d ? new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : ''), [d]);
  const hhmm = (iso: string) => iso.replace(/.*T(\d{2}:\d{2}).*/, '$1');

  const headRef = useReveal<HTMLDivElement>(), lowerRef = useReveal<HTMLDivElement>();
  const runs = d?.runs ?? [];
  const sources = d?.manifest?.sources ?? [];
  const r = view ? view.readouts : live.readouts;
  const verdict = view
    ? { s: 'warn' as const, text: `Simulation: ${view.title} ${view.phase === 'restoring' ? 'recovering' : 'down'}` }
    : live.verdict;

  return (
    <div className="page platform">
      <div ref={headRef}>
        <PageHeader
          icon="platform"
          title="Platform"
          lede="AWS pipeline that refreshes the crash, AADT and trajectory data on this portal, plus the planned roadside-LiDAR pilot lane."
          source={d ? <>Live from <span className="measure">/api/v1/platform/status</span>{d.on_aws ? ' · CloudWatch + S3 run records' : ' · local mode'}</> : 'Reading platform status…'}
          readouts={[
            { label: simTag('Stages up'), value: d ? r.up : null, unit: `/ ${r.of}`, tone: verdict.s === 'down' || (view && r.up < r.of) ? 'alert' : 'accent' },
            { label: simTag('Last ingest'), value: r.lastIngestH, unit: 'h ago', digits: r.lastIngestH != null && r.lastIngestH < 10 ? 1 : 0 },
            { label: simTag('API p95'), value: r.p95, unit: 'ms' },
            { label: 'Monthly est.', value: d ? live.cost.total : null, unit: 'US$', digits: 2 },
          ]}
          actions={<span className="status" data-s={verdict.s}><Icon name={verdict.s === 'down' ? 'fail' : verdict.s === 'ok' ? 'ok' : view ? 'warning' : 'info'} size={15} weight="fill" />{verdict.text}</span>}
        />
      </div>

      {live.local && (
        <p className="pf-local" role="status"><Icon name="info" size={16} />Local mode: CloudWatch metrics, S3 run history and Run ingest are AWS-only. They work on the deployed portal.</p>
      )}
      {st.error && (
        <div className="error-box pf-err" role="alert"><Icon name="fail" size={16} /><span>Platform status unavailable: {st.error}</span>
          <button type="button" className="btn ghost sm" onClick={st.retry} disabled={st.loading} aria-busy={st.loading || undefined}><Icon name={st.loading ? 'spinner' : 'reset'} size={16} />{st.loading ? 'Retrying…' : 'Retry'}</button>
        </div>
      )}
      {d?.errors.length ? <div className="error-box">{d.errors.join('; ')}</div> : null}

      <IngestControl data={d} refresh={st.reload} />

      <section className="section ar" aria-labelledby="ar-h">
        <div className="ar-head">
          <div>
            <h2 id="ar-h">Architecture</h2>
            <p className="ar-why">Moving dots scale with volume per link (runs, records, requests; log scale). Select a component for its metrics.</p>
          </div>
          <div className="ar-ctl" role="group" aria-label="Outage scenarios">
            {rec && (
              <button type="button" className="btn ghost" onClick={startReplay} disabled={replay !== null} aria-busy={replay !== null || undefined}
                title={`Replays the recorded ${rec.job} failure and recovery from the run history`}>
                <Icon name={replay ? 'spinner' : 'reset'} size={16} />{replay ? 'Replaying…' : 'Replay recovery'}
              </button>
            )}
            <Select<Target> compact label="Outage at" icon="offline" value={target} options={TARGETS} onChange={changeTarget} />
            <button type="button" className={`btn ${simDown ? '' : 'ghost'} ar-simbtn`} aria-pressed={simDown} onClick={toggleSim}
              disabled={restoring} aria-busy={restoring || undefined}>
              <Icon name={restoring ? 'spinner' : simDown ? 'play' : 'warning'} size={16} />{restoring ? 'Restoring…' : simDown ? 'Restore service' : 'Simulate outage'}
            </button>
          </div>
        </div>

        <ul className="ar-legend" aria-label="Flow colours">
          {FLOWS.map((x) => <li key={x.f} data-flow={x.f}><i />{x.label}</li>)}
          <li className="ar-lg-state"><span className="ar-sw" data-s="down" />Down</li>
          <li className="ar-lg-state"><span className="ar-sw" data-s="warn" />Degraded or awaiting AWS</li>
          <li className="ar-lg-state"><span className="ar-sw" data-s="idle" />Idle</li>
        </ul>

        <div className="ar-banner" role="status" aria-live="polite" data-kind={view ? 'sim' : replay ? 'replay' : 'live'}>
          {!view && !replay && (
            <><b>Live</b><span>{d ? <>Read at <span className="measure">{loadedAt}</span> local time. Bedrock and CloudFront: defined in CDK, awaiting AWS account verification. Pilot lane: planned, not deployed.</> : 'Reading platform status…'}</span></>
          )}
          {view && (
            <><b>Simulation</b><span>
              {view.phase === 'down'
                ? <>{view.title} failing in this browser only. Clock <span className="measure">T+{Math.round(view.t)} min</span> (1 s = {SIM_MIN_PER_S} min).</>
                : <>{view.title} restored; draining the backlog, then every figure returns to live.</>}
              {' '}Live AWS state is unchanged.
            </span></>
          )}
          {replay && rec && (
            <><b>Replay</b><span>Recorded event: the {rec.job} job failed at {hhmm(finished(rec.failed))} UTC (run <span className="measure">{rec.failed.detail?.run_id}</span>) and succeeded {rec.minutes} min later (run <span className="measure">{rec.recovered.detail?.run_id}</span>). Compressed to 6 s.{replay === 'draining' ? ' Recovered; queue draining.' : ''}</span></>
          )}
        </div>

        {view && (
          <div className="ar-sim" aria-label="Simulated consequences">
            <div className="ar-sim-q" data-draining={view.queue.draining || undefined}>
              <small>{view.queue.label}</small>
              <span className="measure">{view.queue.value}<small> {view.queue.unit}</small></span>
            </div>
            <div className="ar-sim-alarms">
              <small>CloudWatch alarms</small>
              <ul>
                {view.alarms.map((a) => (
                  <li key={a.name}>
                    <span className="status" data-s={a.state === 'ALARM' ? 'down' : a.state === 'PENDING' ? 'warn' : 'ok'}>
                      <Icon name={a.state === 'ALARM' ? 'warning' : a.state === 'PENDING' ? 'clock' : 'ok'} size={14} weight="fill" />{a.state}
                    </span>
                    <span><span className="measure">{a.name}</span> <small>{a.rule}</small><br /><span className="ar-sim-why">{a.why}</span></span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="ar-sim-cons">
              <small>What follows</small>
              <ul>{view.consequences.map((c) => <li key={c}>{c}</li>)}</ul>
              <button type="button" className="btn text sm" onClick={() => dispatch({ type: 'reset' })}>End simulation now</button>
            </div>
          </div>
        )}

        <div className="ar-fig" data-panel={selected ? '' : undefined}>
          <div className="ar-scroll" role="region" aria-label="Architecture diagram" tabIndex={0}>
            <FlowDiagram live={live} down={down} overrides={replay === 'down' && rec ? { [rec.node]: { state: 'down', chip: 'Failed · queueing (replay)' } } : overrides}
              badges={badges} selected={selected} onSelect={select} motion={motion} />
          </div>
          <p className="ar-pan"><Icon name="arrow" size={14} /><span>Scroll sideways for the full diagram<span className="ar-pan-m">, or use the list below</span>.</span></p>
          {selected && selFrom === 'diagram' && <NodePanel key={selected} id={selected} live={live} data={d} impact={view?.impacts[selected]} replayDown={replay === 'down' && rec?.node === selected} onClose={close} />}
        </div>

        <div className="ar-list">
          {(['live', 'pilot'] as const).map((lane) => (
            <div key={lane} className="ar-lgroup">
              <p className="ar-lh">{lane === 'live' ? 'Deployed' : 'Pilot, planned'}</p>
              <ul>
                {NODES.filter((n) => n.lane === lane).map((n) => {
                  const s = live.nodes[n.id], ov = view?.impacts[n.id];
                  const state = down === n.id ? 'down' : ov?.state ?? s?.state;
                  return (
                    <li key={n.id}>
                      <button type="button" data-state={state} data-flow={n.flow} aria-pressed={selected === n.id} onClick={() => selectFromList(n.id)}>
                        <span className="ar-li-ico"><Icon name={n.icon} size={20} weight="duotone" /></span>
                        <span className="ar-li-t"><b>{n.title}</b><small>{s?.sub ?? n.service}</small></span>
                        <span className="ar-li-c measure">{ov?.chip ?? s?.chip}</span>
                      </button>
                      {selected === n.id && selFrom === 'list' && <NodePanel id={n.id} live={live} data={d} impact={ov} replayDown={replay === 'down' && rec?.node === n.id} onClose={() => setSelected(null)} />}
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
          <p className="pf-why">One S3 run record per job, failures included; the ten most recent.</p>
          {st.loading && !d && <div className="skeleton pf-skel" />}
          {d && runs.length === 0 && <p className="pf-empty"><Icon name="info" size={16} />{d.on_aws ? 'No run records in curated/runs/ yet.' : 'No run records in local mode: run history lives in S3 on the deployed portal.'}</p>}
          {runs.length > 0 && (
            <div className="pf-scroll" data-ui role="region" aria-label="Pipeline runs table" tabIndex={0}>
              <table className="data">
                <thead><tr><th>Run</th><th>Job</th><th>Trigger</th><th>Status</th><th>Finished (UTC)</th><th className="r">Wall time</th><th className="r">Records</th></tr></thead>
                <tbody>
                  {runs.map((x) => {
                    const s = x.detail?.status as string | undefined, secs = runSeconds(x);
                    const fin = x.detail?.finished_at as string | undefined;
                    return (
                      <tr key={x.key}>
                        <td className="measure">{x.detail?.run_id ?? x.key.split('/').pop()}</td>
                        <td><span className="pf-job"><Icon name={job(x) === 'trajectories' ? 'ec2' : 'lambda'} size={16} />{job(x) === 'trajectories' ? 'EC2 trajectories' : 'Lambda ingest'}</span></td>
                        <td>{x.detail?.trigger ?? (job(x) === 'trajectories' ? 'schedule' : '—')}</td>
                        <td><span className="status" data-s={s === 'failed' ? 'down' : s === 'succeeded' ? 'ok' : s === 'running' ? 'warn' : 'idle'}><Icon name={s === 'running' ? 'spinner' : 'dot'} size={s === 'running' ? 14 : 8} weight="fill" />{s ?? '—'}</span></td>
                        <td className="measure">{s === 'running' && !fin ? '—' : finished(x).replace('T', ' ').slice(0, 16)}</td>
                        <td className="r measure">{s === 'running' ? '—' : secs != null ? `${nf(secs, secs < 60 ? 1 : 0)} s` : '—'}</td>
                        <td className="r measure">{typeof x.detail?.records === 'number' ? nf(x.detail.records) : '—'}</td>
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
          <p className="pf-why">Records per source in the curated manifest; licence on hover.{d?.manifest?.generated_at ? <> Manifest written <span className="measure">{String(d.manifest.generated_at).replace('T', ' ').slice(0, 16)}</span> UTC ({ago(d.manifest.generated_at)}).</> : null}</p>
          {sources.length > 0 && (
            <div className="pf-scroll" data-ui role="region" aria-label="Data freshness table" tabIndex={0}>
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
