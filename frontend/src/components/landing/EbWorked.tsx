import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../Icon';
import MetricInfo, { ProvChip } from '../MetricInfo';
import Term from '../Term';
import { useApi } from '../../lib/api';
import { reducedMotion, useReveal } from '../../lib/motion';
import { nf } from '../../lib/format';
import { useWidth, type Seg } from './types';

interface SpfModel { spec: string[]; coef: Record<string, number>; k: number }
interface SpfDoc { crash_years: number; eb: string; site_types: Record<string, { model?: SpfModel }> }

const COEF_LABEL: Record<string, string> = { ln_aadt: 'ln AADT', speed: 'S', lanes: 'lanes', truck_pct: 'trucks' };

/** The rank-one segment worked through Empirical Bayes, one step per line, with the shrinkage drawn to scale. */
export default function EbWorked() {
  const ref = useReveal<HTMLElement>();
  const top = useApi<{ items: Seg[] }>('/screening?method=eb_excess&limit=1');
  const spf = useApi<SpfDoc>('/spf');
  const s = top.data?.items[0];
  const model = s && spf.data ? spf.data.site_types[s.spf_model ?? s.site_type ?? '']?.model : undefined;
  const Y = spf.data?.crash_years ?? s?.crash_years ?? 3;
  const mu = s?.spf_pred ?? null, N = s?.crashes_per_yr ?? null, E = s?.eb_expected ?? null;
  const L = s?.len_mi ?? 1;
  const w = model && mu != null ? 1 / (1 + (model.k / L) * mu * Y) : mu != null && N != null && E != null && N !== mu ? (N - E) / (N - mu) : null;

  return (
    <section ref={ref} className="eb" aria-labelledby="eb-h">
      <div className="eb-col">
        <h2 id="eb-h" data-r="1">Empirical Bayes estimate, rank 1 segment</h2>
        <p data-r="2">{s ? <>{s.name}, DFO {nf(s.dfo_from, 1)} to {nf(s.dfo_to, 1)}: {(s.site_type ?? '').toLowerCase()}, {nf(s.lanes)} lanes, {nf(s.speed_limit)} mph posted, {nf(s.aadt)} vehicles a day.</> : 'Loading rank 1 segment…'}</p>
      </div>

      <div className="eb-line" data-r="3" data-ui>
        {s && mu != null && N != null && E != null ? <Shrink mu={mu} N={N} E={E} /> : <div className="skeleton" style={{ height: 150 }} />}
      </div>

      <ol className="eb-steps eb-col">
        <li data-r="3">
          <p className="eb-say"><Term k="SPF">SPF</Term> prediction, typical {s?.site_type?.toLowerCase() ?? 'segment'}</p>
          <div className="eb-calc" data-ui>
            <span className="measure">μ = exp({model ? [nf(model.coef.const, 3), ...model.spec.map((k) => `${model.coef[k] < 0 ? '−' : '+'} ${nf(Math.abs(model.coef[k]), 3)}·${COEF_LABEL[k] ?? k}`)].join(' ') : 'b₀ + b₁·ln AADT'}) · L</span>
            <b className="measure">{nf(mu, 2)} crashes / yr</b>
            <small className="eb-where">AADT {nf(s?.aadt)} veh/d · S = {nf(s?.speed_limit)} mph posted · L = {nf(L, 2)} mi · fitted on {s?.site_type?.toLowerCase() ?? 'site-type'} segments</small>
          </div>
        </li>
        <li data-r="4">
          <p className="eb-say">Observed crashes, TxDOT CRIS</p>
          <div className="eb-calc" data-ui>
            <span className="measure">N = {nf(s?.crashes_total)} crashes / {nf(Y)} yr ({s?.crash_period ?? '2021–2023'})</span>
            <b className="measure">{nf(N, 2)} crashes / yr</b>
          </div>
        </li>
        <li data-r="4">
          <p className="eb-say">EB weight from SPF overdispersion k</p>
          <div className="eb-calc" data-ui>
            <span className="measure">w = 1 / (1 + (k/L)·μ·Y) = 1 / (1 + {model ? nf(model.k / L, 3) : 'k/L'} × {nf(mu, 2)} × {nf(Y)})</span>
            <b className="measure">w = {nf(w, 2)}</b>
          </div>
        </li>
        <li data-r="5" className="eb-last">
          <p className="eb-say">EB expected crashes; excess over μ is the potential for safety improvement</p>
          <div className="eb-calc eb-result" data-ui>
            <span className="measure">E = {nf(w, 2)} × {nf(mu, 2)} + {nf(w == null ? null : 1 - w, 2)} × {nf(N, 2)} = {nf(E, 2)}; &nbsp;E − μ</span>
            <b className="measure">{nf(s?.eb_excess, 2)} excess / yr</b>
          </div>
          <div className="eb-meta">
            <ProvChip kind="derived" />
            <MetricInfo spec={{ name: 'Empirical Bayes expected crashes', formula: spf.data?.eb ?? 'E = w·μ + (1−w)·N', unit: 'crashes / yr', provenance: 'derived', threshold: 'flagged when E − μ > 0; confirmed when also R/Rc > 1', source: 'TxDOT CRIS 2021–2023 (on-system ped/bike), TxDOT AADT, Roadway Inventory', citation: 'AASHTO Highway Safety Manual (2010), Part B ch. 4 and Part C appendix', note: `Negative binomial SPF fitted per site type by maximum likelihood; overdispersion per mile, k_seg = k/L.` }} />
            {s && <Link to={`/screening?seg=${encodeURIComponent(s.seg_id)}`}>Open segment <Icon name="arrow" size={16} /></Link>}
          </div>
        </li>
      </ol>
    </section>
  );
}

