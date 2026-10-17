import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import MapView, { type MapLayer } from '../components/MapView';
import TimeSpace from '../components/TimeSpace';
import { Icon } from '../components/Icon';
import { useApi } from '../lib/api';
import { ClockCtx, useClockState, type ConflictT, type IntersectionT } from '../lib/traj';
import { EB_STOPS, nf } from '../lib/format';
import type { FC, SegmentProps } from '../lib/types';
import '../styles/atlas.css';

const ebColor: any = ['interpolate', ['linear'], ['coalesce', ['get', 'eb_excess'], -1], ...EB_STOPS.flat()];
// legend ramp: colour stops placed at their EB values so the ticks line up with the map colours
const EB_MIN = EB_STOPS[0][0], EB_MAX = EB_STOPS[EB_STOPS.length - 1][0];
const ebPct = (v: number) => ((v - EB_MIN) / (EB_MAX - EB_MIN)) * 100;
const EB_RAMP = `linear-gradient(90deg, ${EB_STOPS.map(([v, c]) => `${c} ${ebPct(v).toFixed(1)}%`).join(', ')})`;
const EB_TICKS: [number, string][] = [[0, '≤0'], [0.4, '0.4'], [0.8, '0.8'], [1.5, '1.5+']];

export default function Atlas() {
  const net = useApi<FC<SegmentProps>>('/network');
  const fatal = useApi<FC<any>>('/fatal');
  const vru = useApi<{ total: number; by_severity: Record<string, number>; years: number[] }>('/vru/summary');
  const ix = useApi<IntersectionT>('/intersections/peachtree-10th');
  const cf = useApi<ConflictT[]>('/intersections/peachtree-10th/conflicts');
  const [hover, setHover] = useState<SegmentProps | null>(null);
  const [layers, setLayers] = useState({ fatal: true });
  const nav = useNavigate();

  const stats = useMemo(() => {
    const f = net.data?.features ?? [];
    const crashes = f.reduce((s, x) => s + (x.properties.crashes_total ?? 0), 0);
    const flagged = f.filter((x) => (x.properties.eb_excess ?? 0) > 0.25).length;
    const withCrash = f.filter((x) => (x.properties.crashes_total ?? 0) > 0).length;
    const deaths = (fatal.data?.features ?? []).reduce((s, x) => s + (x.properties.fatals ?? 1), 0);
    return { segs: f.length, crashes, flagged, withCrash, deaths };
  }, [net.data, fatal.data]);

  const sources = useMemo<MapLayer[]>(() => {
    const out: MapLayer[] = [];
    if (net.data) out.push({
      id: 'net', data: net.data as any,
      layers: [
        { id: 'net-case', type: 'line', paint: { 'line-color': '#fbfbf9', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 4.5, 13, 10] }, layout: { 'line-cap': 'round' } } as any,
        { id: 'net-line', type: 'line', paint: { 'line-color': ebColor, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2.6, 13, 7] }, layout: { 'line-cap': 'round' } } as any,
        { id: 'net-hl', type: 'line', filter: ['==', ['get', 'seg_id'], '__none__'], paint: { 'line-color': '#14171a', 'line-width': 8, 'line-opacity': 0.25 } } as any,
      ],
    });
    if (fatal.data) out.push({
      id: 'fatal', data: fatal.data as any,
      layers: [{ id: 'fatal-pt', type: 'circle', paint: { 'circle-radius': 2.4, 'circle-color': '#6e120d', 'circle-stroke-color': '#fbfbf9', 'circle-stroke-width': 0.8, 'circle-opacity': layers.fatal ? 0.75 : 0, 'circle-stroke-opacity': layers.fatal ? 1 : 0 } } as any],
    });
    return out;
  }, [net.data, fatal.data, layers.fatal]);

  const clock = useClockState(ix.data?.window_s ?? 90);
  useEffect(() => {
    if (!ix.data || matchMedia('(prefers-reduced-motion: reduce)').matches) { clock.setT(ix.data?.window_s ?? 90); return; }
    clock.setT(0); clock.setRate(4); clock.play();
    // stop after one full pass so the finished diagram stays legible
    const stop = setTimeout(() => { clock.pause(); clock.setRate(1); clock.setT(ix.data!.window_s); }, (ix.data.window_s / 4) * 1000 - 120);
    return () => clearTimeout(stop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ix.data]);

  return (
    <div className="page atlas">
      <header className="page-head atlas-head">
        <h1>Where Lubbock's pedestrian and cyclist crashes concentrate, and what the trajectories say before they happen</h1>
        <p>
          A proactive safety workbench for the TxDOT Lubbock District: HSM Part B screening of every state-system mile in
          Lubbock County for on-system pedestrian, cyclist and e-scooter crashes (TxDOT CRIS, 2021–2023), corridor
          straight-line diagrams, vulnerable-road-user crash patterns, and surrogate safety measures computed from vehicle
          trajectories at signalised intersections. The county map is a ped/bike screening, not an all-crash one.
        </p>
      </header>

      {[net, fatal, vru, ix, cf].some((r) => r.error) && <div className="error-box">Some data could not be loaded: {[net, fatal, vru, ix, cf].map((r) => r.error).filter(Boolean).join(' · ')}</div>}

      <section className="atlas-grid" aria-label="County overview">
        <div className="atlas-map panel">
          <MapView
            label="Lubbock County state-system segments coloured by Empirical Bayes excess expected pedestrian and cyclist crashes per year, 2021–2023"
            sources={sources}
            interactiveLayers={['net-line']}
            highlight={{ source: 'net', key: 'seg_id', value: hover?.seg_id ?? null }}
            onHover={(f) => setHover((f?.properties as SegmentProps) ?? null)}
            onClick={(_, f) => nav(`/screening?seg=${encodeURIComponent((f.properties as any).seg_id)}`)}
          />
          <div className="map-legend">
            <div className="legend-title">Excess expected ped/bike crashes / yr (EB − SPF)</div>
            <div className="legend-ramp" style={{ background: EB_RAMP }} />
            <div className="legend-ticks num" style={{ position: 'relative', height: 14 }} aria-label="Ticks at 0, 0.4, 0.8 and 1.5 or more">
              {EB_TICKS.map(([v, l], i) => (
                <span key={l} style={{ position: 'absolute', left: `${ebPct(v)}%`, transform: i === EB_TICKS.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}>{l}</span>
              ))}
            </div>
            <label className="legend-toggle">
              <input type="checkbox" checked={layers.fatal} onChange={(e) => setLayers({ fatal: e.target.checked })} />
              <span className="dot-k" /> Fatal crashes, FARS 2018–2023
            </label>
          </div>
          <div className="map-readout" aria-live="polite">
            {hover ? (
              <>
                <strong>{hover.name}</strong> <span className="num muted">{hover.seg_id}</span>
                <dl className="readout-grid num">
                  <dt>AADT</dt><dd>{nf(hover.aadt)}</dd>
                  <dt>Ped/bike crashes 2021–23</dt><dd>{nf(hover.crashes_total)}</dd>
                  <dt>Rate /100 MVMT</dt><dd>{nf(hover.rate_100mvmt, 1)}</dd>
                  <dt>EB excess</dt><dd>{nf(hover.eb_excess, 2)}</dd>
                </dl>
              </>
            ) : <span className="muted">Hover a segment for its screening values; click to open it in the ranking.</span>}
          </div>
        </div>

        <div className="atlas-ts panel">
          <div className="ts-head">
            <h2>Peachtree St at 10th St — 90 s, northbound + southbound</h2>
            <p className="muted">Every line is one vehicle. Slope is speed; flat runs are queues at the stop line; diamonds are traffic conflicts (surrogate safety events) detected with FHWA SSAM thresholds.</p>
          </div>
          {ix.data && cf.data ? (
            <ClockCtx.Provider value={clock}>
              <TimeSpace data={ix.data} conflicts={cf.data} label="Time–space diagram, drag to scrub time" reveal />
            </ClockCtx.Provider>
          ) : <div className="skeleton ts-skel" />}
          <Link to="/intersections/peachtree-10th" className="btn ghost ts-cta">Open the intersection lab <Icon name="arrow" size={16} /></Link>
        </div>
      </section>

      <section className="atlas-figures" aria-label="Key figures">
        <Figure v={nf(stats.segs)} u="one-mile segments" d="State-system mileage in Lubbock County screened with HSM Part B methods; 395 have AADT and a site type and enter the SPFs." />
        <Figure v={nf(stats.crashes)} u="on-system ped/bike crashes, 2021–23" d={`TxDOT CRIS pedestrian, cyclist and e-scooter crashes snapped to those segments (all KABCO); ${nf(stats.withCrash)} segments have at least one.`} />
        <Figure v={nf(stats.flagged)} u="segments with EB excess > 0.25 / yr" d="Candidates for detailed ped/bike diagnosis after Empirical Bayes adjustment against site-type SPFs." />
        <Figure v={vru.data ? nf((vru.data.by_severity.K ?? 0) + (vru.data.by_severity.A ?? 0)) : '…'} u={`KA pedestrian & cyclist crashes, ${vru.data?.years.join('–') ?? ''}`} d="Fatal and suspected-serious injuries to vulnerable road users, countywide (on- and off-system)." />
        <Figure v={nf(stats.deaths)} u="deaths, FARS 2018–2023" d="All public roads in Lubbock County (FIPS 48303)." />
      </section>

      <section className="section" aria-labelledby="path">
        <div className="section-head"><h2 id="path">Work through it the way a safety study does</h2></div>
        <ol className="path">
          <PathStep to="/screening" title="Screen the network" body="Rank segments by ped/bike crash frequency, rate, critical-rate ratio and EB excess using locally estimated, site-type-specific negative binomial SPFs (2021–2023)." />
          <PathStep to="/corridors/us-84" title="Diagnose a corridor" body="Read lanes, posted and operating speed, AADT, truck share and ped/bike crash density against DFO on a straight-line diagram." />
          <PathStep to="/vru" title="Look at who is hit" body="Pedestrian and cyclist crashes by PBCAT type, lighting and hour, the population behind failure-to-yield countermeasures." />
          <PathStep to="/intersections/peachtree-10th" title="Measure conflicts, not just crashes" body="TTC, PET and DRAC on 10 Hz trajectories, a roadside-LiDAR view, and occluded-track repair evaluated against held-out truth." />
        </ol>
      </section>
    </div>
  );
}

function Figure({ v, u, d }: { v: string; u: string; d: string }) {
  return (
    <div className="figure">
      <div className="figure-v num">{v}</div>
      <div className="figure-u">{u}</div>
      <p className="figure-d muted">{d}</p>
    </div>
  );
}

function PathStep({ to, title, body }: { to: string; title: string; body: string }) {
  return (
    <li>
      <Link to={to} className="path-step">
        <h3>{title}</h3>
        <p className="muted">{body}</p>
        <span className="path-go"><Icon name="arrow" size={16} /></span>
      </Link>
    </li>
  );
}
