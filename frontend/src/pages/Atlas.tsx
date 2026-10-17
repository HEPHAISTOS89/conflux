import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import MapView, { type MapLayer } from '../components/MapView';
import TimeSpace from '../components/TimeSpace';
import { Icon } from '../components/Icon';
import { useApi } from '../lib/api';
import { useReveal, useTween } from '../lib/motion';
import { ClockCtx, useClockState, type ConflictT, type IntersectionT } from '../lib/traj';
import { nf } from '../lib/format';
import type { FC, SegmentProps } from '../lib/types';
import '../styles/atlas.css';

type Seg = SegmentProps & { fc_group?: string; crashes_per_yr?: number; dfo_from?: number; dfo_to?: number; speed_all?: number; site_type?: string };
interface Ssm { sensitivity: { ttc: Record<string, Record<string, number>> }; scatter: [number, number, string, string | null][] }
interface CorridorCard { id: string; name: string }

const TTC_STEPS = ['0.5', '1.0', '1.5', '2.0', '3.0'] as const;
const METRICS = [
  { id: 'eb_excess', label: 'EB excess' },
  { id: 'crit_ratio', label: 'Critical ratio' },
  { id: 'rate', label: 'Rate' },
] as const;
const PLACES = [
  { src: '/photos/interstate-27-and-marsha-sharp.webp', w: 1600, h: 619, cap: 'I-27 at Marsha Sharp Freeway, Lubbock', credit: 'Fredlyfish4, CC BY-SA 3.0' },
  { src: '/photos/marsha-sharp-freeway-lubbock-tx-img-0231.webp', w: 1600, h: 1200, cap: 'Marsha Sharp Freeway, US 62/82', credit: 'Billy Hathorn, CC BY-SA 3.0' },
  { src: '/photos/lankershim-boulevard-los-angeles-16343272011.webp', w: 1600, h: 1068, cap: 'Lankershim Blvd, NGSIM site', credit: 'Matthew Nelson, CC BY 2.0' },
  { src: '/photos/peachtree-street-in-midtown-atlanta.webp', w: 1600, h: 1077, cap: 'Peachtree St, NGSIM site', credit: 'Sinan, CC BY 2.0' },
];

export default function Atlas() {
  return (
    <div className="atlas">
      <Hero />
      <ThresholdField />
      <NetworkField />
      <SegmentPlate />
      <Places />
      <Close />
    </div>
  );
}

function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-h">
      <div className="hero-copy">
        <h1 id="hero-h" className="hero-h">
          <span className="mask-line"><span>Read the road</span></span>
          <span className="mask-line"><span>before the crash.</span></span>
        </h1>
        <p className="hero-lede after-mask">HSM network screening and surrogate safety measures for Lubbock County, on real data.</p>
        <div className="hero-act after-mask">
          <Link to="/intersections/peachtree-10th" className="btn">Open the intersection lab <Icon name="arrow" size={16} /></Link>
          <Link to="/screening">Screen the network</Link>
        </div>
      </div>
      <figure className="hero-photo">
        <img src="/photos/marsha-sharp-freeway-light-trails.webp" width={1600} height={1067} alt="Long exposure of night traffic on the Marsha Sharp Freeway in Lubbock, headlights drawn as trails." fetchPriority="high" />
        <figcaption>Marsha Sharp Freeway at FM 2255. Every trail is a trajectory.</figcaption>
      </figure>
    </section>
  );
}

function ThresholdField() {
  const ref = useReveal<HTMLElement>();
  const ix = useApi<IntersectionT>('/intersections/peachtree-10th');
  const cf = useApi<ConflictT[]>('/intersections/peachtree-10th/conflicts');
  const ssm = useApi<Ssm>('/intersections/peachtree-10th/ssm');
  const [step, setStep] = useState<(typeof TTC_STEPS)[number]>('1.5');
  const T = Number(step);
  const count = useMemo(() => {
    const s = ssm.data;
    if (!s) return 0;
    if (s.sensitivity.ttc[step]) return s.sensitivity.ttc[step].rear_end ?? 0;
    return s.scatter.filter(([ttc, , type]) => type === 'rear_end' && ttc <= T).length;
  }, [ssm.data, step, T]);
  const shown = useTween(count);
  const visible = useMemo(() => (cf.data ?? []).filter((c) => c.type === 'crossing' || (c.ttc_min ?? 99) <= T), [cf.data, T]);
  const clock = useClockState(ix.data?.window_s ?? 90);
  useEffect(() => { if (ix.data) clock.setT(ix.data.window_s); /* eslint-disable-next-line */ }, [ix.data]);

  return (
    <section ref={ref} className="field field-control" aria-labelledby="ttc-h">
      <div className="fc-copy">
        <h2 id="ttc-h" data-r="1"><span className="num">{Math.round(shown)}</span> rear-end conflicts in 90 seconds</h2>
        <p data-r="2">Peachtree St at 10th St. SSAM detects at 1.5 s.</p>
      </div>
      <div className="ttc-control" role="radiogroup" aria-label="Time-to-collision threshold" data-ui data-r="3">
        <span className="ttc-label">TTC ≤</span>
        {TTC_STEPS.map((s) => (
          <button key={s} type="button" role="radio" aria-checked={step === s} onClick={() => setStep(s)}>{s}<small>s</small></button>
        ))}
      </div>
      <div className="fc-ts" data-ui data-r="4">
        {ix.data && cf.data ? (
          <ClockCtx.Provider value={clock}>
            <TimeSpace data={ix.data} conflicts={visible} label="Time–space diagram of Peachtree St trajectories with conflicts at the chosen threshold" compact />
          </ClockCtx.Provider>
        ) : <div className="skeleton" style={{ height: 300 }} />}
      </div>
    </section>
  );
}

