import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import MapView, { type MapLayer } from '../MapView';
import { Icon } from '../Icon';
import MetricInfo, { type MetricSpec } from '../MetricInfo';
import { useApi } from '../../lib/api';
import { useReveal } from '../../lib/motion';
import { EB_STOPS, nf } from '../../lib/format';
import type { FC } from '../../lib/types';
import { useDocTheme } from './useDocTheme';
import { countyQuery, regionLabel, useCounties, useCounty, withCounty } from '../../lib/region';
import type { Seg } from './types';

type MKey = 'eb_excess' | 'crit_ratio' | 'rate_100mvmt';
const MEASURES: { id: MKey; label: string; unit: string; d: number; spec: MetricSpec }[] = [
  { id: 'eb_excess', label: 'EB excess', unit: '/yr', d: 2, spec: { name: 'Excess expected crashes (EB)', formula: <>E − μ, with E = w·μ + (1 − w)·N</>, threshold: 'flagged when E − μ > 0; confirmed when also R/Rc > 1', unit: 'crashes / yr', provenance: 'derived', source: 'TxDOT CRIS 2021–2023 · TxDOT AADT · Roadway Inventory', citation: 'AASHTO Highway Safety Manual (2010), Part B, ch. 4' } },
  { id: 'crit_ratio', label: 'Critical ratio', unit: '', d: 2, spec: { name: 'Critical rate ratio', formula: <>observed rate / critical rate (95%)</>, threshold: '> 1 flags the segment', provenance: 'derived', source: 'TxDOT CRIS 2021–2023 · TxDOT AADT', citation: 'AASHTO Highway Safety Manual (2010), Part B, ch. 4' } },
  { id: 'rate_100mvmt', label: 'Crash rate', unit: '/100 MVMT', d: 1, spec: { name: 'Crash rate', formula: <>N × 10⁸ / (365 · Y · AADT · L)</>, unit: 'crashes per 100 million vehicle-miles', provenance: 'derived', source: 'TxDOT CRIS 2021–2023 · TxDOT AADT', note: 'Biased toward low-volume segments; read with EB excess.' } },
];

