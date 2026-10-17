import { useEffect, useRef } from 'react';
import { Icon } from '../Icon';
import type { PlatformStatus } from '../../lib/types';
import { EDGES, NODE, ago, compact, type Live, type NodeState } from './model';
import type { Impact } from './scenario';

const CHIP: Record<NodeState, { s: string; t: string }> = {
  ok: { s: 'ok', t: 'Running' }, idle: { s: 'idle', t: 'Idle' }, warn: { s: 'warn', t: 'Errors' }, down: { s: 'down', t: 'Down' },
  pending: { s: 'warn', t: 'Awaiting AWS' }, planned: { s: 'idle', t: 'Planned' },
};
const FLOW_NAME: Record<string, string> = { ingest: 'Public data', curated: 'Curated data', api: 'API traffic', metrics: 'Metrics & logs', ai: 'Analyst', plan: 'Planned' };

/** Details for one component: role, AWS service, live metrics with their source, configuration, cost. */
export default function NodePanel({ id, live, data, impact, replayDown, onClose }: {
  id: string; live: Live; data?: PlatformStatus; impact?: Impact | null; replayDown?: boolean; onClose: () => void;
}) {
  const n = NODE[id], st = live.nodes[id];
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { head.current?.focus({ preventScroll: true }); }, [id]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  const state: NodeState = replayDown ? 'down' : impact?.state ?? st?.state ?? 'idle';
  const chip = CHIP[state];
  const links = EDGES.filter((e) => e.from === id || e.to === id);
  const sources = (data?.manifest?.sources ?? []).filter((s) => (id === 'ec2' ? s.id.startsWith('ngsim') : id === 'ingest' ? !s.id.startsWith('ngsim') : id === 's3'));

  return (
    <aside className="ar-panel" aria-labelledby="ar-panel-h" data-flow={n.flow}>
      <div className="ar-ph">
        <span className="ar-pico"><Icon name={n.icon} size={20} weight="duotone" /></span>
        <div>
          <h3 id="ar-panel-h" tabIndex={-1} ref={head}>{n.title}</h3>
          <p className="ar-psvc">{n.service}</p>
        </div>
        <button type="button" className="ar-close" onClick={onClose} aria-label="Close details"><Icon name="close" size={16} /></button>
      </div>
      <div className="ar-pchips">
        <span className="status" data-s={chip.s}><Icon name="dot" size={8} weight="fill" />{impact ? (impact.state === 'down' ? 'Down' : impact.state === 'ok' ? 'Restored' : 'Degraded') : replayDown ? 'Failed (replay)' : chip.t}</span>
        <span className="ar-flowtag" data-flow={n.flow}><i />{FLOW_NAME[n.flow]}</span>
      </div>
      {impact && (
        <div className="ar-pimpact" data-s={impact.state}>
          <b>{impact.chip}</b>
          <span>{impact.note}</span>
        </div>
      )}
      <p className="ar-role">{n.role}</p>

      {st && st.metrics.length > 0 && (
        <section>
          <h4>{impact ? 'Live (unchanged by the simulation)' : 'Live'}</h4>
          <dl className="ar-dl">
            {st.metrics.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="measure">{v}</dd></div>)}
          </dl>
          <p className="ar-src"><Icon name="db" size={13} />{st.source}</p>
        </section>
      )}

      {sources.length > 0 && (
        <section>
          <h4>{id === 'ec2' ? 'Trajectory sources' : 'Sources'}</h4>
          <ul className="ar-srcs">
            {sources.map((s) => (
              <li key={s.id}><span>{s.id}</span><span className="measure">{compact(s.records)}</span><span className="ar-age">{ago(s.fetched_at)}</span></li>
            ))}
          </ul>
        </section>
      )}

      {links.length > 0 && (
        <section>
          <h4>Connections</h4>
          <ul className="ar-links">
            {links.map((e) => {
              const other = NODE[e.from === id ? e.to : e.from], ed = live.edges[e.id];
              return (
                <li key={e.id} data-flow={e.flow}>
                  <i />
                  <span>{e.from === id ? '→' : '←'} {other.title}</span>
                  <span className="measure">{e.status === 'live' ? ed?.label.replace('|', ' ').trim() || (ed?.rate ? 'live' : 'idle') : e.status === 'pending' ? 'awaiting AWS' : 'planned'}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section>
        <h4>Configuration</h4>
        <p className="ar-spec">{n.spec}</p>
      </section>
      <section>
        <h4>Cost</h4>
        <p className="ar-spec">{n.cost}</p>
      </section>
    </aside>
  );
}