function NetworkField() {
  const ref = useReveal<HTMLElement>();
  const net = useApi<FC<Seg>>('/network');
  const nav = useNavigate();
  const [metric, setMetric] = useState<(typeof METRICS)[number]['id']>('eb_excess');
  const [hover, setHover] = useState<Seg | null>(null);
  const flagged = (net.data?.features ?? []).filter((f) => (f.properties.eb_excess ?? 0) > 0.25).length;

  const sources = useMemo<MapLayer[]>(() => {
    if (!net.data) return [];
    const color: any = metric === 'eb_excess'
      ? ['interpolate', ['linear'], ['coalesce', ['get', 'eb_excess'], -1], -0.3, '#5d5f5b', 0, '#6d6f6a', 0.1, '#e9c46a', 0.4, '#f08159', 0.8, '#ff5a4f', 1.5, '#ff3b5c']
      : metric === 'crit_ratio'
        ? ['interpolate', ['linear'], ['coalesce', ['get', 'crit_ratio'], 0], 0, '#5d5f5b', 0.8, '#e9a35f', 1.2, '#f08159', 2, '#ff5a4f']
        : ['interpolate', ['linear'], ['coalesce', ['get', 'rate_100mvmt'], 0], 0, '#5d5f5b', 5, '#e9a35f', 15, '#f08159', 40, '#ff5a4f'];
    return [{
      id: 'net', data: net.data as any,
      layers: [
        { id: 'net-line', type: 'line', paint: { 'line-color': color, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3, 13, 8] }, layout: { 'line-cap': 'round' } } as any,
        { id: 'net-hl', type: 'line', filter: ['==', ['get', 'seg_id'], '__none__'], paint: { 'line-color': '#f1f1ef', 'line-width': 9, 'line-opacity': 0.35 } } as any,
      ],
    }];
  }, [net.data, metric]);

  return (
    <section ref={ref} className="field field-map" aria-labelledby="net-h">
      <div className="fm-copy">
        <h2 id="net-h" data-r="1">443 miles, ranked</h2>
        <p data-r="2"><span className="num">{nf(flagged)}</span> segments exceed their predicted ped/bike crashes by over 0.25 a year.</p>
        <div className="seg" role="group" aria-label="Screening measure" data-r="3">
          {METRICS.map((m) => <button key={m.id} type="button" aria-pressed={metric === m.id} onClick={() => setMetric(m.id)}>{m.label}</button>)}
        </div>
        <dl className="fm-read" aria-live="polite" data-r="4">
          {hover ? (<>
            <dt>{hover.name}</dt><dd className="num">DFO {nf(hover.dfo_from, 1)}</dd>
            <dt>AADT</dt><dd className="num">{nf(hover.aadt)}</dd>
            <dt>EB excess</dt><dd className="num">{nf(hover.eb_excess, 2)} /yr</dd>
            <dt>Critical ratio</dt><dd className="num">{nf(hover.crit_ratio, 2)}</dd>
          </>) : <><dt>Hover a segment</dt><dd /></>}
        </dl>
      </div>
      <div className="fm-map">
        <MapView
          label="Lubbock County state-system segments coloured by the selected screening measure"
          sources={sources}
          interactiveLayers={['net-line']}
          highlight={{ source: 'net', key: 'seg_id', value: hover?.seg_id ?? null }}
          onHover={(f) => setHover((f?.properties as Seg) ?? null)}
          onClick={(_, f) => nav(`/screening?seg=${encodeURIComponent((f.properties as any).seg_id)}`)}
        />
      </div>
    </section>
  );
}