/** Number line: the SPF prediction, the observed count, and the EB estimate pulled from N toward μ. */
function Shrink({ mu, N, E }: { mu: number; N: number; E: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [go, setGo] = useState(reducedMotion());
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el || go) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setTimeout(() => setGo(true), 450); io.disconnect(); } }, { threshold: 0.6 });
    io.observe(el);
    return () => io.disconnect();
  }, [go]);
  const max = Math.ceil(Math.max(mu, N, E) * 1.15 + 0.2);
  const pad = 28, iw = Math.max(10, w - pad * 2);
  const x = (v: number) => pad + (v / max) * iw;
  const ticks = Array.from({ length: max + 1 }, (_, i) => i);
  const ex = go ? E : N;
  return (
    <div ref={host}>
      <div ref={ref} className="eb-svg">
        {w > 0 && (
          <svg width={w} height={150} role="img" aria-label={`Number line in crashes per year: SPF prediction ${mu}, observed ${N}, Empirical Bayes expected ${E}; excess ${(E - mu).toFixed(2)}.`}>
            <line className="eb-axis" x1={pad} x2={pad + iw} y1={92} y2={92} />
            {ticks.map((t) => <g key={t}><line className="eb-axis" x1={x(t)} x2={x(t)} y1={88} y2={96} /><text className="eb-tick" x={x(t)} y={118} textAnchor="middle">{t}</text></g>)}
            <text className="eb-tick" x={pad + iw} y={142} textAnchor="end">crashes per year</text>
            <rect className="eb-excess" x={x(mu)} y={80} height={24} style={{ width: Math.max(0, x(ex) - x(mu)) }} />
            <g className="eb-mark" style={{ transform: `translateX(${x(mu)}px)` }}><line y1={52} y2={104} /><text y={44} textAnchor="middle">μ {mu.toFixed(2)}</text></g>
            <g className="eb-mark eb-n" style={{ transform: `translateX(${x(N)}px)` }}><line y1={52} y2={104} /><text y={44} textAnchor="middle">N {N.toFixed(2)}</text></g>
            <g className="eb-mark eb-e" style={{ transform: `translateX(${x(ex)}px)` }}><circle cy={92} r={8} /><text y={20} textAnchor="middle">E {E.toFixed(2)}</text></g>
          </svg>
        )}
      </div>
    </div>
  );
}