/** The county network, ranked: switch the screening measure and the map and its top five re-rank together. */
export default function NetworkRank() {
  const ref = useReveal<HTMLElement>();
  const theme = useDocTheme();
  const nav = useNavigate();
  const [county] = useCounty();
  const counties = useCounties();
  const scope = regionLabel(county, counties.list);
  const net = useApi<FC<Seg>>(`/network${countyQuery(county, true)}`);
  const [mk, setMk] = useState<MKey>('eb_excess');
  const [hover, setHover] = useState<string | null>(null);
  const M = MEASURES.find((m) => m.id === mk)!;

  const feats = net.data?.features ?? [];
  // Screened = segments with a Roadway Inventory / AADT match (an SPF and exposure); the rest draw grey and are not ranked.
  const screened = feats.filter((f) => f.properties.eb_excess != null);
  const miles = screened.reduce((s, f) => s + (f.properties.len_mi ?? 0), 0);
  const unmatched = feats.length - screened.length;
  const top = useMemo(() => [...feats].filter((f) => f.properties[mk] != null).sort((a, b) => (b.properties[mk] ?? 0) - (a.properties[mk] ?? 0)).slice(0, 5).map((f) => f.properties), [feats, mk]);

  const bounds = useMemo<[[number, number], [number, number]] | undefined>(() => {
    if (!feats.length) return undefined;
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const f of feats) for (const p of (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates) as number[][]) {
      a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1]);
    }
    return [[a, b], [c, d]];
  }, [feats]);

  const sources = useMemo<MapLayer[]>(() => {
    if (!net.data) return [];
    // below-zero segments recede but still read as the network on either basemap
    const base = theme === 'light' ? ['#b4b4ac', '#9c9c94'] : ['#5e605b', '#73756f'];
    const eb = EB_STOPS.map(([v, c], i) => [v, i < 2 ? base[i] : c]).flat();
    const [lo, mid, hi, top] = [base[1], EB_STOPS[2][1], EB_STOPS[4][1], EB_STOPS[5][1]];
    const color: any = mk === 'eb_excess'
      ? ['interpolate', ['linear'], ['coalesce', ['get', 'eb_excess'], -1], ...eb]
      : mk === 'crit_ratio'
        ? ['interpolate', ['linear'], ['coalesce', ['get', 'crit_ratio'], 0], 0, lo, 0.8, mid, 1.2, hi, 2, top]
        : ['interpolate', ['linear'], ['coalesce', ['get', 'rate_100mvmt'], 0], 0, lo, 5, mid, 15, hi, 40, top];
    return [{
      id: 'net', data: net.data as any,
      layers: [
        { id: 'net-line', type: 'line', paint: { 'line-color': color, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, ['case', ['>', ['coalesce', ['get', 'eb_excess'], 0], 0], 5, 2.5], 13, ['case', ['>', ['coalesce', ['get', 'eb_excess'], 0], 0], 12, 6]] }, layout: { 'line-cap': 'round' } } as any,
        { id: 'net-hl', type: 'line', filter: ['==', ['get', 'seg_id'], '__none__'], paint: { 'line-color': theme === 'light' ? '#161716' : '#f1f1ef', 'line-width': 10, 'line-opacity': 0.4 } } as any,
      ],
    }];
  }, [net.data, mk, theme]);

  return (
    <section ref={ref} className="nr" aria-labelledby="nr-h">
      <div className="nr-side">
        <h2 id="nr-h" data-r="1">Ranked network</h2>
        {miles > 0 && <span className="nr-meta measure" data-r="1">{scope} · {nf(screened.length)} segments · {nf(miles)} mi</span>}
        <div className="nr-ctl" data-r="3">
          <div className="nr-switch" role="group" aria-label="Screening measure" data-ui>
            {MEASURES.map((m) => <button key={m.id} type="button" aria-pressed={mk === m.id} onClick={() => setMk(m.id)}>{m.label}</button>)}
          </div>
          <MetricInfo spec={{ ...M.spec, note: [M.spec.note, unmatched > 0 ? `${nf(unmatched)} more segments lack a Roadway Inventory / AADT match and are drawn unranked in grey.` : null].filter(Boolean).join(' ') || undefined }} align="right" />
        </div>
        <ol className="nr-list" data-r="4" aria-label={`Top five segments by ${M.label}`}>
          {top.length ? top.map((s, i) => (
            <li key={s.seg_id} data-on={hover === s.seg_id || undefined}>
              <Link to={withCounty(`/screening?seg=${encodeURIComponent(s.seg_id)}`, county)} onMouseEnter={() => setHover(s.seg_id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(s.seg_id)} onBlur={() => setHover(null)}>
                <span className="nr-rank num">{i + 1}</span>
                <span className="nr-name"><b>{s.name}</b><small className="measure">{!county && s.county ? `${s.county} · ` : ''}DFO {nf(s.dfo_from, 1)} · {nf(s.aadt)} veh/d</small></span>
                <span className="nr-val measure">{nf(s[mk] as number, M.d)}<small>{M.unit}</small></span>
              </Link>
            </li>
          )) : Array.from({ length: 5 }, (_, i) => <li key={i}><span className="skeleton" style={{ height: 44, display: 'block' }} /></li>)}
        </ol>
      </div>
      <div className="nr-map" data-ui>
        <MapView key={theme}
          label={`${scope} state-system segments coloured by ${M.label}`}
          sources={sources} bounds={bounds}
          interactiveLayers={['net-line']}
          highlight={{ source: 'net', key: 'seg_id', value: hover }}
          onHover={(f) => setHover((f?.properties as Seg | undefined)?.seg_id ?? null)}
          onClick={(_, f) => nav(withCounty(`/screening?seg=${encodeURIComponent((f.properties as Seg).seg_id)}`, county))}
        />
        <Link to={withCounty('/screening', county)} className="nr-open">Open network screening <Icon name="arrow" size={16} /></Link>
      </div>
    </section>
  );
}