const NOTES: { key: string; name: string; text: string }[] = [
  { key: 'aadt', name: 'Exposure', text: 'TxDOT AADT joined on route and DFO.' },
  { key: 'speed', name: 'Speed', text: 'Posted limit against 2024 operating speed.' },
  { key: 'obs', name: 'Observed', text: 'CRIS ped/bike crashes, 2021–2023.' },
  { key: 'spf', name: 'Predicted', text: 'Site-type negative binomial SPF.' },
  { key: 'eb', name: 'Expected', text: 'Empirical Bayes, w = 1 / (1 + k·μ).' },
  { key: 'crit', name: 'Critical ratio', text: 'Observed over 95% critical rate.' },
];

function SegmentPlate() {
  const ref = useReveal<HTMLElement>();
  const top = useApi<{ items: Seg[] }>('/screening?method=eb_excess&limit=1');
  const s = top.data?.items[0];
  const [focus, setFocus] = useState<string | null>(null);
  const row = (key: string, label: string, value: string) => (
    <div className="pl-row" data-on={focus === key ? '' : undefined}><span>{label}</span><b className="num">{value}</b></div>
  );
  return (
    <section ref={ref} className="plate" aria-labelledby="plate-h">
      <h2 id="plate-h" data-r="1">Rank one, read in full</h2>
      <ul className="notes notes-l" data-r="2">
        {NOTES.slice(0, 3).map((n) => <Note key={n.key} n={n} setFocus={setFocus} />)}
      </ul>
      <div className="panel-ui" data-ui data-r="3">
        {s ? (<>
          <div className="pl-head"><b>{s.name}</b><span className="num">DFO {nf(s.dfo_from, 2)}–{nf(s.dfo_to, 2)}</span></div>
          <div className="pl-type">{s.site_type ?? s.fc_group} · {nf(s.lanes)} lanes</div>
          {row('aadt', 'AADT', nf(s.aadt))}
          {row('speed', 'Posted / operating', `${nf(s.speed_limit)} / ${nf(s.speed_all, 1)} mph`)}
          {row('obs', 'Observed', `${nf(s.crashes_per_yr, 2)} /yr`)}
          {row('spf', 'SPF predicted', `${nf(s.spf_pred, 2)} /yr`)}
          {row('eb', 'EB expected', `${nf(s.eb_expected, 2)} /yr`)}
          {row('crit', 'Critical ratio', nf(s.crit_ratio, 2))}
          <div className="pl-total"><span>Excess</span><b className="num">{nf(s.eb_excess, 2)} /yr</b></div>
          <Link to={`/screening?seg=${encodeURIComponent(s.seg_id)}`} className="btn">Open in the screening</Link>
        </>) : <div className="skeleton" style={{ height: 420 }} />}
      </div>
      <ul className="notes notes-r" data-r="4">
        {NOTES.slice(3).map((n) => <Note key={n.key} n={n} setFocus={setFocus} />)}
      </ul>
    </section>
  );
}

function Note({ n, setFocus }: { n: (typeof NOTES)[number]; setFocus: (k: string | null) => void }) {
  return (
    <li tabIndex={0} onMouseEnter={() => setFocus(n.key)} onMouseLeave={() => setFocus(null)} onFocus={() => setFocus(n.key)} onBlur={() => setFocus(null)}>
      <b>{n.name}</b><span>{n.text}</span>
    </li>
  );
}

function Places() {
  const ref = useReveal<HTMLElement>();
  return (
    <section ref={ref} className="places" aria-labelledby="places-h">
      <h2 id="places-h" data-r="1">Where the data comes from</h2>
      <div className="places-grid">
        {PLACES.map((p, i) => (
          <figure key={p.src} data-r={String(Math.min(5, i + 2))}>
            <img src={p.src} width={p.w} height={p.h} alt={p.cap} loading="lazy" />
            <figcaption>{p.cap}</figcaption>
          </figure>
        ))}
      </div>
      <p className="sources" data-r="5">TxDOT Roadway Inventory · TxDOT AADT · TxDOT Statewide Speed · CRIS · NHTSA FARS · FHWA NGSIM</p>
    </section>
  );
}

function Close() {
  const ref = useReveal<HTMLElement>();
  const list = useApi<CorridorCard[]>('/corridors');
  const [id, setId] = useState('us-84');
  const nav = useNavigate();
  return (
    <section ref={ref} className="close" aria-label="Open a corridor">
      <form className="close-line" data-r="1" onSubmit={(e) => { e.preventDefault(); nav(`/corridors/${id}`); }}>
        <span>Diagnose</span>
        <select value={id} onChange={(e) => setId(e.target.value)} aria-label="Corridor">
          {(list.data ?? [{ id: 'us-84', name: 'US 84' }]).map((c) => <option key={c.id} value={c.id}>{c.name.split(' (')[0]}</option>)}
        </select>
        <button type="submit">now</button>
      </form>
      <p className="credits" data-r="2">Photographs, Wikimedia Commons: Marsha Sharp Freeway light trails (Ihavenoidea49, CC0); {PLACES.map((p) => `${p.cap} (${p.credit})`).join('; ')}.</p>
    </section>
  );
}
